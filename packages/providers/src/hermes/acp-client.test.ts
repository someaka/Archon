import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger before importing ───────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
}));

// ─── ACP Mock Process (must be defined before mock.module references it) ──

interface AcpMock {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  process: ChildProcess;
  /** Track requests received on stdin for assertion. */
  requests: Array<{ method: string; id: number; params?: Record<string, unknown> }>;
}

function createAcpMock(options?: { sessionId?: string }): AcpMock {
  const sessionId = options?.sessionId ?? 'test-session';
  const requests: AcpMock['requests'] = [];

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
    exitCode: number | null;
  };

  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: () => void): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        requests.push({ method: req.method, id: req.id, params: req.params });

        if (req.method === 'initialize') {
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {},
                agentInfo: { name: 'hermes-test' },
                authMethods: [],
              },
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
          // Stream a message chunk notification
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Hello from Hermes!' },
                },
              },
            }) + '\n'
          );
          // Then the prompt response
          stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { stopReason: 'end_turn', sessionId },
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
  fauxProcess.exitCode = null;

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

  return { stdout, stderr, stdin, process, requests };
}

// ─── Mock child_process.spawn ─────────────────────────────────────────

let currentMock: AcpMock | undefined;

const mockSpawn = mock(
  (
    _command: string,
    _args: readonly string[],
    _options?: Record<string, unknown>
  ): ChildProcess => {
    if (!currentMock) throw new Error('mockSpawn: no currentMock set');
    return currentMock.process;
  }
);

mock.module('child_process', () => ({
  spawn: mockSpawn,
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { HermesAcpClient } from './acp-client';
import type { ChildProcess } from 'child_process';

// ─── Helpers ──────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────

describe('HermesAcpClient', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    currentMock = undefined;
  });

  // ── Constructor & getters ─────────────────────────────────────────

  test('constructor spawns child process with correct args', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('hermes', ['acp'], {
      cwd: '/tmp',
      env: undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    client.dispose();
  });

  test('constructor uses custom args when provided', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({
      binary: 'hermes',
      args: ['acp', '--verbose'],
      cwd: '/tmp',
    });

    expect(mockSpawn).toHaveBeenCalledWith('hermes', ['acp', '--verbose'], expect.any(Object));
    client.dispose();
  });

  test('childProcess getter returns the underlying process', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.childProcess).toBeDefined();
    expect(client.childProcess).toBe(currentMock.process);
    client.dispose();
  });

  test('sessionId getter returns undefined before init', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.sessionId).toBeUndefined();
    client.dispose();
  });

  // ── isAlive() ─────────────────────────────────────────────────────

  test('isAlive() returns true for a running process', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.isAlive()).toBe(true);
    client.dispose();
  });

  test('isAlive() returns false after process is killed', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    client.childProcess.kill('SIGKILL');
    expect(client.isAlive()).toBe(false);
  });

  test('isAlive() returns false after dispose()', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.isAlive()).toBe(true);
    client.dispose();
    expect(client.isAlive()).toBe(false);
  });

  // ── init() ────────────────────────────────────────────────────────

  test('init() completes ACP handshake and yields chunks', async () => {
    currentMock = createAcpMock({ sessionId: 'init-session' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    const { chunks } = await consume(client.init('Hello'));

    expect(chunks.length).toBeGreaterThan(0);
    // Should have at least one assistant chunk and one result chunk
    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ type: 'assistant', content: 'Hello from Hermes!' });
    expect(resultChunks).toHaveLength(1);
    client.dispose();
  });

  test('init() captures sessionId from result chunk', async () => {
    currentMock = createAcpMock({ sessionId: 'captured-session' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.sessionId).toBeUndefined();
    await consume(client.init('Hello'));
    expect(client.sessionId).toBe('captured-session');
    client.dispose();
  });

  test('init() sends initialize + session/new + session/prompt requests', async () => {
    currentMock = createAcpMock({ sessionId: 'req-session' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    await consume(client.init('Hello'));

    const methods = currentMock.requests.map(r => r.method);
    expect(methods).toEqual(['initialize', 'session/new', 'session/prompt']);
    client.dispose();
  });

  test('init() throws if client is disposed', async () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    client.dispose();
    // consume() catches the error into the error field
    const { error } = await consume(client.init('Hello'));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/disposed/);
  });

  // ── prompt() ──────────────────────────────────────────────────────

  test('prompt() sends prompt on existing session', async () => {
    currentMock = createAcpMock({ sessionId: 'prompt-session' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    // Initialize first
    await consume(client.init('Hello'));
    expect(client.sessionId).toBe('prompt-session');

    // Reset request tracking for the prompt call
    currentMock.requests.length = 0;

    // Send follow-up prompt
    const { chunks } = await consume(client.prompt('Follow up'));

    expect(chunks.length).toBeGreaterThan(0);
    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);

    // Should have sent only session/prompt (skipInit mode)
    const methods = currentMock.requests.map(r => r.method);
    expect(methods).toEqual(['session/prompt']);
    client.dispose();
  });

  test('prompt() throws if init() has not been called', async () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    // consume() catches the error into the error field
    const { error } = await consume(client.prompt('Hello'));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/No active session/);
    client.dispose();
  });

  test('prompt() throws if client is disposed', async () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    await consume(client.init('Hello'));
    client.dispose();
    // consume() catches the error into the error field
    const { error } = await consume(client.prompt('Hello'));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/disposed/);
  });

  // ── Multiple prompt() calls ───────────────────────────────────────

  test('multiple prompt() calls work on same session', async () => {
    currentMock = createAcpMock({ sessionId: 'multi-session' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    await consume(client.init('First'));

    // Second prompt
    const { chunks: chunks2 } = await consume(client.prompt('Second'));
    expect(chunks2.length).toBeGreaterThan(0);
    expect(chunks2.some(c => (c as { type: string }).type === 'assistant')).toBe(true);

    // Third prompt
    const { chunks: chunks3 } = await consume(client.prompt('Third'));
    expect(chunks3.length).toBeGreaterThan(0);
    expect(chunks3.some(c => (c as { type: string }).type === 'assistant')).toBe(true);

    // sessionId should be preserved throughout
    expect(client.sessionId).toBe('multi-session');
    client.dispose();
  });

  // ── dispose() ─────────────────────────────────────────────────────

  test('dispose() kills child process', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    expect(client.isAlive()).toBe(true);
    client.dispose();
    expect(client.isAlive()).toBe(false);
  });

  test('dispose() is idempotent (calling twice does not throw)', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    client.dispose();
    expect(() => client.dispose()).not.toThrow();
    expect(() => client.dispose()).not.toThrow();
  });

  test('dispose() can be called without init()', () => {
    currentMock = createAcpMock();
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    // Never called init() — dispose should still work
    expect(() => client.dispose()).not.toThrow();
    expect(client.isAlive()).toBe(false);
  });

  test('dispose() can be called during active prompt', async () => {
    currentMock = createAcpMock({ sessionId: 'dispose-mid' });
    const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });

    await consume(client.init('Hello'));

    // Start a prompt but don't await — then dispose
    const promptGen = client.prompt('Mid-prompt');
    // Consume first chunk to start the bridge
    await promptGen.next();

    // Dispose while bridge is active — should not throw
    expect(() => client.dispose()).not.toThrow();
    expect(client.isAlive()).toBe(false);
  });
});
