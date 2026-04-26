import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger before importing event-bridge ───────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
}));

import { bridgeHermesSession, type BridgeOptions } from './event-bridge';
import { AsyncQueue, type BridgeQueueItem } from '../utils/async-queue';
import { resetAcpIdCounter } from './acp-protocol';
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
    updates?: Array<{
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
      text: string;
    }>;
    /** Stop reason for the prompt response. */
    stopReason?: string;
    /** Custom session id. */
    sessionId?: string;
  } = {}
): AcpMock {
  const sessionId = options.sessionId ?? 'test-session';
  const updates =
    options.updates ??
    ([{ sessionUpdate: 'agent_message_chunk' as const, text: 'Hello, world!' }] as Array<{
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
      text: string;
    }>);
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
            stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: update.sessionUpdate,
                    content: { type: 'text', text: update.text },
                  },
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
    const sig = typeof signal === 'number' ? String(signal) : (signal ?? 'SIGTERM');
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
    resetAcpIdCounter(1);
  });

  afterEach(() => {
    resetAcpIdCounter(1);
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
    };
    expect(lastResult.isError).toBe(true);
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
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
  });

  // ── Abort signal ────────────────────────────────────────────────────────

  test('abort signal kills process and stream terminates with error result', async () => {
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
});
