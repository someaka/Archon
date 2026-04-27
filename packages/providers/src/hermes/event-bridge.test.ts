import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger before importing event-bridge ───────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
}));

import { bridgeHermesSession, redactSecrets, type BridgeOptions } from './event-bridge';
import { AsyncQueue, type BridgeQueueItem } from '../utils/async-queue';
import type { ChildProcess } from 'child_process';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function consume(generator: AsyncGenerator<unknown>): Promise<{
  chunks: unknown[];
  error?: Error;
}> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

function makeBridgeOptions(overrides?: Partial<BridgeOptions>): BridgeOptions {
  return { prompt: 'Say hello', cwd: '/tmp', ...overrides };
}

// ─── ACP Mock Process (responds to stdin with ACP JSON-RPC) ────────────────

interface AcpMock {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  process: ChildProcess;
  emitExit(code: number): void;
  emitError(error: Error): void;
  /** Push raw data to stderr (for testing stderr capture). */
  pushStderr(data: string): void;
}

/**
 * Create a mock Hermes ACP process that responds to stdin requests with
 * ACP JSON-RPC responses on stdout.
 *
 * Response sequence (triggered by stdin writes):
 *   1. `initialize` → id-matched response
 *   2. `session/new` → id-matched response with {sessionId: 'test-session'}
 *   3. `session/prompt` → streams session/update notifications, then id-matched response
 *
 * This mimics the real `hermes acp` protocol flow:
 *   Client sends init → Server responds
 *   Client sends session/new → Server responds with sessionId
 *   Client sends session/prompt → Server streams updates, then responds with stopReason
 */
function createAcpMock(
  options: {
    /** Custom updates to stream before the prompt response. */
    updates?: Array<
      | {
          sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
          text: string;
        }
      | {
          sessionUpdate: 'tool_call' | 'tool_call_update';
          toolCallId: string;
          kind: string;
          title: string;
          status: string;
          content?: Array<{ type: string; text: string }>;
          rawInput?: Record<string, unknown>;
          rawOutput?: Record<string, unknown>;
        }
    >;
    /** Stop reason for the prompt response. */
    stopReason?: string;
    /** Custom session id. */
    sessionId?: string;
  } = {}
): AcpMock {
  const sessionId = options.sessionId ?? 'test-session';
  const updates =
    options.updates ??
    ([{ sessionUpdate: 'agent_message_chunk' as const, text: 'Hello, world!' }] as Array<
      | { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'; text: string }
      | {
          sessionUpdate: 'tool_call' | 'tool_call_update';
          toolCallId: string;
          kind: string;
          title: string;
          status: string;
          content?: Array<{ type: string; text: string }>;
          rawInput?: Record<string, unknown>;
          rawOutput?: Record<string, unknown>;
        }
    >);
  const stopReason = options.stopReason ?? 'end_turn';

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const fauxProcess = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill(signal?: NodeJS.Signals | number): boolean;
    unref(): void;
    ref(): void;
    killed: boolean;
  };

  // ── Stdin: respond to ACP requests ────────────────────────────────────
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());

        if (req.method === 'initialize') {
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
            }) + '\n'
          );
        } else if (req.method === 'session/new') {
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { sessionId },
            }) + '\n'
          );
        } else if (req.method === 'session/prompt') {
          // Stream session/update notifications first
          for (const update of updates) {
            // Tool events have a different shape than message/thought chunks
            let updateObj: Record<string, unknown>;
            if (
              update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update'
            ) {
              updateObj = {
                sessionUpdate: update.sessionUpdate,
                toolCallId: update.toolCallId,
                kind: update.kind,
                title: update.title,
                status: update.status,
                ...(update.content !== undefined && { content: update.content }),
                ...(update.rawInput !== undefined && { rawInput: update.rawInput }),
                ...(update.rawOutput !== undefined && { rawOutput: update.rawOutput }),
              };
            } else {
              const msgUpdate = update as {
                sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
                text: string;
              };
              updateObj = {
                sessionUpdate: msgUpdate.sessionUpdate,
                content: { type: 'text', text: msgUpdate.text },
              };
            }
            stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: updateObj,
                },
              }) + '\n'
            );
          }
          // Then the prompt response
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { stopReason },
            }) + '\n'
          );
        }
      } catch {
        // Ignore invalid JSON on stdin.
      }
      callback();
    },
  });

  fauxProcess.pid = 12345;
  fauxProcess.stdout = stdout;
  fauxProcess.stderr = stderr;
  fauxProcess.stdin = stdin;
  fauxProcess.killed = false;

  fauxProcess.kill = (signal?: NodeJS.Signals | number): boolean => {
    fauxProcess.killed = true;
    if (typeof signal === 'string') {
      queueMicrotask(() => fauxProcess.emit('exit', null, signal));
    } else if (typeof signal === 'number') {
      queueMicrotask(() => fauxProcess.emit('exit', signal, null));
    } else {
      queueMicrotask(() => fauxProcess.emit('exit', 0, null));
    }
    return true;
  };

  fauxProcess.unref = (): void => {
    // no-op
  };

  fauxProcess.ref = (): void => {
    // no-op
  };

  const process = fauxProcess as unknown as ChildProcess;

  return {
    stdout,
    stderr,
    stdin,
    process,
    emitExit(code: number): void {
      fauxProcess.emit('exit', code, null);
      stdout.push(null);
      stderr.push(null);
    },
    emitError(error: Error): void {
      fauxProcess.emit('error', error);
    },
    pushStderr(data: string): void {
      stderr.push(data);
    },
  };
}

