import { isAbsolute } from 'node:path';

import type { ChildProcess } from 'node:child_process';

import type { MessageChunk, TokenUsage } from '../types';
import { AsyncQueue, type BridgeQueueItem } from '../utils/async-queue';
import {
  ACP_METHODS,
  createNotification,
  createRequest,
  createAcpIdGenerator,
  isSessionUpdateParams,
  isToolCallUpdate,
  parseMessage,
  serializeMessage,
  type ContentBlock,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from './acp-protocol';
import { createLazyLogger } from '../utils/lazy-logger';
import { BUNDLED_VERSION } from '@archon/paths';
import { classifyHermesError } from './error-classifier';

const getLog = createLazyLogger('provider.hermes.event-bridge');

// ─── JSON-RPC response guards ────────────────────────────────────────────

function assertJsonRpcError(err: unknown): { code: number; message: string } {
  if (
    err != null &&
    typeof err === 'object' &&
    typeof (err as Record<string, unknown>).code === 'number' &&
    typeof (err as Record<string, unknown>).message === 'string'
  ) {
    return err as { code: number; message: string };
  }
  return {
    code: -1,
    message: typeof err === 'string' ? err : (JSON.stringify(err) ?? 'unknown error'),
  };
}

function assertObjectResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  throw new Error(`Expected JSON-RPC result to be an object, got: ${typeof result}`);
}

// ─── ACP usage normalization ──────────────────────────────────────────────

/** ACP MCP server entry for session/new passthrough. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: string[];
}

export function normalizeAcpUsage(usage: Record<string, unknown>): TokenUsage | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const total = usage.totalTokens;
  return {
    input,
    output,
    ...(typeof total === 'number' ? { total } : {}),
  };
}

// ─── Bridge options ─────────────────────────────────────────────────────────

// ─── ACP bridge constants ────────────────────────────────────────────────────
//
// Timeout hierarchy:
//   REQUEST_TIMEOUT_MS (30s) — ACP handshake requests (initialize, session/new).
//     These should complete in <1s; 30s is generous for slow cold-starts.
//   PROMPT_TIMEOUT_MS (5min) — Model inference via session/prompt.
//     Covers the full generation cycle. Mirrors the first-event timeout in
//     provider.ts (getFirstEventTimeoutMs) which fires on the consumer side.
//   SIGKILL fallback (5s) — Grace period after SIGTERM before escalating.
//
// 1 MiB — generous limit for ACP JSON-RPC lines; real messages are typically <10 KiB.
// Prevents unbounded memory growth if the child process writes binary garbage.

const REQUEST_TIMEOUT_MS = 30000;
const PROMPT_TIMEOUT_MS = 300_000; // 5 minutes for model inference
const MAX_LINE_BUFFER_LENGTH = 1024 * 1024; // 1 MiB

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(key|token|api_key|password|secret|auth)\b=\S+/gi, '$1=[REDACTED]')
    .replace(/"(key|token|api_key|password|secret|auth)":\s*"[^"]*/gi, '"$1":"[REDACTED]')
    .replace(
      /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GITHUB_TOKEN|NPM_TOKEN|DATABASE_URL|POSTGRES_PASSWORD)=\S+/gi,
      '$1=[REDACTED]'
    )
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]');
}

/** Options passed to bridgeHermesSession for ACP request construction. */
export interface BridgeOptions {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  mcpServers?: AcpMcpServer[];
  skipInit?: boolean; // Skip initialize/session/new — reuse existing session
  existingSessionId?: string; // Session ID to use when skipInit is true
  keepAlive?: boolean; // Don't kill child process after completion (for session pooling)
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

  if (!isAbsolute(options.cwd)) {
    throw new Error(`Hermes ACP requires absolute cwd, got: ${options.cwd}`);
  }

  // Prevent the child process from keeping the parent process alive.
  childProcess.unref();

  // Track whether we've already emitted a terminal result chunk so we don't
  // emit duplicates (e.g. error event + non-zero exit both firing).
  let terminalEmitted = false;

  let sessionId: string | undefined;
  const MAX_STDERR_LINES = 50;
  const stderrLines: string[] = [];

  // ── stdout: line-by-line ACP JSON-RPC parser ──────────────────────────
  // ACP uses newline-delimited JSON. We buffer for partial lines and
  // parse each complete line as a JSON-RPC message.
  let lineBuffer = '';
  let pendingRequestId: number | undefined;
  let requestResolve: ((msg: JsonRpcMessage) => void) | undefined;
  let requestReject: ((err: Error) => void) | undefined;
  let stdinErrorHandler: ((err: Error) => void) | undefined;
  const activeTimers = new Map<number, ReturnType<typeof setTimeout>>();

