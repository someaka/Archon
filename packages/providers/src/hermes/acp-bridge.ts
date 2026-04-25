import { createRequest, type ContentBlock, type JsonRpcRequest } from './acp-protocol';

// ─── ACP request sequence ───────────────────────────────────────────────────

/** The complete set of ACP requests needed to run a single-turn query. */
export interface AcpRequests {
  initialize: JsonRpcRequest;
  newSession: JsonRpcRequest;
  prompt: JsonRpcRequest;
}

/**
 * Build the ACP JSON-RPC request sequence for a single-turn Hermes query.
 *
 * Unlike the removed `buildHermesCliArgs`, this produces structured JSON-RPC
 * messages for the `hermes acp` subprocess stdio transport.
 *
 * The `session/prompt` id depends on the `session/new` response (sessionId),
 * so the caller must send these sequentially:
 *   1. `initialize` → get protocol version
 *   2. `session/new` → get sessionId
 *   3. `session/prompt` (using sessionId from step 2)
 */
export function buildAcpRequests(options: {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
}): AcpRequests {
  const { prompt, cwd, systemPrompt } = options;

  // Prepare prompt content blocks
  const blocks: ContentBlock[] = [];
  if (systemPrompt) {
    blocks.push({ type: 'text', text: systemPrompt });
  }
  blocks.push({ type: 'text', text: prompt });

  return {
    initialize: createRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'archon', version: '0.3.9' },
    }),
    newSession: createRequest('session/new', { cwd, mcpServers: [] }),
    prompt: {
      jsonrpc: '2.0' as const,
      id: -1, // placeholder — caller fills in after sessionId is known
      method: 'session/prompt',
      params: { sessionId: '<pending>', prompt: blocks },
    },
  };
}
