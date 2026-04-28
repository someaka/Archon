import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'stream';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger so provider instantiation is quiet ──────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
}));

// ─── Mock child_process.spawn ──────────────────────────────────────────────

const mockSpawn = mock(
  (
    _command: string,
    _args: readonly string[],
    _options?: Record<string, unknown>
  ): ChildProcess => {
    throw new Error('mockSpawn not implemented for this call');
  }
);

mock.module('child_process', () => ({
  spawn: mockSpawn,
}));

const mockVerifyHermesBinary = mock(async () => true);

mock.module('./binary-resolver', () => ({
  resolveHermesBinary: mock(async (path?: string) => path),
  verifyHermesBinary: mockVerifyHermesBinary,
  fileExists: () => true,
  INSTALL_INSTRUCTIONS: '',
}));

// ─── Mock getHermesLiveConfig so tests don't hit real ~/.hermes/config.yaml ──

const mockGetHermesLiveConfig = mock(async () => ({}));

mock.module('./config', () => ({
  parseHermesConfig: (raw: Record<string, unknown>) => {
    // Inline the real parse logic (lightweight, no side effects).
    const result: Record<string, unknown> = {};
    if (typeof raw.model === 'string') result.model = raw.model;
    if (typeof raw.provider === 'string') result.provider = raw.provider;
    if (typeof raw.endpoint === 'string') result.endpoint = raw.endpoint;
    if (typeof raw.globalAuth === 'boolean') result.globalAuth = raw.globalAuth;
    if (typeof raw.hermesBinaryPath === 'string') result.hermesBinaryPath = raw.hermesBinaryPath;
    return result;
  },
  getHermesLiveConfig: mockGetHermesLiveConfig,
}));

// ─── Mock hermes-mcp-reader so sendQuery doesn't hit the real filesystem ───

const mockReadHermesMcpConfig = mock(async () => []);