  if (!childProcess.stdout) {
    throw new Error('Hermes ACP child process stdout is not available');
  }

  childProcess.stdout.on('data', (data: Buffer | string) => {
    const incoming = data.toString();
    if (lineBuffer.length + incoming.length > MAX_LINE_BUFFER_LENGTH) {
      const remaining = Math.max(0, MAX_LINE_BUFFER_LENGTH - lineBuffer.length);
      if (remaining > 0) {
        lineBuffer += incoming.slice(-remaining);
      } else {
        lineBuffer = incoming.slice(-MAX_LINE_BUFFER_LENGTH);
      }
      getLog().warn('acp.line_buffer_truncated');
    } else {
      lineBuffer += incoming;
    }
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep incomplete last line
    if (lineBuffer.length > MAX_LINE_BUFFER_LENGTH) {
      lineBuffer = lineBuffer.slice(-MAX_LINE_BUFFER_LENGTH);
      getLog().warn('acp.line_buffer_truncated');
    }
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
        if (stdinErrorHandler && childProcess.stdin) {
          childProcess.stdin.removeListener('error', stdinErrorHandler);
          stdinErrorHandler = undefined;
        }
        const timer = activeTimers.get(msg.id);
        if (timer) {
          clearTimeout(timer);
          activeTimers.delete(msg.id);
        }
        continue;
      }

      // Handle notifications (session/update)
      if ('method' in msg && !('id' in msg)) {
        const notif = msg;
        if (notif.method === ACP_METHODS.sessionUpdate && notif.params) {
          const params = notif.params;
          if (!isSessionUpdateParams(params)) {
            getLog().warn({ params }, 'acp.invalid_session_update');
            continue;
          }
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
          } else if (isToolCallUpdate(update)) {
            if (update.status === 'running') {
              queue.push({
                kind: 'chunk',
                chunk: {
                  type: 'tool',
                  toolName: update.title || 'unknown',
                  toolInput: update.rawInput,
                  toolCallId: update.toolCallId,
                },
              });
            } else if (update.status === 'completed' || update.status === 'failed') {
              // rawOutput is object per ACP spec; stringify for toolOutput which is string
              const output = update.rawOutput
                ? JSON.stringify(update.rawOutput)
                : (update.content?.map(c => c.text ?? '').join('') ?? '');
              queue.push({
                kind: 'chunk',
                chunk: {
                  type: 'tool_result',
                  toolName: update.title || 'unknown',
                  toolOutput: output,
                  toolCallId: update.toolCallId,
                },
              });
            }
            // status='pending' → no-op (tool not yet executing)
          } else {
            // Unrecognized session/update type.
            // Known unhandled: 'usage_update' (Draft-stage RFD, not stable protocol).
            // See acp-protocol.ts UsageUpdate for details.
            getLog().debug(
              { sessionUpdate: (update as { sessionUpdate?: string }).sessionUpdate },
              'acp.unrecognized_session_update'
            );
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
      if (stderrLines.length > MAX_STDERR_LINES) {
        stderrLines.shift();
      }
      getLog().warn({ stderr: redactSecrets(text).slice(0, 500) }, 'hermes.bridge.stderr_data');
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
    if (stdinErrorHandler && childProcess.stdin) {
      childProcess.stdin.removeListener('error', stdinErrorHandler);
      stdinErrorHandler = undefined;
    }
  }

  /** Emit a terminal result chunk exactly once, regardless of which handler fires first. */
  function emitTerminal(chunk: Extract<BridgeQueueItem, { kind: 'chunk' }>['chunk']): void {
    if (terminalEmitted) return;
    terminalEmitted = true;
    queue.push({ kind: 'chunk', chunk });
  }

  /** Build error array from base message + last stderr line, classify the error. */
  function buildTerminalError(
    baseMessage: string,
    stderrLines: string[],
    context?: { exitCode?: number | null; jsonRpcCode?: number }
  ): { errors: string[]; errorSubtype: string } {
    const errors = [baseMessage];
    if (stderrLines.length > 0) {
      errors.push(`stderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`);
    }
    const classified = classifyHermesError(baseMessage, {
      stderr: stderrLines,
      exitCode: context?.exitCode ?? null,
      jsonRpcCode: context?.jsonRpcCode,
    });
    return { errors, errorSubtype: classified.errorClass };
  }

  // ── process exit handling ──────────────────────────────────────────────
  childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (sigkillTimeout) {
      clearTimeout(sigkillTimeout);
    }
    if (code !== 0 && code !== null) {
      getLog().warn({ code, signal }, 'hermes.bridge.process_exited_nonzero');
      rejectPending(`Hermes ACP exited with code ${code}`);
      const { errors, errorSubtype } = buildTerminalError(
        `Hermes ACP exited with code ${code}`,
        stderrLines,
        { exitCode: code }
      );
      emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
    } else if (signal !== null) {
      getLog().warn({ signal }, 'hermes.bridge.process_terminated_by_signal');
      rejectPending(`Hermes ACP terminated by signal ${signal}`);
      const { errors, errorSubtype } = buildTerminalError(
        `Hermes ACP terminated by signal ${signal}`,
        stderrLines
      );
      emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
    } else {
      // Clean exit (code 0 or null) — reject any pending request to avoid 30s timeout
      rejectPending('Hermes ACP process exited unexpectedly');
    }

    queue.push({ kind: 'done' });
  });

