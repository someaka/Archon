/** ACP (Agent Client Protocol) JSON-RPC 2.0 types and helpers.
 *
 * Defines the wire-format types used by the Hermes provider to communicate
 * with the Hermes CLI via stdio.
 *
 * @see https://agentclientprotocol.com/protocol/schema
 * @see https://agentclientprotocol.com/protocol/overview
 */

import { createLazyLogger } from '../utils/lazy-logger';
const getLog = createLazyLogger('provider.hermes.acp-protocol');

// ─── JSON-RPC 2.0 types ────────────────────────────────────────────────────

/** JSON-RPC 2.0 request sent by Archon (client) → Hermes (server). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response from Hermes. */
export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/** JSON-RPC 2.0 error response from Hermes. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification;

// ─── Request / notification builders ────────────────────────────────────────

export interface AcpIdGenerator {
  next(): number;
}

/** Module-level monotonic counter for JSON-RPC request IDs. */
let globalAcpIdCounter = 0;

export function createAcpIdGenerator(): AcpIdGenerator {
  return {
    next: (): number => {
      globalAcpIdCounter = (globalAcpIdCounter % Number.MAX_SAFE_INTEGER) + 1;
      return globalAcpIdCounter;
    },
  };
}

/**
 * Build a JSON-RPC 2.0 request object.
 * The id is provided by the caller's ACP id generator — each call
 * consumes one id from the generator's sequence.
 */
export function createRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  idGenerator: AcpIdGenerator
): JsonRpcRequest {
  const id = idGenerator.next();
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * Build a JSON-RPC 2.0 notification (no id field).
 * Notifications are fire-and-forget — no response expected.
 */
export function createNotification(
  method: string,
  params?: Record<string, unknown>
): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

/**
 * Serialize a JSON-RPC message to newline-delimited wire format.
 * ACP transport is one JSON object per line over stdio.
 */
export function serializeMessage(msg: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(msg) + '\n';
}

// ─── Response / notification parser ─────────────────────────────────────────

/**
 * Parse a single line of ACP stdio output into a typed JSON-RPC message.
 * Returns null if the line is not valid JSON-RPC 2.0.
 */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (obj && typeof obj === 'object' && (obj as Record<string, unknown>).jsonrpc === '2.0') {
      const record = obj as Record<string, unknown>;

      // Reject messages with both result and method (protocol violation)
      if ('result' in record && 'method' in record) return null;

      // Notification: has method, no id
      if ('method' in record && !('id' in record)) {
        if (typeof record.method !== 'string') return null;
        return obj as JsonRpcNotification;
      }

      // Success response: has result, id must be a number
      if ('result' in record) {
        if (typeof record.id !== 'number' && typeof record.id !== 'string') return null;
        return obj as JsonRpcSuccess;
      }

      // Error response: has error, id must be a number, error must have numeric code
      if ('error' in record) {
        if (typeof record.id !== 'number' && typeof record.id !== 'string') return null;
        const errorObj = record.error;
        if (
          !errorObj ||
          typeof errorObj !== 'object' ||
          typeof (errorObj as Record<string, unknown>).code !== 'number'
        ) {
          return null;
        }
        return obj as JsonRpcError;
      }
    }
    return null;
  } catch (err) {
    getLog().debug({ err, line: line.slice(0, 200) }, 'acp.parse_failed');
    return null;
  }
}

// ─── ACP content block types ────────────────────────────────────────────────

/** A text content block within a prompt or update. */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextContentBlock;

// ─── ACP session/update event types ─────────────────────────────────────────
//
// Verified against ACP Prompt Turn docs:
//   - The discriminator field is `sessionUpdate` (not `type`).
//   - `content` is a `ContentBlock` ({type: "text", text: "..."}), NOT a raw string.

/** An agent message chunk pushed via `session/update`. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: TextContentBlock;
}

/** An agent thought chunk (reasoning) pushed via `session/update`. */
export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: TextContentBlock;
}

/** ACP ToolKind — category of tool being invoked. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

/** ACP ToolCallStatus — execution status of a tool call. */
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A tool call event pushed via `session/update`.
 * Covers both `tool_call` (creation) and `tool_call_update` (progress).
 * Both use the same shape per ACP spec.
 */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  kind: ToolKind;
  title: string;
  status: ToolCallStatus;
  content?: { type: string; text?: string; [key: string]: unknown }[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  locations?: { path: string; line?: number }[];
}

/**
 * ACP usage_update — Draft-stage RFD. Session-level context window + cost update.
 *
 * ⚠️ DRAFT: This type is from ACP's Draft RFD, not stable protocol.
 * Do NOT rely on this shape — it may change or be removed.
 *
 * NOTE: Per-token usage (inputTokens/outputTokens) belongs in the PromptResponse
 * (per-turn), NOT in session/update notifications. This type tracks session-level
 * aggregated usage, not per-turn token counts.
 *
 * Currently NOT added to isSessionUpdateParams — events with this type
 * will hit the unrecognized_session_update debug log in event-bridge.
 */
export interface UsageUpdate {
  sessionUpdate: 'usage_update';
  contextWindowUsed?: number;
  contextWindowMax?: number;
  costUsd?: number;
}

/**
 * ACP PromptResponse usage data (UNSTABLE — Draft RFD).
 * Per-turn token counts returned in session/prompt result.
 *
 * @see https://agentclientprotocol.com/rfds/session-usage
 */
export interface PromptResponseUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

/**
 * ACP available_commands_update — Hermes sends this on session/new to report
 * available slash commands. Non-critical informational update.
 */
export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands?: { name: string; description?: string }[];
}

// TODO(#acp-usage-update): Shape is Draft RFD. Added to union so events pass
// validation and reach the debug log (unrecognized_session_update) instead of
// the warn log (invalid_session_update).
export type SessionUpdateUnion =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | UsageUpdate
  | AvailableCommandsUpdate;

/** The params payload of a `session/update` notification. */
export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdateUnion;
}

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionClose: 'session/close',
  sessionUpdate: 'session/update',
} as const;

export function isSessionUpdateParams(obj: unknown): obj is SessionUpdateParams {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  if (typeof record.sessionId !== 'string') return false;
  if (!record.update || typeof record.update !== 'object') return false;
  const update = record.update as Record<string, unknown>;
  if (typeof update.sessionUpdate !== 'string') return false;
  return (
    update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk' ||
    update.sessionUpdate === 'tool_call' ||
    update.sessionUpdate === 'tool_call_update' ||
    update.sessionUpdate === 'usage_update' ||
    update.sessionUpdate === 'available_commands_update'
  );
}

/** Type guard for `ToolCallUpdate` events. */
export function isToolCallUpdate(update: SessionUpdateUnion): update is ToolCallUpdate {
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update';
}