// ─── AsyncQueue ────────────────────────────────────────────────────────────

describe('AsyncQueue', () => {
  test('buffers pushes before consumer starts', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    const received: number[] = [];
    const iter = q[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) {
      const r = await iter.next();
      if (!r.done) received.push(r.value);
    }
    expect(received).toEqual([1, 2, 3]);
  });

  test('resolves pending waiter when push arrives later', async () => {
    const q = new AsyncQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    queueMicrotask(() => q.push('hello'));
    const r = await pending;
    expect(r.done).toBe(false);
    if (!r.done) expect(r.value).toBe('hello');
  });

  test('preserves FIFO order across push and waiter', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const p1 = iter.next();
    q.push(10);
    q.push(20);
    const r1 = await p1;
    const r2 = await iter.next();
    if (!r1.done) expect(r1.value).toBe(10);
    if (!r2.done) expect(r2.value).toBe(20);
  });

  test('second iterator call throws (single-consumer invariant)', () => {
    const q = new AsyncQueue<number>();
    q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow(/single-consumer/);
  });

  test('close() terminates pending waiter so consumer exits loop', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    queueMicrotask(() => q.close());
    const result = await pending;
    expect(result.done).toBe(true);
  });

  test('close() drains buffered items before terminating', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const received: number[] = [];
    for await (const n of q) received.push(n);
    expect(received).toEqual([1, 2]);
  });

  test('push after close is a no-op', async () => {
    const q = new AsyncQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    q.close();
    q.push(42);
    const r = await iter.next();
    expect(r.done).toBe(true);
  });

  test('close() is idempotent', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.close()).not.toThrow();
  });
});

// ─── bridgeHermesSession (ACP) ─────────────────────────────────────────────