  // ── process error handling (spawn failure, EPIPE, etc.) ────────────────
  childProcess.on('error', (error: Error) => {
    getLog().error({ err: error }, 'hermes.bridge.process_error');
    const baseMessage = `Failed to run Hermes ACP: ${error.message}`;
    const { errors, errorSubtype } = buildTerminalError(baseMessage, stderrLines);
    rejectPending(baseMessage);
    emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
    queue.push({ kind: 'done' });
  });

  // ── abort signal handling ──────────────────────────────────────────────
  let sigkillTimeout: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    getLog().debug('hermes.bridge.abort_signal_received');
    // Send session/cancel notification (fire-and-forget)
    if (sessionId) {
      try {
        const data = serializeMessage(
          createNotification(ACP_METHODS.sessionCancel, {
            sessionId,
          })
        );
        const canWrite = childProcess.stdin?.write(data);
        if (canWrite === false) {
          getLog().debug('acp.stdin_backpressure_on_abort');
        }
      } catch (err) {
        getLog().warn({ err }, 'acp.stdin_write_failed_on_abort');
      }
    }
    try {
      childProcess.kill('SIGTERM');
    } catch {
      // Process already killed or exited — expected, no-op
    }
    sigkillTimeout = setTimeout(() => {
      getLog().warn('hermes.bridge.sigkill_fallback');
      try {
        childProcess.kill('SIGKILL');
      } catch {
        // Process already killed or exited — expected, no-op
      }
    }, 5000);
    const { errors, errorSubtype } = buildTerminalError('Query was aborted', stderrLines);
    rejectPending('Query was aborted');
    emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
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
  const idGen = createAcpIdGenerator();

