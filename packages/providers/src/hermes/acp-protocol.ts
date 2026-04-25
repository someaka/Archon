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

let nextId = 1;

/** Reset the auto-incrementing request id counter. Exported for tests. */
export function resetAcpIdCounter(start = 1): void {
  nextId = start;
}

/**
 * Build a JSON-RPC 2.0 request object.
 * The id auto-increments for each call — caller must track the id
 * to match the response.
 */
export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
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
