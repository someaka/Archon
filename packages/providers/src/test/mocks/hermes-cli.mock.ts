import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

/**
 * Mock event representing a single Hermes CLI JSON line output.
 * These events are serialized as newline-delimited JSON on stdout
 * when the Hermes CLI is invoked with `--json`.
 */
export interface MockHermesEvent {
  type: 'text_delta' | 'tool_start' | 'tool_output' | 'tool_end' | 'error' | 'done';
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  message?: string;
  sessionId?: string;
  usage?: { input: number; output: number };
}

/**
 * Represents a mock Hermes child process and its associated control interface.
 * Provides faux streams and an EventEmitter-based ChildProcess stub that
 * mirrors the behavior of `child_process.spawn` for testing the event bridge.
 */
export interface MockHermesProcess {
  /** Faux stdout stream — JSON lines are written here. */
  stdout: Readable;
  /** Faux stderr stream — diagnostic output is written here. */
  stderr: Readable;
  /** Faux stdin stream — consumed by the bridge but not used for assertions. */
  stdin: Writable;
  /** The faux ChildProcess emitter — use this to emit exit/error events. */
  process: ChildProcess;
  /** Emit a process exit event with the given exit code. */
  emitExit(code: number): void;
  /** Emit a process error event (spawn failure, EPIPE, etc.). */
  emitError(error: Error): void;
  /** Write raw bytes to stdout (for testing malformed JSON handling). */
  writeStdout(data: string): void;
  /** Write raw bytes to stderr (for testing stderr capture). */
  writeStderr(data: string): void;
  /** Flush all queued events immediately, bypassing delays. */
  flush(): Promise<void>;
}

/**
 * Options for creating a mock Hermes process.
 */
export interface CreateMockHermesProcessOptions {
  /** Events to emit as JSON lines on stdout. */
  events?: MockHermesEvent[];
  /**
   * Delay between events in milliseconds.
   * @default 0
   */
  eventDelayMs?: number;
  /** Initial delay before the first event in milliseconds. */
  initialDelayMs?: number;
  /** Exit code to emit after all events. @default 0 */
  exitCode?: number;
  /** Signal to emit instead of an exit code. */
  exitSignal?: NodeJS.Signals | null;
  /** Raw stderr output to emit. */
  stderrData?: string[];
  /** Whether to auto-emit exit after all events. @default true */
  autoEmitExit?: boolean;
}

/**
 * Create a mock Hermes child process for testing the event bridge.
 *
 * The returned mock provides:
 *  - faux `stdout`, `stderr`, and `stdin` streams
 *  - an EventEmitter-based `ChildProcess` stub with `pid`, `kill()`, and
 *    `unref()` methods
 *  - methods to emit exit/error events and write raw data
 *  - automatic JSON-line serialization of the provided events with
 *    configurable delays
 *
 * Usage:
 * ```typescript
 * const mock = createMockHermesProcess({
 *   events: [
 *     { type: 'text_delta', content: 'Hello' },
 *     { type: 'done', sessionId: 'abc', usage: { input: 10, output: 5 } },
 *   ],
 * });
 *
 * const gen = bridgeHermesSession(mock.process);
 * for await (const chunk of gen) { ... }
 * ```
 *
 * Process lifecycle:
 *  - Events are queued and written to stdout with `eventDelayMs` spacing
 *  - After all events, if `autoEmitExit` is true, `emitExit(exitCode)` fires
 *  - Call `flush()` to immediately write all pending events
 *  - Call `emitExit()` or `emitError()` manually for fine-grained control
 *
 * Zombie-process prevention testing:
 *  - `unref()` is a no-op spy
 *  - `kill(signal)` records the signal and emits the corresponding exit
 */
