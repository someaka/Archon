import { createLogger } from '@archon/paths';
import type { ChildProcess } from 'child_process';

import type { MessageChunk } from '../types';
import { AsyncQueue, type BridgeQueueItem } from '../utils/async-queue';
import {
  createRequest,
  parseMessage,
  serializeMessage,
  type ContentBlock,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SessionUpdateParams,
} from './acp-protocol';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.hermes.event-bridge');
  return cachedLog;
}

// ─── Bridge options ─────────────────────────────────────────────────────────

/** Options passed to bridgeHermesSession for ACP request construction. */
export interface BridgeOptions {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
}

// ─── bridgeHermesSession (ACP JSON-RPC 2.0) ────────────────────────────────

/**
 * Bridge a Hermes ACP child process (spawned with `hermes acp`) into Archon's
 * `AsyncGenerator<MessageChunk>` contract.
 *
 * Behavior:
 *  - sends `initialize` → `session/new` → `session/prompt` sequentially
 *    over the child's stdin
 *  - reads childProcess.stdout line-by-line, parsing ACP JSON-RPC 2.0
 *    newline-delimited messages
 *  - routes responses to the pending request resolver by id
 *  - routes `session/update` notifications to the async queue as
 *    MessageChunk stream events (`agent_message_chunk` → assistant,
 *    `agent_thought_chunk` → thinking)
 *  - captures stderr lines at `warn` level (non-fatal — Hermes may log
 *    diagnostics to stderr while still succeeding on stdout)
 *  - on process exit with non-zero code: emits a terminal `result` chunk
 *    with `isError: true` and the exit code in `errors`
 *  - on process crash (error event, signal termination): emits a terminal
 *    `result` chunk with `isError: true`
 *  - on `abortSignal`: sends `session/cancel` notification, then
 *    `SIGTERM` to the child (with `SIGKILL` fallback after 5 s), closes
 *    the queue so the consumer exits
 *  - always calls `childProcess.unref()` to prevent zombie processes
 *  - always emits a terminal `result` chunk, even on error paths, so the
 *    consumer never hangs waiting for a chunk that never arrives
 */