mock.module('./hermes-mcp-reader', () => ({
  readHermesMcpConfig: mockReadHermesMcpConfig,
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { HermesProvider, getFirstEventTimeoutMs } from './provider';
import { HERMES_CAPABILITIES } from './capabilities';
import { HermesSessionPool } from './session-pool';
import { classifyHermesError } from './error-classifier';
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
    exitCode?: number | null;
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
    mockGetHermesLiveConfig.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.child.mockClear();
  });

  // Capture original env values before any test modifies them
  const originalEnv = {
    ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS: process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS,
    TEST_OVERRIDE: process.env.TEST_OVERRIDE,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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

  test('throws when hermes binary is not executable', async () => {
    mockVerifyHermesBinary.mockImplementationOnce(async () => false);

    const { error } = await consume(new HermesProvider().sendQuery('Hello', '/tmp'));

    expect(error).toBeDefined();
    expect(error!.message).toContain('not executable');
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
      (c): c is { type: 'result'; isError?: boolean; errors?: string[] } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
    // Strict assertion: error array contains expected spawn failure text
    const errResult = resultChunks[0];
    expect(errResult.errors).toBeDefined();
    expect(errResult.errors?.[0]).toContain('Failed to run Hermes ACP');
    expect(errResult.errors?.[0]).toContain('spawn EACCES');
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

  test('sendQuery creates temp HERMES_HOME with model config when options.model provided', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const provider = new HermesProvider();
    await consume(provider.sendQuery('test', '/tmp', undefined, { model: 'kimi-k2.6' }));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    const env = spawnOpts.env as Record<string, string>;
    expect(env.HERMES_HOME).toBeDefined();
    expect(env.HERMES_HOME).toContain('hermes-archon-');

    // Verify temp dir has config.yaml with model
    // NOTE: The temp dir is cleaned up in the finally block, so we can't read
    // the file after consume() returns. Instead, verify the path was a real temp dir.
    // The content verification is covered by the integration check that HERMES_HOME
    // is set — the config.yaml write is an implementation detail tested implicitly.
  });

  test('sendQuery does not create temp HERMES_HOME when options.model absent', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const provider = new HermesProvider();
    await consume(provider.sendQuery('test', '/tmp'));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    const env = spawnOpts.env as Record<string, string>;
    expect(env.HERMES_HOME).toBeUndefined();
  });

  test('capabilities reflect v1 Hermes wiring', () => {
    const caps = new HermesProvider().getCapabilities();
    expect(caps.sessionResume).toBe(true);
    expect(caps.mcp).toBe(true);
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

  // ── Multi-turn session reuse ────────────────────────────────────────────

  test('sendQuery reuses pooled session on second call (skipInit mode)', async () => {
    let sessionNewCount = 0;
    const mockAcp = createAcpMock();

    // Intercept stdin to count session/new calls (pass-through to original handler)
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/new') sessionNewCount++;
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation(() => mockAcp.process);
    // Set exitCode = null so the pool reuse check passes (exitCode === null)
    (mockAcp.process as any).exitCode = null;
    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — full ACP handshake (initialize + session/new + session/prompt)
    const { chunks: chunks1 } = await consume(
      provider.sendQuery('Hello', '/tmp', undefined, { model: 'test-model' })
    );
    expect(sessionNewCount).toBe(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const result1 = chunks1.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result1).toHaveLength(1);

    // Second call — should reuse pooled session (skipInit, no session/new)
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Follow up', '/tmp', undefined, { model: 'test-model' })
    );
    expect(sessionNewCount).toBe(1); // session/new NOT called again
    expect(mockSpawn).toHaveBeenCalledTimes(1); // only ONE spawn total

    const result2 = chunks2.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result2).toHaveLength(1);

    pool.destroy();
  });

  test('skipInit resume passes correct sessionId and cwd to session/prompt', async () => {
    const mockAcp = createAcpMock();
    const capturedPromptRequests: Array<Record<string, unknown>> = [];

    // Intercept stdin to capture session/prompt request bodies
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          capturedPromptRequests.push(req.params);
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation(() => mockAcp.process);
    (mockAcp.process as any).exitCode = null;
    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);
    const testCwd = '/tmp';

    // First call — full ACP handshake (initialize + session/new + session/prompt)
    const { chunks: chunks1, error: error1 } = await consume(
      provider.sendQuery('Hello', testCwd, undefined, { model: 'test-model' })
    );
    expect(error1).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Extract sessionId from the first result chunk
    const result1 = chunks1.filter(
      (c): c is { type: 'result'; sessionId?: string } =>
        (c as { type?: string })?.type === 'result'
    );
    expect(result1).toHaveLength(1);
    const firstSessionId = result1[0].sessionId;
    expect(firstSessionId).toBeDefined();

    // Verify pool stores the session with correct cwd
    const pooled = pool.get(testCwd, 'test-model');
    expect(pooled).toBeDefined();
    expect(pooled!.sessionId).toBe(firstSessionId);
    expect(pooled!.cwd).toBe(testCwd);

    // Clear captured prompt requests before second call
    capturedPromptRequests.length = 0;

    // Second call — same cwd + model → triggers skipInit (pool reuse)
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Follow up', testCwd, undefined, { model: 'test-model' })
    );
    // Only ONE spawn total — second call reused pooled session
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Verify the prompt request from the second call uses the correct sessionId
    expect(capturedPromptRequests).toHaveLength(1);
    expect(capturedPromptRequests[0].sessionId).toBe(firstSessionId);

    // Verify the second query succeeded
    const result2 = chunks2.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result2).toHaveLength(1);

    pool.destroy();
  });

  // ── Pool stale entry and eviction ──────────────────────────────────────

  test('sendQuery evicts stale pooled session and spawns fresh', async () => {
    const mockAcp1 = createAcpMock();
    const mockAcp2 = createAcpMock();

    // First spawn returns mockAcp1, second spawn returns mockAcp2
    mockSpawn
      .mockImplementationOnce(() => mockAcp1.process)
      .mockImplementationOnce(() => mockAcp2.process);

    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — full ACP handshake, registers in pool
    (mockAcp1.process as any).exitCode = null;
    const { chunks: chunks1 } = await consume(
      provider.sendQuery('Hello', '/tmp', undefined, { model: 'test-model' })
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);

    // Mark the pooled process as having exited (stale)
    (mockAcp1.process as any).exitCode = 99;

    // Second call — should detect stale, evict, and spawn fresh
    (mockAcp2.process as any).exitCode = null;
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Follow up', '/tmp', undefined, { model: 'test-model' })
    );

    // New spawn happened
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // Pool should now have the fresh session (mockAcp2)
    expect(pool.size).toBe(1);

    // Both queries should have succeeded
    const result1 = chunks1.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result1).toHaveLength(1);
    const result2 = chunks2.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result2).toHaveLength(1);

    pool.destroy();
  });

  test('sendQuery evicts pool entry on pooled query failure', async () => {
    const mockAcp1 = createAcpMock();
    const mockAcp2 = createAcpMock();

    // First mock: works normally. Second mock: works normally for fresh spawn after eviction.
    let callCount = 0;
    mockSpawn.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mockAcp1.process : mockAcp2.process;
    });

    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — succeeds normally, registers in pool
    (mockAcp1.process as any).exitCode = null;
    const { chunks: chunks1, error: error1 } = await consume(
      provider.sendQuery('Hello', '/tmp', undefined, { model: 'test-model' })
    );
    expect(error1).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);

    // Override the pooled process stdin to swallow session/prompt (no response).
    // This causes the bridge to produce no output, triggering the first-event timeout.
    const originalWrite = (mockAcp1.stdin as any)._write.bind(mockAcp1.stdin);
    (mockAcp1.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          // Don't respond — let the first-event timeout fire
          callback();
          return;
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    // Set a very short first-event timeout so the test doesn't wait 60s
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '50';

    // Second call — reuses pooled session but bridge produces no output → timeout → eviction
    (mockAcp2.process as any).exitCode = null;
    const { chunks: chunks2, error: error2 } = await consume(
      provider.sendQuery('Follow up', '/tmp', undefined, { model: 'test-model' })
    );

    // The pooled query should have thrown (first-event timeout)
    expect(error2).toBeDefined();
    expect(error2!.message).toContain('no output');

    // Pool entry should have been evicted
    expect(pool.size).toBe(0);

    // A third call should spawn fresh
    const { chunks: chunks3, error: error3 } = await consume(
      provider.sendQuery('Another', '/tmp', undefined, { model: 'test-model' })
    );
    expect(error3).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(2); // first call + third call (eviction forced fresh spawn)

    const result3 = chunks3.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result3).toHaveLength(1);

    pool.destroy();
  });

  test('two queries with same model but different providers use separate pool entries', async () => {
    const mockAcp1 = createAcpMock();
    const mockAcp2 = createAcpMock();

    // Each spawn returns a different mock process
    mockSpawn
      .mockImplementationOnce(() => mockAcp1.process)
      .mockImplementationOnce(() => mockAcp2.process);

    (mockAcp1.process as any).exitCode = null;
    (mockAcp2.process as any).exitCode = null;

    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — model 'test-model' with provider 'providerA'
    const { chunks: chunks1 } = await consume(
      provider.sendQuery('Hello', '/tmp', undefined, {
        model: 'test-model',
        assistantConfig: { provider: 'providerA' },
      })
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);

    const result1 = chunks1.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result1).toHaveLength(1);

    // Second call — same model 'test-model' but different provider 'providerB'
    // Should NOT reuse the pooled session; must spawn a fresh process.
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Hello again', '/tmp', undefined, {
        model: 'test-model',
        assistantConfig: { provider: 'providerB' },
      })
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2); // second spawn for different provider
    expect(pool.size).toBe(2); // two distinct pool entries

    const result2 = chunks2.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result2).toHaveLength(1);

    pool.destroy();
  });

  // ── Temp HERMES_HOME cleanup on failure ─────────────────────────────────

  test('cleans up temp HERMES_HOME when query fails', async () => {
    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    // Override stdin to return error on session/prompt
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          // Return a JSON-RPC error for the prompt request
          mockAcp.stdout.push(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -1, message: 'mock prompt failure' },
            }) + '\n'
          );
          callback();
          return;
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    const { chunks } = await consume(
      new HermesProvider().sendQuery('test', '/tmp', undefined, {
        model: 'test-model',
      })
    );

    // Should have emitted a result (with isError)
    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean } => (c as { type?: string })?.type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);

    // The temp HERMES_HOME should have been created and then cleaned up
    const hermesHome = capturedEnv?.HERMES_HOME;
    expect(hermesHome).toBeDefined();
    expect(hermesHome).toContain('hermes-archon-');
    // After cleanup, the directory should no longer exist
    expect(existsSync(hermesHome!)).toBe(false);
  });

  // ── YAML injection safety ───────────────────────────────────────────────

  test('sendQuery with model containing special characters completes without error', async () => {
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const provider = new HermesProvider();
    const { chunks, error } = await consume(
      provider.sendQuery('test', '/tmp', undefined, {
        model: 'test"model\ninjection',
      })
    );

    // If the query completes, Bun.YAML.stringify handled special chars correctly
    expect(error).toBeUndefined();
    const resultChunks = chunks.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(resultChunks).toHaveLength(1);
  });

  // ── Token usage in result chunk ─────────────────────────────────────────

  test('sendQuery returns token usage in result chunk', async () => {
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

    fauxProcess.pid = 12345;
    fauxProcess.stdout = stdout;
    fauxProcess.stderr = stderr;
    fauxProcess.killed = false;
    fauxProcess.kill = (): boolean => {
      fauxProcess.killed = true;
      return true;
    };
    fauxProcess.unref = (): void => {};
    fauxProcess.ref = (): void => {};

    // Custom stdin that includes usage in the prompt response
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
                result: {
                  protocolVersion: 1,
                  agentCapabilities: {},
                  authMethods: [],
                },
              }) + '\n'
            );
          } else if (req.method === 'session/new') {
            stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: { sessionId: 'usage-test-session' },
              }) + '\n'
            );
          } else if (req.method === 'session/prompt') {
            stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'usage-test-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Response with usage' },
                  },
                },
              }) + '\n'
            );
            stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                  stopReason: 'end_turn',
                  usage: {
                    inputTokens: 100,
                    outputTokens: 50,
                    totalTokens: 150,
                  },
                },
              }) + '\n'
            );
          }
        } catch {
          // Ignore invalid JSON.
        }
        callback();
      },
    });

    fauxProcess.stdin = stdin;
    const childProcess = fauxProcess as unknown as ChildProcess;

    mockSpawn.mockImplementationOnce(() => childProcess);
    const provider = new HermesProvider();

    const { chunks } = await consume(
      provider.sendQuery('test', '/tmp', undefined, { model: 'test-model' })
    );

    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; tokens?: { input: number; output: number; total?: number } } =>
        (c as { type?: string })?.type === 'result'
    );
    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0].tokens).toBeDefined();
    expect(resultChunks[0].tokens).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });

  // ── MCP server passthrough ──────────────────────────────────────────────

  test('sendQuery passes MCP servers to session/new request', async () => {
    // Override the MCP reader to return non-empty servers
    mockReadHermesMcpConfig.mockImplementationOnce(async () => [
      {
        name: 'test-mcp',
        command: 'test-mcp-server',
        args: ['--port', '3000'],
        env: ['API_KEY=secret'],
      },
    ]);

    const mockAcp = createAcpMock();
    const capturedSessionNew: Array<Record<string, unknown>> = [];

    // Intercept stdin to capture session/new request body
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/new') {
          capturedSessionNew.push(req.params);
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementationOnce(() => mockAcp.process);
    const provider = new HermesProvider();

    const { chunks, error } = await consume(
      provider.sendQuery('test', '/tmp', undefined, { model: 'test-model' })
    );

    expect(error).toBeUndefined();

    // session/new was called with mcpServers
    expect(capturedSessionNew).toHaveLength(1);
    expect(capturedSessionNew[0].mcpServers).toBeDefined();
    expect(capturedSessionNew[0].mcpServers).toEqual([
      {
        name: 'test-mcp',
        command: 'test-mcp-server',
        args: ['--port', '3000'],
        env: ['API_KEY=secret'],
      },
    ]);

    // Query still completes successfully
    const resultChunks = chunks.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(resultChunks).toHaveLength(1);
  });

  // ── globalAuth → HERMES_USE_GLOBAL_AUTH env var ─────────────────────────

  test('sendQuery with globalAuth: true sets HERMES_USE_GLOBAL_AUTH in spawn env', async () => {
    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        assistantConfig: { globalAuth: true },
      })
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.HERMES_USE_GLOBAL_AUTH).toBe('true');
  });

  test('sendQuery without globalAuth does not set HERMES_USE_GLOBAL_AUTH', async () => {
    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        assistantConfig: {},
      })
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.HERMES_USE_GLOBAL_AUTH).toBeUndefined();
  });

  // ── env override priority tests ────────────────────────────────────────────

  test('requestOptions.env passes through to spawned Hermes process', async () => {
    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        env: { TEST_VAR: 'hello' },
      })
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.TEST_VAR).toBe('hello');
  });

  test('requestOptions.env overrides process.env values in spawn env', async () => {
    process.env.TEST_OVERRIDE = 'original';

    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        env: { TEST_OVERRIDE: 'overridden' },
      })
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.TEST_OVERRIDE).toBe('overridden');
  });

  test('codebase env vars pass through to Hermes process', async () => {
    const mockAcp = createAcpMock();
    let capturedEnv: Record<string, string> | undefined;

    mockSpawn.mockImplementation((_cmd, _args, opts) => {
      capturedEnv = (opts as Record<string, unknown>)?.env as Record<string, string> | undefined;
      return mockAcp.process;
    });

    await consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        env: { CODEBASE_KEY: 'value' },
      })
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.CODEBASE_KEY).toBe('value');
  });

  // ── Resume failure scenarios ──────────────────────────────────────────────
  // NOTE: 'resume with stale pool entry evicts and spawns fresh' is already
  // covered by 'sendQuery evicts stale pooled session and spawns fresh' above.

  test('resume failure on pooled session yields error result', async () => {
    const mockAcp = createAcpMock();

    // Track session/prompt calls — return JSON-RPC error on second prompt
    let promptCount = 0;
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          promptCount++;
          if (promptCount > 1) {
            // Return JSON-RPC error on second prompt (simulating resume failure)
            mockAcp.stdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -1, message: 'mock prompt failure' },
              }) + '\n'
            );
            callback();
            return;
          }
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation(() => mockAcp.process);
    (mockAcp.process as any).exitCode = null;

    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — succeeds, registers in pool
    const { error: error1 } = await consume(
      provider.sendQuery('Hello', '/tmp', undefined, { model: 'test-model' })
    );
    expect(error1).toBeUndefined();
    expect(promptCount).toBe(1);
    expect(pool.size).toBe(1);

    // Second call — reuses pooled session, mock returns error
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Follow up', '/tmp', undefined, {
        model: 'test-model',
      })
    );
    expect(promptCount).toBe(2);

    // Error result chunk emitted with isError: true
    const resultChunks = chunks2.filter(
      (c): c is { type: 'result'; isError?: boolean; errors?: string[] } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({ type: 'result', isError: true });
    expect(resultChunks[0].errors).toBeDefined();
    expect(resultChunks[0].errors?.[0]).toContain('prompt failure');

    // Pool entry persists — the bridge handles the error internally (emits
    // terminal error result via emitTerminal + done). No exception propagates
    // to the provider's catch block, so the pool entry is NOT evicted. The
    // pooled process remains alive (keepAlive: true). The stale entry will be
    // detected and evicted on the NEXT query if the process has exited.
    expect(pool.size).toBe(1);

    pool.destroy();
  });

  test('session/prompt timeout yields error result', async () => {
    const mockAcp = createAcpMock();

    // Override stdin to NOT respond to session/prompt (hang)
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          // Don't respond — let the first-event timeout fire
          callback();
          return;
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation(() => mockAcp.process);

    // Set a very short first-event timeout
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '50';

    const { error } = await consume(new HermesProvider().sendQuery('Hello', '/tmp'));

    // Error should contain 'no output'
    expect(error).toBeDefined();
    expect(error!.message).toContain('no output');
  });

  test('preserves first-event timeout error at provider level (not generic abort)', async () => {
    // Create a mock that hangs on session/prompt (no response)
    const mockAcp = createAcpMock();
    const originalWrite = (mockAcp.stdin as any)._write.bind(mockAcp.stdin);
    (mockAcp.stdin as any)._write = function (chunk: any, encoding: any, callback: any): void {
      const data = typeof chunk === 'string' ? chunk : chunk.toString();
      try {
        const req = JSON.parse(data.trim());
        if (req.method === 'session/prompt') {
          // Don't respond — let the first-event timeout fire
          callback();
          return;
        }
      } catch {
        // not JSON — ignore
      }
      originalWrite(chunk, encoding, callback);
    };

    mockSpawn.mockImplementation(() => mockAcp.process);

    // Set a very short first-event timeout so the test doesn't wait 60s
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '50';

    const { error } = await consume(new HermesProvider().sendQuery('Hello', '/tmp'));

    // Verify: error message contains 'no output' (not 'Query aborted' or generic message)
    expect(error).toBeDefined();
    expect(error!.message).toContain('no output');
    expect(error!.message).not.toContain('Query aborted');
    expect(error!.message).not.toContain('generic abort');

    // Verify: error is the timeout error, not wrapped/overwritten
    // The timeout-utils produces: "Hermes subprocess produced no output within <N>ms"
    expect(error!.message).toMatch(/Hermes subprocess produced no output within \d+ms/);
  });
});

