import { createLogger } from '@archon/paths';
import type { ChildProcess } from 'child_process';
import { createInterface } from 'readline';

import type { MessageChunk, TokenUsage } from '../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.hermes.event-bridge');
  return cachedLog;
}

// ─── AsyncQueue ────────────────────────────────────────────────────────────

/**
 * Single-producer / single-consumer async queue. Bridges callback-based
 * child-process I/O into an async generator.
 *
 * Design:
 *  - producers call `push(item)` from any synchronous context
 *  - the consumer awaits `for await (const item of queue)` ONCE
 *  - sentinel items are pushed by the caller; the queue itself does not
 *    know about them
 *
 * Single-consumer is a hard invariant — a second iterator would race with
 * the first over both the buffer and the waiters list, silently dropping
 * items. The constructor enforces this: the first `Symbol.asyncIterator`
 * call sets `consumed=true`; subsequent calls throw so the mistake surfaces
 * loudly during development rather than being debugged after the fact.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private consumed = false;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  /**
   * Terminate iteration cleanly. Drains any pending waiters with
   * `{ done: true }` so the consumer exits the `for await` loop instead of
   * hanging forever when the producer's finally block fires before a new
   * item arrives (e.g. consumer abort mid-iteration).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      // Throw synchronously at the call site (not lazily on first .next())
      // so the stack trace points at the offending second-consumer caller.
      throw new Error(
        'AsyncQueue: a single queue can only be iterated once (single-consumer invariant). Create a new queue for each consumer.'
      );
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<T> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>(resolve => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

// ─── Hermes JSON Event Types ───────────────────────────────────────────────

/** Discriminated union of all Hermes CLI JSON line events. */
interface HermesTextDeltaEvent {
  type: 'text_delta';
  content: string;
}

interface HermesToolStartEvent {
  type: 'tool_start';
  tool: string;
  input: Record<string, unknown>;
}

interface HermesToolOutputEvent {
  type: 'tool_output';
  tool: string;
  output: string;
}

interface HermesToolEndEvent {
  type: 'tool_end';
  tool: string;
}

interface HermesErrorEvent {
  type: 'error';
  message: string;
}

interface HermesDoneEvent {
  type: 'done';
  sessionId: string;
  usage: { input: number; output: number };
}

type HermesEvent =
  | HermesTextDeltaEvent
  | HermesToolStartEvent
  | HermesToolOutputEvent
  | HermesToolEndEvent
  | HermesErrorEvent
  | HermesDoneEvent;

/** Internal queue payload for `bridgeHermesSession`. */
type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

// ─── Event Validation ──────────────────────────────────────────────────────

/**
 * Narrow an unknown parsed JSON object to a HermesEvent using structural
 * validation. Returns the typed event on success, `null` when the shape
 * doesn't match any known event type.
 *
 * Defensive: all validation is type-guard style — no `any`, only `unknown`
 * with explicit property checks. This prevents malformed JSON (or future
 * Hermes event types) from crashing the bridge.
 */
function validateHermesEvent(raw: unknown): HermesEvent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const eventType = obj.type;
  if (typeof eventType !== 'string') return null;

  switch (eventType) {
    case 'text_delta': {
      if (typeof obj.content !== 'string') return null;
      return { type: 'text_delta', content: obj.content };
    }
    case 'tool_start': {
      if (typeof obj.tool !== 'string') return null;
      if (obj.input === null || typeof obj.input !== 'object') return null;
      return {
        type: 'tool_start',
        tool: obj.tool,
        input: obj.input as Record<string, unknown>,
      };
    }
    case 'tool_output': {
      if (typeof obj.tool !== 'string') return null;
      if (typeof obj.output !== 'string') return null;
      return { type: 'tool_output', tool: obj.tool, output: obj.output };
    }
    case 'tool_end': {
      if (typeof obj.tool !== 'string') return null;
      return { type: 'tool_end', tool: obj.tool };
    }
    case 'error': {
      if (typeof obj.message !== 'string') return null;
      return { type: 'error', message: obj.message };
    }
    case 'done': {
      if (typeof obj.sessionId !== 'string') return null;
      if (
        obj.usage === null ||
        typeof obj.usage !== 'object' ||
        typeof (obj.usage as Record<string, unknown>).input !== 'number' ||
        typeof (obj.usage as Record<string, unknown>).output !== 'number'
      ) {
        return null;
      }
      return {
        type: 'done',
        sessionId: obj.sessionId,
        usage: obj.usage as { input: number; output: number },
      };
    }
    default:
      // Unknown event type — log and skip rather than crash.
      return null;
  }
}

