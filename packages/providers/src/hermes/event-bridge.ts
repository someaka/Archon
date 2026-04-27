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

const getLog = createLazyLogger('provider.hermes.event-bridge');

// ─── ACP usage normalization ──────────────────────────────────────────────

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
              { sessionUpdate: (update as unknown as Record<string, unknown>).sessionUpdate },
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
  }

  /** Emit a terminal result chunk exactly once, regardless of which handler fires first. */
  function emitTerminal(chunk: Extract<BridgeQueueItem, { kind: 'chunk' }>['chunk']): void {
    if (terminalEmitted) return;
    terminalEmitted = true;
    queue.push({ kind: 'chunk', chunk });
  }

  // ── process exit handling ──────────────────────────────────────────────
  childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (sigkillTimeout) {
      clearTimeout(sigkillTimeout);
    }
    if (code !== 0 && code !== null) {
      getLog().warn({ code, signal }, 'hermes.bridge.process_exited_nonzero');
      rejectPending(`Hermes ACP exited with code ${code}`);
      const errors = [`Hermes ACP exited with code ${code}`];
      if (stderrLines.length > 0) {
        errors.push(`stderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`);
      }
      emitTerminal({ type: 'result', isError: true, errors });
    } else if (signal !== null) {
      getLog().warn({ signal }, 'hermes.bridge.process_terminated_by_signal');
      rejectPending(`Hermes ACP terminated by signal ${signal}`);
      emitTerminal({
        type: 'result',
        isError: true,
        errors: [`Hermes ACP terminated by signal ${signal}`],
      });
    } else {
      // Clean exit (code 0 or null) — reject any pending request to avoid 30s timeout
      rejectPending('Hermes ACP process exited unexpectedly');
    }

    queue.push({ kind: 'done' });
  });

  // ── process error handling (spawn failure, EPIPE, etc.) ────────────────
  childProcess.on('error', (error: Error) => {
    getLog().error({ err: error }, 'hermes.bridge.process_error');
    let errorMsg = `Failed to run Hermes ACP: ${error.message}`;
    if (stderrLines.length > 0) {
      errorMsg += `\nstderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`;
    }
    rejectPending(errorMsg);
    const errors = [`Failed to run Hermes ACP: ${error.message}`];
    if (stderrLines.length > 0) {
      errors.push(`stderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`);
    }
    emitTerminal({ type: 'result', isError: true, errors });
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
    let abortMsg = 'Query was aborted';
    if (stderrLines.length > 0) {
      abortMsg += `\nstderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`;
    }
    rejectPending(abortMsg);
    const errors = ['Query was aborted'];
    if (stderrLines.length > 0) {
      errors.push(`stderr: ${redactSecrets(stderrLines[stderrLines.length - 1]).slice(0, 200)}`);
    }
    emitTerminal({ type: 'result', isError: true, errors });
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
          reject(new Error(`Hermes ACP request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        activeTimers.set(req.id, timer);
      }),
    ]);
  }

  try {
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
      const err = initResp.error as { code: number; message: string };
      throw new Error(`ACP initialize failed: ${err.message} (code ${err.code})`);
    }
    if (
      'result' in initResp &&
      typeof (initResp.result as Record<string, unknown>).protocolVersion === 'number'
    ) {
      const protoVersion = (initResp.result as Record<string, unknown>).protocolVersion as number;
      if (protoVersion !== 1) {
        throw new Error(
          `Hermes ACP protocol version ${protoVersion} is not supported. Only version 1 is supported.`
        );
      }
    }

    // Log agent capabilities, info, and auth methods from the initialize response
    if ('result' in initResp) {
      const result = initResp.result as Record<string, unknown>;

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

    // 2. New session
    const sessionReq = createRequest(
      ACP_METHODS.sessionNew,
      {
        cwd: options.cwd,
        mcpServers: [], // required by ACP schema; mcp capability is false so no servers are configured
      },
      idGen
    );
    const sessionResp = await sendRequest(sessionReq);
    if ('error' in sessionResp) {
      const err = sessionResp.error as { code: number; message: string };
      throw new Error(`ACP session/new failed: ${err.message} (code ${err.code})`);
    }
    if ('result' in sessionResp) {
      const result = sessionResp.result as Record<string, unknown>;
      if (typeof result.sessionId === 'string') {
        sessionId = result.sessionId;
      }
    }
    if (!sessionId) {
      throw new Error('Hermes ACP did not return a valid sessionId');
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
      const err = promptResp.error as { code: number; message: string };
      throw new Error(`ACP session/prompt failed: ${err.message} (code ${err.code})`);
    }
    // 4. Emit terminal result
    const result =
      'result' in promptResp ? (promptResp.result as Record<string, unknown>) : undefined;
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
    if (sessionId) {
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
    emitTerminal({
      type: 'result',
      isError: true,
      errors: [(err as Error).message],
    });
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
