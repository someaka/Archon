import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger so provider instantiation is quiet ──────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
}));

// ─── Mock child_process.spawn ──────────────────────────────────────────────

const mockSpawn = mock(
  (_command: string, _args: readonly string[], _options?: Record<string, unknown>) => {
    throw new Error('mockSpawn not implemented for this call');
  }
);

mock.module('child_process', () => ({
  spawn: mockSpawn,
}));

mock.module('./binary-resolver', () => ({
  resolveHermesBinary: mock(async (path?: string) => path),
  fileExists: () => true,
  INSTALL_INSTRUCTIONS: '',
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { HermesProvider } from './provider';
import { HERMES_CAPABILITIES } from './capabilities';
import { resetAcpIdCounter } from './acp-protocol';
import type { ChildProcess } from 'child_process';

// ─── ACP Mock Process (same pattern as event-bridge tests) ────────────────

interface AcpMock {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  process: ChildProcess;
  emitExit(code: number): void;
  emitError(error: Error): void;
}

function createAcpMock(): AcpMock {
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
              result: { sessionId: 'provider-test-session' },
            }) + '\n'
          );
        } else if (req.method === 'session/prompt') {
          // Stream a message chunk then respond
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'provider-test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Hello from Hermes!' },
                },
              },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { stopReason: 'end_turn' },
            }) + '\n'
          );
        }
      } catch {
        // Ignore invalid JSON.
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
  };
}

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

// ─── Test suite ────────────────────────────────────────────────────────────

describe('HermesProvider', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.child.mockClear();
    resetAcpIdCounter(1);
  });

  test('getType returns "hermes"', () => {
    expect(new HermesProvider().getType()).toBe('hermes');
  });

  test('getCapabilities returns HERMES_CAPABILITIES', () => {
    expect(new HermesProvider().getCapabilities()).toEqual(HERMES_CAPABILITIES);
  });

  test('sendQuery spawns `hermes acp` with piped stdio', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const { chunks } = await consume(new HermesProvider().sendQuery('Say hello', '/tmp'));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spawnOpts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('hermes');
    expect(args).toEqual(['acp']);
    expect(spawnOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);

    // Should have yielded assistant chunks from the ACP mock
    const assistantChunks = chunks.filter(
      (c): c is { type: 'assistant'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'assistant'
    );
    expect(assistantChunks.length).toBeGreaterThan(0);
    expect(assistantChunks[0]).toMatchObject({
      type: 'assistant',
      content: 'Hello from Hermes!',
    });

    // Should have a result chunk
    const resultChunks = chunks.filter(
      (c): c is { type: 'result' } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'provider-test-session',
      stopReason: 'end_turn',
    });
  });

  test('sendQuery with system prompt works', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const { chunks } = await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        systemPrompt: 'You are a test assistant.',
      })
    );

    const resultChunks = chunks.filter(
      (c): c is { type: 'result' } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks).toHaveLength(1);
  });

  test('sendQuery with abortSignal passes signal to bridge', async () => {
    const controller = new AbortController();
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const gen = new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
      abortSignal: controller.signal,
    });

    // Start consuming and abort immediately
    controller.abort();
    const { chunks } = await consume(gen);

    // Should get an error result
    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
  });

  test('spawn failure is handled gracefully', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const mockAcp = createAcpMock();
      // Emit error on the process (spawn failure)
      queueMicrotask(() => {
        mockAcp.emitError(new Error('spawn EACCES'));
      });
      return mockAcp.process;
    });

    const { chunks } = await consume(new HermesProvider().sendQuery('Hello', '/tmp'));

    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
  });

  test('resume session is accepted without throwing', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const { error } = await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', 'some-session-id')
    );

    // Session resume is gracefully ignored — no error thrown.
    expect(error).toBeUndefined();
  });

  test('sendQuery with hermesBinaryPath in assistantConfig uses custom binary', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        assistantConfig: {
          hermesBinaryPath: '/custom/path/hermes',
        },
      })
    );

    const [command] = mockSpawn.mock.calls[0] as [string, ...unknown[]];
    expect(command).toBe('/custom/path/hermes');
  });

  test('capabilities reflect v1 Hermes wiring', () => {
    const caps = new HermesProvider().getCapabilities();
    expect(caps.sessionResume).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.skills).toBe(false);
    expect(caps.agents).toBe(false);
    expect(caps.toolRestrictions).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.envInjection).toBe(true);
    expect(caps.costControl).toBe(false);
    expect(caps.effortControl).toBe(false);
    expect(caps.thinkingControl).toBe(false);
    expect(caps.fallbackModel).toBe(false);
    expect(caps.sandbox).toBe(false);
  });
});