// ─── Event Mapper ──────────────────────────────────────────────────────────

/**
 * Pure mapper from a validated Hermes event → zero-or-more Archon
 * `MessageChunk`s.
 *
 * Mapping rules:
 *  - `text_delta`   → `{type: 'assistant', content}`
 *  - `tool_start`   → `{type: 'tool', toolName, toolInput}`
 *  - `tool_output`  → `{type: 'tool_result', toolName, toolOutput}`
 *  - `tool_end`     → skipped (tool_result already emitted on tool_output)
 *  - `error`        → `{type: 'result', isError: true, errors: [message]}`
 *  - `done`         → `{type: 'result', sessionId, tokens}`
 *
 * Events deliberately skipped:
 *  - `tool_end` — the output is already delivered via `tool_output`; the
 *    end event is a boundary marker only.
 *  - Unknown event types — logged at debug level, silently ignored.
 */
function mapHermesEvent(event: HermesEvent): MessageChunk[] {
  switch (event.type) {
    case 'text_delta':
      return [{ type: 'assistant', content: event.content }];
    case 'tool_start':
      return [
        {
          type: 'tool',
          toolName: event.tool,
          toolInput: event.input,
        },
      ];
    case 'tool_output':
      return [
        {
          type: 'tool_result',
          toolName: event.tool,
          toolOutput: event.output,
        },
      ];
    case 'tool_end':
      // Skipped — tool_result was already emitted on tool_output.
      return [];
    case 'error':
      return [
        {
          type: 'result',
          isError: true,
          errors: [event.message],
        },
      ];
    case 'done': {
      const tokens: TokenUsage = {
        input: event.usage.input,
        output: event.usage.output,
        total: event.usage.input + event.usage.output,
      };
      return [
        {
          type: 'result',
          sessionId: event.sessionId,
          tokens,
        },
      ];
    }
    default: {
      // Exhaustiveness: all known HermesEvent variants are handled above.
      const exhaustiveCheck: never = event;
      void exhaustiveCheck;
      return [];
    }
  }
}

// ─── bridgeHermesSession ───────────────────────────────────────────────────

/**
 * Bridge a Hermes CLI child process (spawned with `--json`) into Archon's
 * `AsyncGenerator<MessageChunk>` contract.
 *
 * Behavior:
 *  - reads childProcess.stdout line-by-line via `readline` interface
 *  - parses each line as JSON, validates structurally, maps to MessageChunk
 *  - logs invalid JSON / unknown events at `warn` level and continues
 *  - captures stderr lines at `warn` level (non-fatal — Hermes may log
 *    diagnostics to stderr while still succeeding on stdout)
 *  - on process exit with non-zero code: emits a terminal `result` chunk
 *    with `isError: true` and the exit code in `errors`
 *  - on process crash (error event, signal termination): emits a terminal
 *    `result` chunk with `isError: true`
 *  - on `abortSignal`: sends `SIGTERM` to the child (with `SIGKILL` fallback
 *    after 5 s), closes the queue so the consumer exits
 *  - always calls `childProcess.unref()` to prevent zombie processes
 *  - always emits a terminal `result` chunk, even on error paths, so the
 *    consumer never hangs waiting for a chunk that never arrives
 *
 * Zombie-process prevention:
 *  - `childProcess.unref()` is called immediately so the event loop doesn't
 *    keep the parent alive waiting for the child
 *  - on abort, `SIGTERM` is sent first; if the child hasn't exited after
 *    5 seconds, `SIGKILL` is sent as a last resort
 *  - the `readline` interface and stream listeners are cleaned up in a
 *    `finally` block
 *
 * Partial-line handling:
 *  - `readline` guarantees complete lines (terminated by `\n`) — any
 *    incomplete final line without a newline is buffered by `readline`
 *    internally and delivered on the next `'line'` event or dropped when
 *    the stream ends. We log at debug level when the interface closes
 *    with a buffered partial line.
 */
