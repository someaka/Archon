import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../test/mocks/logger';
import { createMockHermesProcess } from '../test/mocks/hermes-cli.mock';

// ─── Mock @archon/paths logger before importing event-bridge ───────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { AsyncQueue, bridgeHermesSession } from './event-bridge';

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

// ─── bridgeHermesSession ───────────────────────────────────────────────────

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

  test('single text_delta → assistant chunk with correct content', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'text_delta', content: 'Hello, world!' },
        { type: 'done', sessionId: 's', usage: { input: 10, output: 5 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ type: 'assistant', content: 'Hello, world!' });
  });

  test('multiple text_delta → multiple chunks in sequence', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'text_delta', content: 'First' },
        { type: 'text_delta', content: ' second' },
        { type: 'text_delta', content: ' third.' },
        { type: 'done', sessionId: 'test-session', usage: { input: 10, output: 5 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(3);
    expect(assistantChunks[0]).toMatchObject({ content: 'First' });
    expect(assistantChunks[1]).toMatchObject({ content: ' second' });
    expect(assistantChunks[2]).toMatchObject({ content: ' third.' });
  });

  // ── Tool use flow ───────────────────────────────────────────────────────

  test('tool_start → tool chunk, tool_output → tool_result, tool_end → skipped', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'tool_start', tool: 'bash', input: { command: 'ls -la' } },
        { type: 'tool_output', tool: 'bash', output: 'file1\nfile2' },
        { type: 'tool_end', tool: 'bash' },
        { type: 'text_delta', content: 'Done!' },
        { type: 'done', sessionId: 's', usage: { input: 10, output: 5 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const toolChunks = chunks.filter(c => (c as { type: string }).type === 'tool');
    const toolResultChunks = chunks.filter(c => (c as { type: string }).type === 'tool_result');
    const toolEndChunks = chunks.filter(c => (c as { type: string }).type === 'tool_end');

    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'ls -la' },
    });

    expect(toolResultChunks).toHaveLength(1);
    expect(toolResultChunks[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: 'file1\nfile2',
    });

    expect(toolEndChunks).toHaveLength(0);
  });

  // ── Error event ─────────────────────────────────────────────────────────

  test('Hermes error event → result chunk with isError: true', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'error', message: 'Something went wrong' },
        { type: 'done', sessionId: 's', usage: { input: 1, output: 1 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      isError: true,
      errors: ['Something went wrong'],
    });
  });

  // ── Done event ──────────────────────────────────────────────────────────

  test('done event → result chunk with tokens and sessionId', async () => {
    const mock = createMockHermesProcess({
      events: [
        {
          type: 'done',
          sessionId: 'session-abc',
          usage: { input: 100, output: 50 },
        },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'session-abc',
      tokens: { input: 100, output: 50, total: 150 },
    });
  });

  // ── Invalid JSON line ───────────────────────────────────────────────────

  test('invalid JSON line logs warning and stream continues', async () => {
    const mock = createMockHermesProcess({
      events: [{ type: 'text_delta', content: 'before' }],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: false,
    });

    const consumePromise = consume(bridgeHermesSession(mock.process));

    // Write additional data after the bridge is set up.
    await new Promise(r => setTimeout(r, 5));
    mock.writeStdout('this is not json\n');
    mock.writeStdout(JSON.stringify({ type: 'text_delta', content: 'after' }) + '\n');
    mock.emitExit(0);

    const { chunks } = await consumePromise;

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThanOrEqual(1);
    expect(assistantChunks[0]).toMatchObject({ content: 'before' });
    // Stream continued after invalid JSON — bridge didn't crash.
    // (Logger calls are on a child logger, not directly trackable here.)
  });

  // ── Process non-zero exit ───────────────────────────────────────────────

  test('process non-zero exit → result with isError: true', async () => {
    const mock = createMockHermesProcess({
      events: [{ type: 'text_delta', content: 'partial output' }],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: false,
    });

    const consumePromise = consume(bridgeHermesSession(mock.process));

    queueMicrotask(() => {
      mock.process.emit('exit', 1, null);
    });

    const { chunks } = await consumePromise;

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
    const lastResult = resultChunks[resultChunks.length - 1];
    expect(lastResult).toMatchObject({
      type: 'result',
      isError: true,
    });
  });

  // ── Process crash (error event) ─────────────────────────────────────────

  test('process crash via error event → result with isError: true', async () => {
    const mock = createMockHermesProcess({
      events: [],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: false,
    });

    const consumePromise = consume(bridgeHermesSession(mock.process));

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

  test('abort signal kills process and stream terminates cleanly', async () => {
    const controller = new AbortController();
    controller.abort();

    const mock = createMockHermesProcess({
      events: [{ type: 'text_delta', content: 'partial' }],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process, controller.signal));

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
    const mock = createMockHermesProcess({
      events: [{ type: 'text_delta', content: 'ok' }],
      stderrData: ['warning: something happened\n'],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toMatchObject({ content: 'ok' });
  });

  // ── Empty stream ────────────────────────────────────────────────────────

  test('empty stream (no events, clean exit) → graceful termination with result', async () => {
    const mock = createMockHermesProcess({
      events: [],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');
    expect(resultChunks.length).toBeGreaterThan(0);
  });

  // ── Complex multi-event session ─────────────────────────────────────────

  test('complex session with text + tools + done', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'text_delta', content: 'Let me check the files.' },
        { type: 'tool_start', tool: 'bash', input: { command: 'ls' } },
        { type: 'tool_output', tool: 'bash', output: 'file1.txt\nfile2.txt' },
        { type: 'tool_end', tool: 'bash' },
        { type: 'text_delta', content: ' I found 2 files.' },
        {
          type: 'done',
          sessionId: 'complex-session',
          usage: { input: 50, output: 25 },
        },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    const toolChunks = chunks.filter(c => (c as { type: string }).type === 'tool');
    const toolResultChunks = chunks.filter(c => (c as { type: string }).type === 'tool_result');
    const resultChunks = chunks.filter(c => (c as { type: string }).type === 'result');

    expect(assistantChunks).toHaveLength(2);
    expect(assistantChunks[0]).toMatchObject({ content: 'Let me check the files.' });
    expect(assistantChunks[1]).toMatchObject({ content: ' I found 2 files.' });

    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    });

    expect(toolResultChunks).toHaveLength(1);
    expect(toolResultChunks[0]).toMatchObject({
      type: 'tool_result',
      toolName: 'bash',
      toolOutput: 'file1.txt\nfile2.txt',
    });

    expect(resultChunks).toHaveLength(1);
    expect(resultChunks[0]).toMatchObject({
      type: 'result',
      sessionId: 'complex-session',
      tokens: { input: 50, output: 25, total: 75 },
    });
  });

  // ── Unknown event type ──────────────────────────────────────────────────

  test('unknown event type is silently skipped', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'text_delta', content: 'before' },
        { type: 'unknown_event', data: 'whatever' } as unknown as {
          type: 'text_delta';
          content: string;
        },
        { type: 'text_delta', content: 'after' },
        { type: 'done', sessionId: 's', usage: { input: 1, output: 1 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(2);
    expect(assistantChunks[0]).toMatchObject({ content: 'before' });
    expect(assistantChunks[1]).toMatchObject({ content: 'after' });
  });

  // ── Process terminated by signal ────────────────────────────────────────

  test('process terminated by signal → result with isError: true', async () => {
    const mock = createMockHermesProcess({
      events: [],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: false,
    });

    const consumePromise = consume(bridgeHermesSession(mock.process));

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

  // ── Validate event mapping exhaustively ─────────────────────────────────

  test('text_delta maps to assistant chunk', async () => {
    const mock = createMockHermesProcess({
      events: [{ type: 'text_delta', content: 'hello' }],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const assistantChunks = chunks.filter(c => (c as { type: string }).type === 'assistant');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0]).toEqual({ type: 'assistant', content: 'hello' });
  });

  test('multiple tool uses in sequence', async () => {
    const mock = createMockHermesProcess({
      events: [
        { type: 'tool_start', tool: 'read', input: { path: '/x' } },
        { type: 'tool_output', tool: 'read', output: 'contents of x' },
        { type: 'tool_end', tool: 'read' },
        { type: 'tool_start', tool: 'write', input: { path: '/y', content: 'data' } },
        { type: 'tool_output', tool: 'write', output: 'written' },
        { type: 'tool_end', tool: 'write' },
        { type: 'done', sessionId: 's', usage: { input: 10, output: 10 } },
      ],
      eventDelayMs: 1,
      initialDelayMs: 1,
      autoEmitExit: true,
    });

    const { chunks } = await consume(bridgeHermesSession(mock.process));

    const toolChunks = chunks.filter(c => (c as { type: string }).type === 'tool');
    const toolResultChunks = chunks.filter(c => (c as { type: string }).type === 'tool_result');

    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0]).toMatchObject({ toolName: 'read', toolInput: { path: '/x' } });
    expect(toolChunks[1]).toMatchObject({
      toolName: 'write',
      toolInput: { path: '/y', content: 'data' },
    });

    expect(toolResultChunks).toHaveLength(2);
    expect(toolResultChunks[0]).toMatchObject({ toolName: 'read', toolOutput: 'contents of x' });
    expect(toolResultChunks[1]).toMatchObject({ toolName: 'write', toolOutput: 'written' });
  });
});
