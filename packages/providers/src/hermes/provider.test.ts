import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../test/mocks/logger';
import { createMockHermesProcess } from '../test/mocks/hermes-cli.mock';

// ─── Mock @archon/paths logger so provider instantiation is quiet ──────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
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

  test('sendQuery basic call spawns process with correct args', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(new HermesProvider().sendQuery('Say hello', '/tmp'));
    // Give bridge time to set up readline before writing
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(JSON.stringify({ type: 'text_delta', content: 'Hello!' }) + '\n');
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 5, output: 3 } }) + '\n'
    );
    mockProc.emitExit(0);

    const { chunks } = await consumePromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('hermes');
    expect(args).toContain('chat');
    expect(args).toContain('--json');
    expect(args).toContain('--prompt');
    expect(args).toContain('Say hello');
    expect(args).toContain('--cwd');
    expect(args).toContain('/tmp');

    // Should have yielded assistant chunks
    const assistantChunks = chunks.filter(
      (c): c is { type: 'assistant'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'assistant'
    );
    expect(assistantChunks.length).toBeGreaterThan(0);
  });

  test('sendQuery with model option includes --model in args', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        model: 'hermes:ollama/llama3.1',
      })
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    await consumePromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('llama3.1');
  });

  test('sendQuery with systemPrompt includes --system in args', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        systemPrompt: 'You are a test assistant.',
      })
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    await consumePromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--system');
    const systemIdx = args.indexOf('--system');
    expect(args[systemIdx + 1]).toBe('You are a test assistant.');
  });

  test('sendQuery with assistantConfig parses and uses config', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        assistantConfig: {
          model: 'qwen2.5-coder:32b',
          provider: 'ollama',
        },
      })
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    await consumePromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('qwen2.5-coder:32b');
    expect(args).toContain('--provider');
    expect(args).toContain('ollama');
  });

  test('sendQuery with abortSignal passes signal to bridge', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const controller = new AbortController();

    const gen = new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
      abortSignal: controller.signal,
    });

    // Start consuming
    const consumePromise = consume(gen);

    // Abort after a microtask
    queueMicrotask(() => controller.abort());

    const { chunks } = await consumePromise;

    // Should still get some chunks (the abort result)
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('sendQuery error path yields result with isError: true', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(new HermesProvider().sendQuery('Hello', '/tmp'));
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(JSON.stringify({ type: 'error', message: 'Model not available' }) + '\n');
    mockProc.emitExit(0);

    const { chunks } = await consumePromise;

    const resultChunks = chunks.filter(
      (c): c is { type: 'result'; isError?: boolean } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunks.length).toBeGreaterThan(0);
    const errorResult = resultChunks[0] as { type: string; isError?: boolean; errors?: string[] };
    expect(errorResult.isError).toBe(true);
    expect(errorResult.errors).toEqual(['Model not available']);
  });

  test('sendQuery with env includes --env flags', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        env: { API_KEY: 'secret', DEBUG: '1' },
      })
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    await consumePromise;

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--env');
  });

  test('spawn failure is handled gracefully', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
      // Emit error on the process (spawn failure)
      queueMicrotask(() => {
        mockProc.emitError(new Error('spawn EACCES'));
      });
      return mockProc.process;
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
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', 'some-session-id')
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    const { error } = await consumePromise;

    // Session resume is gracefully ignored — no error thrown.
    expect(error).toBeUndefined();
  });

  test('sendQuery with hermesBinaryPath in assistantConfig uses custom binary', async () => {
    const mockProc = createMockHermesProcess({ events: [], autoEmitExit: false });
    mockSpawn.mockImplementationOnce(() => mockProc.process);

    const consumePromise = consume(
      new HermesProvider().sendQuery('Hello', '/tmp', undefined, {
        assistantConfig: {
          hermesBinaryPath: '/custom/path/hermes',
        },
      })
    );
    await new Promise(r => setTimeout(r, 5));
    mockProc.writeStdout(
      JSON.stringify({ type: 'done', sessionId: 's', usage: { input: 1, output: 1 } }) + '\n'
    );
    mockProc.emitExit(0);
    await consumePromise;

    const [command] = mockSpawn.mock.calls[0];
    expect(command).toBe('/custom/path/hermes');
  });

  test('capabilities reflect v1 Hermes wiring', () => {
    const caps = new HermesProvider().getCapabilities();
    expect(caps.sessionResume).toBe(false);
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.skills).toBe(true);
    expect(caps.agents).toBe(false);
    expect(caps.toolRestrictions).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.envInjection).toBe(true);
    expect(caps.costControl).toBe(false);
    expect(caps.effortControl).toBe(false);
    expect(caps.thinkingControl).toBe(false);
    expect(caps.fallbackModel).toBe(true);
    expect(caps.sandbox).toBe(false);
  });
});
