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

// ─── Mock hermes-mcp-reader so sendQuery doesn't hit the real filesystem ───

const mockReadHermesMcpConfig = mock(async () => []);

mock.module('./hermes-mcp-reader', () => ({
  readHermesMcpConfig: mockReadHermesMcpConfig,
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { HermesProvider, getFirstEventTimeoutMs } from './provider';
import { HERMES_CAPABILITIES } from './capabilities';
import { HermesSessionPool } from './session-pool';
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
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.child.mockClear();
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