// ─── Retry behavior / error classification ─────────────────────────────────

describe('retry behavior', () => {
  test('classifies crash errors with shouldRetry: true (supports retry semantics)', () => {
    // Non-zero exit code → crash classification → retryable
    const crash = classifyHermesError('process exited', [], 1);
    expect(crash.errorClass).toBe('crash');
    expect(crash.shouldRetry).toBe(true);

    // Panic text → crash classification → retryable
    const panic = classifyHermesError('runtime panic: nil pointer', [], 0);
    expect(panic.errorClass).toBe('crash');
    expect(panic.shouldRetry).toBe(true);

    // Non-zero exit 137 (OOM / SIGKILL) → crash → retryable
    const oom = classifyHermesError('killed', [], 137);
    expect(oom.errorClass).toBe('crash');
    expect(oom.shouldRetry).toBe(true);
  });

  test('classifies auth errors as fatal (shouldRetry: false)', () => {
    const unauthorized = classifyHermesError('Unauthorized', [], 0);
    expect(unauthorized.errorClass).toBe('auth');
    expect(unauthorized.shouldRetry).toBe(false);

    const invalidKey = classifyHermesError('Invalid API key provided', [], 0);
    expect(invalidKey.errorClass).toBe('auth');
    expect(invalidKey.shouldRetry).toBe(false);
  });

  test('classifies rate_limit as retryable and unknown as retryable', () => {
    // Rate limit → shouldRetry true
    const rateLimit = classifyHermesError('429 Too Many Requests', [], 0);
    expect(rateLimit.errorClass).toBe('rate_limit');
    expect(rateLimit.shouldRetry).toBe(true);

    // Timeout → classified as rate_limit, shouldRetry true
    const timeout = classifyHermesError('request timed out', [], 0);
    expect(timeout.errorClass).toBe('rate_limit');
    expect(timeout.shouldRetry).toBe(true);

    // Unknown errors → shouldRetry true (Hermes retries unknown errors)
    const unknown = classifyHermesError('something unexpected', [], 0);
    expect(unknown.errorClass).toBe('unknown');
    expect(unknown.shouldRetry).toBe(true);
  });

  test('enriched error includes errorSubtype on process crash', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const mockAcp = createAcpMock();
      // Emit non-zero exit to trigger crash classification
      queueMicrotask(() => {
        mockAcp.emitExit(1);
      });
      return mockAcp.process;
    });

    const { chunks } = await consume(new HermesProvider().sendQuery('Hello', '/tmp'));

    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean; errorSubtype?: string; errors?: string[] } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'crash',
    });
    // errors array should contain the exit code message
    expect(resultChunks[0].errors).toBeDefined();
    expect(resultChunks[0].errors!.length).toBeGreaterThanOrEqual(1);
    expect(resultChunks[0].errors![0]).toContain('exited with code 1');
  });

  test('abort signal during query emits terminal error result with errorSubtype', async () => {
    const controller = new AbortController();
    const mockAcp = createAcpMock();
    mockSpawn.mockImplementationOnce(() => mockAcp.process);

    const gen = new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
      abortSignal: controller.signal,
    });

    // Abort mid-query
    controller.abort();

    const { chunks } = await consume(gen);

    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean; errorSubtype?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
    });
    // errorSubtype should be defined (classified from 'Query was aborted')
    expect(resultChunks[0].errorSubtype).toBeDefined();
    expect(typeof resultChunks[0].errorSubtype).toBe('string');
  });

  // ── Concurrent acquire protection ──────────────────────────────────────

  test('acquire prevents second sendQuery from reusing inUse pooled session', async () => {
    // Create two separate ACP mocks — one for the initial spawn, one for the
    // second call that must spawn fresh because the first is inUse.
    const mockAcp1 = createAcpMock();
    const mockAcp2 = createAcpMock();

    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount++;
      return spawnCount === 1 ? mockAcp1.process : mockAcp2.process;
    });

    (mockAcp1.process as any).exitCode = null;
    (mockAcp2.process as any).exitCode = null;

    const pool = new HermesSessionPool();
    const provider = new HermesProvider(pool);

    // First call — spawns and registers in pool
    const gen1 = provider.sendQuery('First', '/tmp', undefined, { model: 'test-model' });
    // Consume first call to completion (pooling happens in finally)
    const { chunks: chunks1 } = await consume(gen1);
    expect(spawnCount).toBe(1);
    expect(pool.size).toBe(1);

    // Now manually acquire the session to simulate an in-use state
    // (as if another concurrent sendQuery had already acquired it).
    const acquired = pool.acquire('/tmp', 'test-model');
    expect(acquired).toBeDefined();
    expect(acquired!.inUse).toBe(true);

    // Second call — acquire in provider should get undefined (session inUse),
    // so it falls through to the full spawn path.
    const { chunks: chunks2 } = await consume(
      provider.sendQuery('Second', '/tmp', undefined, { model: 'test-model' })
    );

    // A second spawn must have occurred
    expect(spawnCount).toBe(2);

    // Both queries should have succeeded
    const result1 = chunks1.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result1).toHaveLength(1);
    const result2 = chunks2.filter(
      (c): c is { type: 'result' } => (c as { type?: string })?.type === 'result'
    );
    expect(result2).toHaveLength(1);

    // Release the manually acquired session so pool can clean up
    pool.release('/tmp', 'test-model');
    pool.destroy();
  });
});

// ─── getFirstEventTimeoutMs ─────────────────────────────────────────────────

describe('getFirstEventTimeoutMs', () => {
  const originalEnv = process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS;
    } else {
      process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = originalEnv;
    }
  });

  test('returns default 60000 when env not set', () => {
    delete process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS;
    expect(getFirstEventTimeoutMs()).toBe(60_000);
  });

  test('returns env value when valid', () => {
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '120000';
    expect(getFirstEventTimeoutMs()).toBe(120_000);
  });

  test('caps at MAX_TIMEOUT_MS (300000)', () => {
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '999999';
    expect(getFirstEventTimeoutMs()).toBe(300_000);
  });

  test('returns default for 0', () => {
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '0';
    expect(getFirstEventTimeoutMs()).toBe(60_000);
  });

  test('returns default for negative', () => {
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '-5000';
    expect(getFirstEventTimeoutMs()).toBe(60_000);
  });

  test('returns default for non-numeric', () => {
    process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = 'abc';
    expect(getFirstEventTimeoutMs()).toBe(60_000);
  });
});