  async function sendRequest(
    req: JsonRpcRequest,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<JsonRpcMessage> {
    return Promise.race([
      new Promise<JsonRpcMessage>((resolve, reject) => {
        pendingRequestId = req.id;
        requestResolve = resolve;
        requestReject = reject;
        if (!childProcess.stdin) {
          reject(new Error('Hermes ACP child process stdin is not available'));
          return;
        }
        childProcess.stdin.once('error', err => {
          getLog().warn({ err }, 'acp.stdin_error');
          reject(new Error(`Hermes ACP stdin error: ${err.message}`));
        });
        const data = serializeMessage(req);
        const canWrite = childProcess.stdin.write(data);
        if (!canWrite) {
          childProcess.stdin.once('drain', () => {
            getLog().debug('acp.stdin_drain_complete');
          });
        }
      }),
      new Promise<JsonRpcMessage>((_resolve, reject) => {
        const timer = setTimeout(() => {
          activeTimers.delete(req.id);
          pendingRequestId = undefined;
          requestResolve = undefined;
          requestReject = undefined;
          if (stdinErrorHandler && childProcess.stdin) {
            childProcess.stdin.removeListener('error', stdinErrorHandler);
            stdinErrorHandler = undefined;
          }
          reject(new Error(`Hermes ACP request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        activeTimers.set(req.id, timer);
      }),
    ]);
  }

  try {
    if (!options.skipInit) {
      // 1. Initialize
      const initReq = createRequest(
        ACP_METHODS.initialize,
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'archon', version: BUNDLED_VERSION },
        },
        idGen
      );
      const initResp = await sendRequest(initReq);
      if ('error' in initResp) {
        const err = assertJsonRpcError(initResp.error);
        throw new Error(`ACP initialize failed: ${err.message} (code ${err.code})`);
      }
      if (
        'result' in initResp &&
        typeof assertObjectResult(initResp.result)?.protocolVersion === 'number'
      ) {
        const protoVersion = assertObjectResult(initResp.result)?.protocolVersion as number;
        if (protoVersion !== 1) {
          throw new Error(
            `Hermes ACP protocol version ${protoVersion} is not supported. Only version 1 is supported.`
          );
        }
      }

      // Log agent capabilities, info, and auth methods from the initialize response
      if ('result' in initResp) {
        const result = assertObjectResult(initResp.result);
        if (result) {
          if (result.agentCapabilities && typeof result.agentCapabilities === 'object') {
            const caps = result.agentCapabilities as Record<string, unknown>;
            getLog().debug(
              {
                loadSession: caps.loadSession,
                promptCapabilities: caps.promptCapabilities,
                mcpCapabilities: caps.mcpCapabilities,
              },
              'acp.initialize.agent_capabilities'
            );
          }

          if (result.agentInfo && typeof result.agentInfo === 'object') {
            const info = result.agentInfo as Record<string, unknown>;
            getLog().debug(
              { name: info.name, title: info.title, version: info.version },
              'acp.initialize.agent_info'
            );
          }

          if (Array.isArray(result.authMethods)) {
            getLog().debug({ authMethods: result.authMethods }, 'acp.initialize.auth_methods');
          }
        }
      }

      // 2. New session
      const sessionReq = createRequest(
        ACP_METHODS.sessionNew,
        {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [], // passed through from caller; empty by default
        },
        idGen
      );
      const sessionResp = await sendRequest(sessionReq);
      if ('error' in sessionResp) {
        const err = assertJsonRpcError(sessionResp.error);
        throw new Error(`ACP session/new failed: ${err.message} (code ${err.code})`);
      }
      if ('result' in sessionResp) {
        const result = assertObjectResult(sessionResp.result);
        if (result && typeof result.sessionId === 'string') {
          sessionId = result.sessionId;
        }
      }
      if (!sessionId) {
        throw new Error('Hermes ACP did not return a valid sessionId');
      }
    } else {
      // skipInit mode: reuse an existing session
      if (!options.existingSessionId) {
        throw new Error('existingSessionId is required when skipInit is true');
      }
      sessionId = options.existingSessionId;
    }

    // 3. Send prompt
    const blocks: ContentBlock[] = options.systemPrompt
      ? [
          { type: 'text', text: options.systemPrompt },
          { type: 'text', text: options.prompt },
        ]
      : [{ type: 'text', text: options.prompt }];

    const promptReq = createRequest(
      ACP_METHODS.sessionPrompt,
      {
        sessionId,
        prompt: blocks,
      },
      idGen
    );
    const promptResp = await sendRequest(promptReq, PROMPT_TIMEOUT_MS);
    if ('error' in promptResp) {
      const err = assertJsonRpcError(promptResp.error);
      throw new Error(`ACP session/prompt failed: ${err.message} (code ${err.code})`);
    }
    // 4. Emit terminal result
    const result =
      'result' in promptResp
        ? assertObjectResult('result' in promptResp ? promptResp.result : undefined)
        : undefined;
    const stopReason = result?.stopReason as string | undefined;
    const tokens = result?.usage
      ? normalizeAcpUsage(result.usage as Record<string, unknown>)
      : undefined;
    emitTerminal({
      type: 'result',
      sessionId,
      stopReason,
      ...(tokens ? { tokens } : {}),
    });
    // Send session/close notification (fire-and-forget) per ACP spec.
    // Skip in prompt-only mode or keepAlive to preserve the existing session.
    if (sessionId && !options.skipInit && !options.keepAlive) {
      try {
        const data = serializeMessage(
          createNotification(ACP_METHODS.sessionClose, {
            sessionId,
          })
        );
        const canWrite = childProcess.stdin?.write(data);
        if (canWrite === false) {
          getLog().debug('acp.stdin_backpressure_on_close');
        }
      } catch (err) {
        getLog().warn({ err }, 'acp.stdin_write_failed_on_close');
      }
    }
    queue.push({ kind: 'done' });
  } catch (err) {
    getLog().error({ err }, 'hermes.bridge.acp_request_failed');
    const errorMessage = err instanceof Error ? err.message : String(err);
    const { errors, errorSubtype } = buildTerminalError(errorMessage, stderrLines);
    emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
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
    // Skip in prompt-only mode or keepAlive to preserve the existing session.
    if (!options.skipInit && !options.keepAlive) {
      try {
        childProcess.kill('SIGKILL');
      } catch {
        // Process may already be gone — this is defensive.
      }
    }
  }
}
