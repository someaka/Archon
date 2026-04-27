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
  id: number;
  result: unknown;
}

/** JSON-RPC 2.0 error response from Hermes. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
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

export function createAcpIdGenerator(start = 1): AcpIdGenerator {
  let nextId = start;
  return { next: () => nextId++ };
}

/**
 * Build a JSON-RPC 2.0 request object.
 * The id auto-increments for each call — caller must track the id
 * to match the response.
 */
// Legacy module-level fallback generator for backward-compatible callers
let legacyId = 1;

export function createRequest(
  method: string,
  params?: Record<string, unknown>,
  idGenerator?: AcpIdGenerator
): JsonRpcRequest {
  const id = idGenerator ? idGenerator.next() : legacyId++;
  return { jsonrpc: '2.0', id, method, params };
}

/** @deprecated No-op — IDs are now generated per-bridge via createAcpIdGenerator. */
export function resetAcpIdCounter(_start = 1): void {
  // no-op
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
      if ('method' in record && !('id' in record)) return obj as JsonRpcNotification;
      if ('result' in record) return obj as JsonRpcSuccess;
      if ('error' in record) return obj as JsonRpcError;
    }
    return null;
  } catch {
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

export type SessionUpdateUnion = AgentMessageChunkUpdate | AgentThoughtChunkUpdate;

/** The params payload of a `session/update` notification. */
export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdateUnion;
}

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
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
    update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk'
  );
}