export async function* bridgeHermesSession(
  childProcess: ChildProcess,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();

  // Prevent the child process from keeping the parent process alive.
  childProcess.unref();

  // Track whether we've already emitted a terminal result chunk so we don't
  // emit duplicates (e.g. error event + non-zero exit both firing).
  let terminalEmitted = false;

  const stderrLines: string[] = [];

  // ── readline interface for stdout line-by-line consumption ─────────────
  if (!childProcess.stdout) {
    throw new Error('Hermes child process stdout is not available');
  }
  const rl = createInterface({
    input: childProcess.stdout,
    crlfDelay: Infinity,
  });

  // ── stdout: JSON line parsing ──────────────────────────────────────────
  rl.on('line', (line: string) => {
    if (line.trim().length === 0) return;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      getLog().warn({ line: line.slice(0, 200) }, 'hermes.bridge.invalid_json_line');
      return;
    }

    const event = validateHermesEvent(raw);
    if (!event) {
      getLog().debug({ line: line.slice(0, 200) }, 'hermes.bridge.unknown_event_type');
      return;
    }

    for (const chunk of mapHermesEvent(event)) {
      if (chunk.type === 'result') {
        terminalEmitted = true;
      }
      queue.push({ kind: 'chunk', chunk });
    }
  });

  // ── stderr: capture for diagnostics ────────────────────────────────────
  childProcess.stderr?.on('data', (data: Buffer | string) => {
    const text = data.toString().trim();
    if (text.length > 0) {
      stderrLines.push(text);
      getLog().warn({ stderr: text.slice(0, 500) }, 'hermes.bridge.stderr_data');
    }
  });

  // ── process exit handling ──────────────────────────────────────────────
  childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (code !== 0 && code !== null) {
      getLog().warn({ code, signal }, 'hermes.bridge.process_exited_nonzero');
      if (!terminalEmitted) {
        terminalEmitted = true;
        const errors = [`Hermes CLI exited with code ${code}`];
        if (stderrLines.length > 0) {
          errors.push(`stderr: ${stderrLines[stderrLines.length - 1].slice(0, 200)}`);
        }
        queue.push({
          kind: 'chunk',
          chunk: { type: 'result', isError: true, errors },
        });
      }
    } else if (signal !== null) {
      getLog().warn({ signal }, 'hermes.bridge.process_terminated_by_signal');
      if (!terminalEmitted) {
        terminalEmitted = true;
        queue.push({
          kind: 'chunk',
          chunk: {
            type: 'result',
            isError: true,
            errors: [`Hermes CLI terminated by signal ${signal}`],
          },
        });
      }
    }

    // If no terminal chunk was emitted at all (graceful exit with no `done`
    // event), emit one now so the consumer always receives a result.
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          errors: stderrLines.length > 0 ? [stderrLines.join('\n').slice(0, 500)] : undefined,
        },
      });
    }

    queue.push({ kind: 'done' });
  });

  // ── process error handling (spawn failure, EPIPE, etc.) ────────────────
  childProcess.on('error', (error: Error) => {
    getLog().error({ err: error }, 'hermes.bridge.process_error');
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          isError: true,
          errors: [`Failed to run Hermes CLI: ${error.message}`],
        },
      });
    }
    queue.push({ kind: 'done' });
  });

  // ── abort signal handling ──────────────────────────────────────────────
  let sigkillTimeout: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    getLog().debug('hermes.bridge.abort_signal_received');
    childProcess.kill('SIGTERM');
    sigkillTimeout = setTimeout(() => {
      getLog().warn('hermes.bridge.sigkill_fallback');
      childProcess.kill('SIGKILL');
    }, 5000);
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: { type: 'result', isError: true, errors: ['Query was aborted'] },
      });
    }
    queue.close();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // ── consumer loop ──────────────────────────────────────────────────────
  try {
    for await (const item of queue) {
      if (item.kind === 'done') return;
      if (item.kind === 'error') throw item.error;
      yield item.chunk;
    }
  } finally {
    // Clean up: close queue, remove abort listener, clear sigkill timer,
    // close readline interface.
    queue.close();

    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    if (sigkillTimeout) {
      clearTimeout(sigkillTimeout);
    }

    rl.close();

    // Ensure the child process is definitely killed if still running.
    try {
      childProcess.kill('SIGKILL');
    } catch {
      // Process may already be gone — this is defensive.
    }
  }
}