export async function* bridgeHermesSession(
  childProcess: ChildProcess,
  options: BridgeOptions,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();

  // Prevent the child process from keeping the parent process alive.
  childProcess.unref();

  // Track whether we've already emitted a terminal result chunk so we don't
  // emit duplicates (e.g. error event + non-zero exit both firing).
  let terminalEmitted = false;

  let sessionId: string | undefined;
  const stderrLines: string[] = [];

  // ── stdout: line-by-line ACP JSON-RPC parser ──────────────────────────
  // ACP uses newline-delimited JSON. We buffer for partial lines and
  // parse each complete line as a JSON-RPC message.
  let lineBuffer = '';
  let pendingRequestId: number | undefined;
  let requestResolve: ((msg: JsonRpcMessage) => void) | undefined;
  let requestReject: ((err: Error) => void) | undefined;

  if (!childProcess.stdout) {
    throw new Error('Hermes ACP child process stdout is not available');
  }

  childProcess.stdout.on('data', (data: Buffer | string) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const msg = parseMessage(trimmed);
      if (!msg) {
        getLog().warn({ line: trimmed.slice(0, 200) }, 'acp.invalid_json');
        continue;
      }

      // Route response to pending request resolver
      if ('id' in msg && msg.id === pendingRequestId && requestResolve) {
        requestResolve(msg);
        requestResolve = undefined;
        requestReject = undefined;
        pendingRequestId = undefined;
        continue;
      }

      // Handle notifications (session/update)
      if ('method' in msg && !('id' in msg)) {
        const notif = msg;
        if (notif.method === 'session/update' && notif.params) {
          const params = notif.params as unknown as SessionUpdateParams;
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk') {
            queue.push({
              kind: 'chunk',
              chunk: { type: 'assistant', content: update.content.text },
            });
          } else if (update.sessionUpdate === 'agent_thought_chunk') {
            queue.push({
              kind: 'chunk',
              chunk: { type: 'thinking', content: update.content.text },
            });
          }
        }
      }
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

  // ── Terminate pending request on process exit/error ────────────────────
  function rejectPending(reason: string): void {
    if (requestReject) {
      requestReject(new Error(reason));
      requestReject = undefined;
      requestResolve = undefined;
      pendingRequestId = undefined;
    }
  }

  // ── process exit handling ──────────────────────────────────────────────
  childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (code !== 0 && code !== null) {
      getLog().warn({ code, signal }, 'hermes.bridge.process_exited_nonzero');
      rejectPending(`Hermes ACP exited with code ${code}`);
      if (!terminalEmitted) {
        terminalEmitted = true;
        const errors = [`Hermes ACP exited with code ${code}`];
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
      rejectPending(`Hermes ACP terminated by signal ${signal}`);
      if (!terminalEmitted) {
        terminalEmitted = true;
        queue.push({
          kind: 'chunk',
          chunk: {
            type: 'result',
            isError: true,
            errors: [`Hermes ACP terminated by signal ${signal}`],
          },
        });
      }
    }

    queue.push({ kind: 'done' });
  });

  // ── process error handling (spawn failure, EPIPE, etc.) ────────────────
  childProcess.on('error', (error: Error) => {
    getLog().error({ err: error }, 'hermes.bridge.process_error');
    rejectPending(`Failed to run Hermes ACP: ${error.message}`);
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          isError: true,
          errors: [`Failed to run Hermes ACP: ${error.message}`],
        },
      });
    }
    queue.push({ kind: 'done' });
  });

  // ── abort signal handling ──────────────────────────────────────────────
  let sigkillTimeout: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    getLog().debug('hermes.bridge.abort_signal_received');
    // Send session/cancel notification (fire-and-forget)
    if (sessionId) {
      childProcess.stdin?.write(
        serializeMessage(
          createRequest(
            'session/cancel' as const,
            {
              sessionId,
            } as unknown as Record<string, unknown>
          )
        )
      );
    }
    childProcess.kill('SIGTERM');
    sigkillTimeout = setTimeout(() => {
      getLog().warn('hermes.bridge.sigkill_fallback');
      childProcess.kill('SIGKILL');
    }, 5000);
    rejectPending('Query was aborted');
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

  // ── Send ACP requests sequentially ─────────────────────────────────────
  async function sendRequest(req: JsonRpcRequest): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      pendingRequestId = req.id;
      requestResolve = resolve;
      requestReject = reject;
      if (!childProcess.stdin) {
        reject(new Error('Hermes ACP child process stdin is not available'));
        return;
      }
      childProcess.stdin.write(serializeMessage(req));
    });
  }

  try {
    // 1. Initialize
    const initReq = createRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'archon', version: '0.3.9' },
    });
    await sendRequest(initReq);

    // 2. New session
    const sessionReq = createRequest('session/new', {
      cwd: options.cwd,
      mcpServers: [],
    });
    const sessionResp = await sendRequest(sessionReq);
    if ('result' in sessionResp) {
      sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
    }
    if (!sessionId) {
      throw new Error('Hermes ACP did not return a sessionId');
    }

    // 3. Send prompt
    const blocks: ContentBlock[] = options.systemPrompt
      ? [
          { type: 'text', text: options.systemPrompt },
          { type: 'text', text: options.prompt },
        ]
      : [{ type: 'text', text: options.prompt }];

    const promptReq = createRequest('session/prompt', {
      sessionId,
      prompt: blocks,
    });
    const promptResp = await sendRequest(promptReq);

    // 4. Emit terminal result
    if (!terminalEmitted) {
      terminalEmitted = true;
      const stopReason =
        'result' in promptResp
          ? ((promptResp.result as Record<string, unknown>).stopReason as string)
          : undefined;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          sessionId,
          stopReason,
        },
      });
    }
    queue.push({ kind: 'done' });
  } catch (err) {
    getLog().error({ err }, 'hermes.bridge.acp_request_failed');
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          isError: true,
          errors: [(err as Error).message],
        },
      });
    }
    queue.push({ kind: 'done' });
  }

  // ── consumer loop ──────────────────────────────────────────────────────
  try {
    for await (const item of queue) {
      if (item.kind === 'done') return;
      if (item.kind === 'error') throw item.error;
      yield item.chunk;
    }
  } finally {
    // Clean up: close queue, remove abort listener, clear sigkill timer.
    queue.close();

    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    if (sigkillTimeout) {
      clearTimeout(sigkillTimeout);
    }

    // Ensure the child process is definitely killed if still running.
    try {
      childProcess.kill('SIGKILL');
    } catch {
      // Process may already be gone — this is defensive.
    }
  }
}