export function createMockHermesProcess(
  options: CreateMockHermesProcessOptions = {}
): MockHermesProcess {
  const {
    events = [],
    eventDelayMs = 0,
    initialDelayMs = 0,
    exitCode = 0,
    exitSignal = null,
    stderrData = [],
    autoEmitExit = true,
  } = options;

  // Track kill calls for assertion purposes.
  const killCalls: NodeJS.Signals[] = [];

  // ── Faux streams ───────────────────────────────────────────────────────

  const stdout = new Readable({
    read() {
      // Backpressure is handled by the consumer (readline).
    },
  });

  const stderr = new Readable({
    read() {
      // Backpressure is handled by the consumer.
    },
  });

  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  // ── Faux ChildProcess (EventEmitter with required fields) ──────────────

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

  fauxProcess.pid = 12345;
  fauxProcess.stdout = stdout;
  fauxProcess.stderr = stderr;
  fauxProcess.stdin = stdin;
  fauxProcess.killed = false;

  fauxProcess.kill = (signal?: NodeJS.Signals | number): boolean => {
    const sig = typeof signal === 'number' ? String(signal) : (signal ?? 'SIGTERM');
    killCalls.push(sig as NodeJS.Signals);
    fauxProcess.killed = true;
    // Emit exit with the corresponding signal if it's a signal name.
    if (typeof signal === 'string') {
      queueMicrotask(() => {
        fauxProcess.emit('exit', null, signal);
      });
    } else if (typeof signal === 'number') {
      queueMicrotask(() => {
        fauxProcess.emit('exit', signal, null);
      });
    } else {
      queueMicrotask(() => {
        fauxProcess.emit('exit', 0, null);
      });
    }
    return true;
  };

  fauxProcess.unref = (): void => {
    // Intentional no-op for tests.
  };

  fauxProcess.ref = (): void => {
    // Intentional no-op for tests.
  };

  // Cast to ChildProcess for the public interface.
  const process = fauxProcess as unknown as ChildProcess;

  // ── Event serialization queue ──────────────────────────────────────────

  const pendingEvents = [...events];
  let flushResolver: (() => void) | undefined;
  let flushPromise: Promise<void> | undefined;

  async function emitEvents(): Promise<void> {
    if (initialDelayMs > 0) {
      await delay(initialDelayMs);
    }

    for (const event of pendingEvents) {
      const line = JSON.stringify(event);
      stdout.push(line + '\n');
      if (eventDelayMs > 0) {
        await delay(eventDelayMs);
      }
    }

    // Emit stderr data after stdout events.
    for (const data of stderrData) {
      stderr.push(data);
    }

    if (autoEmitExit) {
      if (exitSignal) {
        fauxProcess.emit('exit', null, exitSignal);
      } else {
        fauxProcess.emit('exit', exitCode, null);
      }
      // End the streams so the readline interface closes.
      stdout.push(null);
      stderr.push(null);
    }

    flushResolver?.();
  }

  // Schedule event emission on the next microtask so the caller has
  // time to set up readline consumers before data starts flowing.
  flushPromise = Promise.resolve().then(emitEvents);

  // ── Control methods ────────────────────────────────────────────────────

  function emitExit(code: number): void {
    fauxProcess.emit('exit', code, null);
    stdout.push(null);
    stderr.push(null);
  }

  function emitError(error: Error): void {
    fauxProcess.emit('error', error);
  }

  function writeStdout(data: string): void {
    stdout.push(data);
  }

  function writeStderr(data: string): void {
    stderr.push(data);
  }

  async function flush(): Promise<void> {
    // Wait for all pending events to be written.
    await flushPromise;
  }

  return {
    stdout,
    stderr,
    stdin,
    process,
    emitExit,
    emitError,
    writeStdout,
    writeStderr,
    flush,
  };
}

/**
 * Convenience factory for a mock that emits a simple text response and
 * exits cleanly. Useful for the majority of test cases that just need a
 * happy-path response.
 *
 * @param text - The assistant's text response.
 * @param sessionId - Session ID for the done event. @default 'test-session'
 * @param usage - Token usage. @default `{ input: 10, output: 5 }`
 */
export function createSimpleTextMock(
  text: string,
  sessionId = 'test-session',
  usage: { input: number; output: number } = { input: 10, output: 5 }
): MockHermesProcess {
  return createMockHermesProcess({
    events: [
      { type: 'text_delta', content: text },
      { type: 'done', sessionId, usage },
    ],
  });
}

/**
 * Convenience factory for a mock that emits a tool-use sequence:
 * tool_start → tool_output → tool_end, followed by text and done.
 *
 * @param toolName - Name of the tool being invoked.
 * @param toolInput - Input arguments for the tool.
 * @param toolOutput - Output returned by the tool.
 * @param assistantText - Final assistant text after tool use.
 */
export function createToolUseMock(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  assistantText: string
): MockHermesProcess {
  return createMockHermesProcess({
    events: [
      { type: 'tool_start', tool: toolName, input: toolInput },
      { type: 'tool_output', tool: toolName, output: toolOutput },
      { type: 'tool_end', tool: toolName },
      { type: 'text_delta', content: assistantText },
      {
        type: 'done',
        sessionId: 'test-session-tool',
        usage: { input: 50, output: 25 },
      },
    ],
  });
}

/**
 * Convenience factory for a mock that exits with a non-zero code,
 * simulating a CLI error.
 *
 * @param exitCode - Non-zero exit code. @default 1
 * @param stderrLines - Lines to emit on stderr before exit.
 */
export function createErrorMock(
  exitCode = 1,
  stderrLines: string[] = ['Error: model not found']
): MockHermesProcess {
  return createMockHermesProcess({
    events: [],
    exitCode,
    stderrData: stderrLines.map(l => l + '\n'),
    autoEmitExit: true,
  });
}

/**
 * Convenience factory for a mock that emits a Hermes-level error event
 * (distinct from a process exit error). The bridge should emit a result
 * chunk with `isError: true`.
 *
 * @param message - Error message from the Hermes CLI.
 */
export function createHermesErrorEventMock(message: string): MockHermesProcess {
  return createMockHermesProcess({
    events: [{ type: 'error', message }],
    exitCode: 0,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