describe('bridgeHermesSession', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.trace.mockClear();
    mockLogger.child.mockClear();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  test('single agent_message_chunk → assistant chunk with correct content', async () => {
    const mock = createAcpMock({
      updates: [{ sessionUpdate: 'agent_message_chunk', text: 'Hello, world!' }],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ type: 'assistant', content: 'Hello, world!' });
  });

  test('multiple agent_message_chunks → multiple assistant chunks in sequence', async () => {
    const mock = createAcpMock({
      updates: [
        { sessionUpdate: 'agent_message_chunk', text: 'First' },
        { sessionUpdate: 'agent_message_chunk', text: ' second' },
        { sessionUpdate: 'agent_message_chunk', text: ' third.' },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(3);
    expect(assistantChunks[0]).toMatchObject({ content: 'First' });
    expect(assistantChunks[1]).toMatchObject({ content: ' second' });
    expect(assistantChunks[2]).toMatchObject({ content: ' third.' });
  });

  test('agent_thought_chunk → thinking chunk', async () => {
    const mock = createAcpMock({
      updates: [{ sessionUpdate: 'agent_thought_chunk', text: 'Let me think...' }],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const thinkingChunks = chunks.filter(c => (c as { type: string }).type === 'thinking');
    expect(thinkingChunks).toHaveLength(1);
    expect(thinkingChunks[0]).toMatchObject({ type: 'thinking', content: 'Let me think...' });
  });

  test('mixed message + thought chunks stream correctly', async () => {
    const mock = createAcpMock({
      updates: [
        { sessionUpdate: 'agent_thought_chunk', text: 'Hmm...' },
        { sessionUpdate: 'agent_message_chunk', text: 'Here is the answer.' },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const thinking = chunks.filter(c => (c as { type: string }).type === 'thinking');
    const assistant = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(thinking).toHaveLength(1);
    expect(assistant).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ content: 'Hmm...' });
    expect(assistant[0]).toMatchObject({ content: 'Here is the answer.' });
  });

  // ── Tool events ────────────────────────────────────────────────────────

  test('tool_call_update with status running emits tool chunk', async () => {
    const mock = createAcpMock({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          kind: 'execute',
          title: 'bash',
          status: 'running',
          rawInput: { command: 'ls -la' },
        },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const toolChunks = chunks.filter(c => (c as { type: string }).type === 'tool');
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'ls -la' },
      toolCallId: 'tc-1',
    });
  });

  test('tool_call_update with status completed emits tool_result chunk', async () => {
    const mock = createAcpMock({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          kind: 'execute',
          title: 'bash',
          status: 'completed',
          rawOutput: { stdout: 'file.txt', exitCode: 0 },
        },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const toolResultChunks = chunks.filter(c => (c as { type: string }).type === 'tool_result');
    expect(toolResultChunks).toHaveLength(1);
    expect(toolResultChunks[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: '{"stdout":"file.txt","exitCode":0}',
      toolCallId: 'tc-2',
    });
  });

  test('tool_call_update with status failed emits tool_result with error', async () => {
    const mock = createAcpMock({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-3',
          kind: 'execute',
          title: 'bash',
          status: 'failed',
          rawOutput: { error: 'command not found', exitCode: 127 },
        },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const toolResultChunks = chunks.filter(c => (c as { type: string }).type === 'tool_result');
    expect(toolResultChunks).toHaveLength(1);
    expect(toolResultChunks[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: '{"error":"command not found","exitCode":127}',
      toolCallId: 'tc-3',
    });
  });

  test('tool_call with status pending is ignored (no chunk emitted)', async () => {
    const mock = createAcpMock({
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-4',
          kind: 'execute',
          title: 'bash',
          status: 'pending',
        },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const toolChunks = chunks.filter(
      c => (c as { type: string }).type === 'tool' || (c as { type: string }).type === 'tool_result'
    );
    expect(toolChunks).toHaveLength(0);
    // Should still have result chunk
    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
  });

  test('tool_call_update with unknown kind still emits tool chunk', async () => {
    const mock = createAcpMock({
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-5',
          kind: 'unknown_special',
          title: 'custom-tool',
          status: 'running',
          rawInput: { query: 'test' },
        },
      ],
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const toolChunks = chunks.filter(c => (c as { type: string }).type === 'tool');
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'custom-tool',
      toolInput: { query: 'test' },
      toolCallId: 'tc-5',
    });
  });

  // ── Result chunk ────────────────────────────────────────────────────────

  test('result chunk carries sessionId and stopReason', async () => {
    const mock = createAcpMock();

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'test-session',
      stopReason: 'end_turn',
    });
  });

  // ── Empty stream ────────────────────────────────────────────────────────

  test('no notifications → still emits result chunk', async () => {
    const mock = createAcpMock({ updates: [] });

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
  });

  // ── Process non-zero exit ───────────────────────────────────────────────

  test('process non-zero exit → result with isError: true', async () => {
    // Create a mock that doesn't respond to stdin (simulates dead process)
    const { process } = createAcpMock({ updates: [] });

    const consumePromise = consume(bridgeHermesSession(process, makeBridgeOptions()));

    // Emit exit before the bridge gets a response
    queueMicrotask(() => {
      process.emit('exit', 1, null);
    });

    const { chunks } = await consumePromise;

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    const lastResult = resultChunks[resultChunks.length - 1] as {
      type: string;
      isError?: boolean;
      errors?: string[];
    };
    expect(lastResult.isError).toBe(true);
    expect(lastResult.errors).toBeDefined();
    expect(lastResult.errors?.[0]).toContain('Hermes ACP exited with code 1');
  });

  // ── Process crash (error event) ─────────────────────────────────────────

  test('process crash via error event → result with isError: true', async () => {
    const mock = createAcpMock({ updates: [] });

    const consumePromise = consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    queueMicrotask(() => {
      mock.emitError(new Error('spawn failure'));
    });

    const { chunks } = await consumePromise;

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    const firstResult = resultChunks[0] as {
      type: string;
      isError?: boolean;
      errors?: string[];
    };
    expect(firstResult).toMatchObject({
      type: 'result',
      isError: true,
    });
    expect(firstResult.errors).toBeDefined();
    expect(firstResult.errors?.[0]).toContain('Failed to run Hermes ACP');
    expect(firstResult.errors?.[0]).toContain('spawn failure');
  });

  // ── Abort signal ────────────────────────────────────────────────────────

  test('pre-aborted signal immediately emits terminal error result', async () => {
    const controller = new AbortController();
    controller.abort();

    const mock = createAcpMock({ updates: [] });

    const { chunks } = await consume(
      bridgeHermesSession(mock.process, makeBridgeOptions(), controller.signal)
    );

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errors: ['Query was aborted'],
    });
  });

  test('abort during session sends session/cancel notification on stdin', async () => {
    const controller = new AbortController();

    // Track stdin writes to verify session/cancel is sent
    const stdinWrites: string[] = [];

    const mock = createAcpMock({ updates: [] });
    const originalWrite = mock.stdin.write.bind(mock.stdin);
    mock.stdin.write = (chunk: any, ...args: any[]) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...args);
    };

    const gen = bridgeHermesSession(mock.process, makeBridgeOptions(), controller.signal);
    const iter = gen[Symbol.asyncIterator]();

    // Let initialize + session/new complete, so sessionId is set
    await iter.next();

    // Abort the signal
    controller.abort();

    // Drain remaining chunks
    await consume(gen).catch(() => {});

    // Verify session/cancel was written to stdin
    const cancelWrites = stdinWrites.filter(w => w.includes('session/cancel'));
    expect(cancelWrites.length).toBeGreaterThan(0);
    const cancelMsg = JSON.parse(cancelWrites[0]);
    expect(cancelMsg.method).toBe('session/cancel');
    expect(cancelMsg.params.sessionId).toBe('test-session');
  });

  test('abort signal sends SIGTERM to child process', async () => {
    const controller = new AbortController();

    const mock = createAcpMock({ updates: [] });
    const killSpy = mock.process.kill as (signal?: NodeJS.Signals | number) => boolean;
    const killCalls: string[] = [];
    mock.process.kill = ((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal as string);
      return killSpy(signal);
    }) as any;

    const gen = bridgeHermesSession(mock.process, makeBridgeOptions(), controller.signal);
    const iter = gen[Symbol.asyncIterator]();

    // Let session/new complete
    await iter.next();

    // Abort
    controller.abort();

    await consume(gen).catch(() => {});

    expect(killCalls).toContain('SIGTERM');
  });

  test('abort during session emits terminal result with isError: true', async () => {
    const controller = new AbortController();

    // Create a mock that does NOT respond to session/prompt so the session stays open
    const mock = createAcpMock({ updates: [] });
    const originalWrite = mock.stdin.write.bind(mock.stdin);
    let promptSent = false;
    mock.stdin.write = (chunk: any, ...args: any[]) => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          promptSent = true;
          // Don't respond — keep session open
          const callback = args[args.length - 1];
          if (typeof callback === 'function') callback();
          return true;
        }
      } catch {
        /* ignore */
      }
      return originalWrite(chunk, ...args);
    };

    const gen = bridgeHermesSession(mock.process, makeBridgeOptions(), controller.signal);
    const iter = gen[Symbol.asyncIterator]();

    // This will hang waiting for session/prompt response — abort during the wait
    const pending = iter.next();

    // Give the bridge time to send initialize + session/new and then session/prompt
    await new Promise(r => setTimeout(r, 50));
    expect(promptSent).toBe(true);

    // Abort the signal while session/prompt is pending
    controller.abort();

    // Now the pending next should resolve with the abort result
    const { value } = await pending;
    expect(value).toBeDefined();
    expect((value as any).type).toBe('result');
    expect((value as any).isError).toBe(true);
    expect((value as any).errors).toContain('Query was aborted');

    // Consume the rest to prevent leaks
    await consume(gen).catch(() => {});
  });

  test('abort signal closes the queue so consumer exits cleanly', async () => {
    const controller = new AbortController();

    const mock = createAcpMock({ updates: [] });
    const gen = bridgeHermesSession(mock.process, makeBridgeOptions(), controller.signal);

    // Abort immediately
    controller.abort();

    // consume() should complete without hanging (queue is closed)
    const { chunks } = await consume(gen);

    // Should have at least a terminal result
    expect(chunks.length).toBeGreaterThan(0);
    const lastChunk = chunks[chunks.length - 1] as { type: string };
    expect(lastChunk.type).toBe('result');
  });

  // ── Stderr output ───────────────────────────────────────────────────────

  test('stderr output is captured and logged', async () => {
    const mock = createAcpMock({
      updates: [{ sessionUpdate: 'agent_message_chunk', text: 'ok' }],
    });
    // Push stderr before bridge consumes
    mock.pushStderr('warning: something happened\n');

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ content: 'ok' });
  });

  // ── Process terminated by signal ────────────────────────────────────────

  test('process terminated by signal → result with isError: true', async () => {
    const mock = createAcpMock({ updates: [] });

    const consumePromise = consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    queueMicrotask(() => {
      mock.process.kill?.('SIGTERM');
    });

    const { chunks } = await consumePromise;

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
  });

  // ── System prompt is passed through ─────────────────────────────────────

  test('systemPrompt is sent as separate ContentBlock', async () => {
    const mock = createAcpMock();

    const { chunks } = await consume(
      bridgeHermesSession(mock.process, makeBridgeOptions({ systemPrompt: 'You are a tester.' }))
    );

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
  });

  // ── Unrecognized update type ─────────────────────────────────────────────

  test('unrecognized session/update type does not crash bridge', async () => {
    const mock = createAcpMock({
      updates: [{ sessionUpdate: 'agent_message_chunk', text: 'ok' }],
    });

    // Intercept stdin write to inject an extra notification with an unknown type
    const originalWrite = mock.stdin.write.bind(mock.stdin);
    mock.stdin.write = (chunk: any, ...args: any[]) => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          // Push an unrecognized update notification before the normal flow
          mock.stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'unknown_type',
                  content: { type: 'text', text: 'ignored' },
                },
              },
            }) + '\n'
          );
        }
      } catch {
        /* ignore */
      }
      return originalWrite(chunk, ...args);
    };

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    // Bridge should not crash and still emit the normal assistant chunk + result
    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ content: 'ok' });

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]).toMatchObject({ type: 'result', stopReason: 'end_turn' });

    // Should have logged a warning about the invalid session update (isSessionUpdateParams returns false for unknown type)
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ── JSON-RPC error response ─────────────────────────────────────────────

  test('JSON-RPC error response propagates as error result chunk', async () => {
    const mock = createAcpMock({ updates: [] });

    // Override stdin.write to return a JSON-RPC error for session/prompt
    const originalWrite = mock.stdin.write.bind(mock.stdin);
    mock.stdin.write = (chunk: any, ...args: any[]) => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          mock.stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32600, message: 'Invalid Request' },
            }) + '\n'
          );
          const callback = args[args.length - 1];
          if (typeof callback === 'function') callback();
          return true;
        }
      } catch {
        /* ignore */
      }
      return originalWrite(chunk, ...args);
    };

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
    const result = resultChunks[0] as { type: string; isError?: boolean; errors?: string[] };
    expect(result.isError).toBe(true);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain('-32600');
    expect(result.errors![0]).toContain('Invalid Request');
  });

  // ── Input validation ────────────────────────────────────────────────────

  test('throws for non-absolute cwd', async () => {
    const mock = createAcpMock();

    const { error } = await consume(
      bridgeHermesSession(mock.process, makeBridgeOptions({ cwd: 'relative/path' }))
    );

    expect(error).toBeDefined();
    expect(error!.message).toContain('absolute cwd');
    expect(error!.message).toContain('relative/path');
  });

  test('sends session/close on normal completion', async () => {
    const stdinWrites: string[] = [];

    const mock = createAcpMock();
    const originalWrite = mock.stdin.write.bind(mock.stdin);
    mock.stdin.write = (chunk: any, ...args: any[]) => {
      stdinWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return originalWrite(chunk, ...args);
    };

    const { chunks } = await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));

    // Verify normal completion still works
    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]).toMatchObject({ type: 'result', sessionId: 'test-session' });

    // Verify session/close was written to stdin
    const closeWrites = stdinWrites.filter(w => w.includes('session/close'));
    expect(closeWrites.length).toBeGreaterThan(0);
    const closeMsg = JSON.parse(closeWrites[0]);
    expect(closeMsg.method).toBe('session/close');
    expect(closeMsg.params.sessionId).toBe('test-session');
    // Should be a notification (no id field)
    expect(closeMsg.id).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  test('redacts key=value pattern', () => {
    expect(redactSecrets('key=sk-abc123')).toBe('key=[REDACTED]');
  });

  test('redacts api_key=value pattern', () => {
    expect(redactSecrets('api_key=secretvalue')).toBe('api_key=[REDACTED]');
  });

  test('redacts api_key in JSON', () => {
    expect(redactSecrets('{"api_key":"sk-abc123"}')).toBe('{"api_key":"[REDACTED]"}');
  });

  test('redacts OPENAI_API_KEY=value', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-abc123')).toBe('OPENAI_API_KEY=[REDACTED]');
  });

  test('redacts Authorization header', () => {
    expect(redactSecrets('Authorization: Bearer token123')).toBe(
      'Authorization: [REDACTED] token123'
    );
  });

  test('redacts ANTHROPIC_API_KEY', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-xxx')).toBe('ANTHROPIC_API_KEY=[REDACTED]');
  });

  test('redacts AWS_SECRET_ACCESS_KEY', () => {
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=abc123xyz')).toBe(
      'AWS_SECRET_ACCESS_KEY=[REDACTED]'
    );
  });

  test('redacts GITHUB_TOKEN', () => {
    expect(redactSecrets('GITHUB_TOKEN=ghp_xxxxx')).toBe('GITHUB_TOKEN=[REDACTED]');
  });

  test('preserves non-secret content', () => {
    expect(redactSecrets('normal log message')).toBe('normal log message');
  });

  test('redacts multiple secrets in one line', () => {
    const input = 'key=abc token=xyz normal';
    const result = redactSecrets(input);
    expect(result).toContain('key=[REDACTED]');
    expect(result).toContain('token=[REDACTED]');
    expect(result).toContain('normal');
  });
});
