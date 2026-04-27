# Hermes ACP Implementation Verification Against Online Specifications

**Date**: 2026-04-27
**Verifier**: Subagent 2 — Online Spec Cross-Reference
**Scope**: ACP protocol compliance + JSON-RPC 2.0 compliance
**Read-only**: No source files modified

## Sources Consulted

| Source             | URL                                                          |
| ------------------ | ------------------------------------------------------------ |
| ACP Overview       | https://agentclientprotocol.com/protocol/overview            |
| ACP Schema         | https://agentclientprotocol.com/protocol/schema              |
| ACP Initialization | https://agentclientprotocol.com/protocol/initialization      |
| ACP Session Setup  | https://agentclientprotocol.com/protocol/session-setup       |
| ACP Prompt Turn    | https://agentclientprotocol.com/protocol/prompt-turn         |
| ACP Content        | https://agentclientprotocol.com/protocol/content             |
| ACP Transports     | https://agentclientprotocol.com/protocol/transports          |
| JSON-RPC 2.0 Spec  | https://www.jsonrpc.org/specification                        |
| ACP GitHub Repo    | https://github.com/agentclientprotocol/agent-client-protocol |

## Files Audited

| File                                                | Role                                      |
| --------------------------------------------------- | ----------------------------------------- |
| `packages/providers/src/hermes/acp-protocol.ts`     | Wire format types, serialization, parsing |
| `packages/providers/src/hermes/event-bridge.ts`     | ACP lifecycle orchestration               |
| `packages/providers/src/hermes/session-resolver.ts` | Execution context resolution              |
| `packages/providers/src/hermes/provider.ts`         | IAgentProvider implementation             |
| `packages/providers/src/hermes/binary-resolver.ts`  | Binary discovery                          |

---

## Findings

### CRITICAL

#### C1. Version Negotiation Uses Wrong Field Name (snake_case vs camelCase)

**Location**: `event-bridge.ts` lines 344-354

```typescript
if (
  'result' in initResp &&
  typeof (initResp.result as Record<string, unknown>).protocol_version === 'number'  // <-- WRONG
) {
  const protoVersion = (initResp.result as Record<string, unknown>).protocol_version as number;
```

**Spec**: ACP Initialization page shows the InitializeResponse uses camelCase:

```json
{
  "result": {
    "protocolVersion": 1,     // <-- camelCase per spec
    "agentCapabilities": { ... }
  }
}
```

**Impact**: The code checks for `protocol_version` (snake_case) but the ACP spec defines `protocolVersion` (camelCase). If Hermes CLI follows the ACP spec, `protocol_version` will be `undefined`, the `typeof` check fails, and the entire version negotiation block is silently skipped. This means **incompatible protocol versions are never detected** — the implementation silently accepts any version.

**Fix**: Change `protocol_version` to `protocolVersion` in both the check (line 346) and the read (line 348).

---

### IMPORTANT

#### I1. `id` Field Type Restricted to `number` Only

**Location**: `acp-protocol.ts` lines 17-21, 119, 125

```typescript
export interface JsonRpcRequest {
  id: number; // JSON-RPC 2.0 allows String | Number | NULL
}

// In parseMessage:
if (typeof record.id !== 'number') return null; // Rejects string ids
```

**Spec**: JSON-RPC 2.0 Section 4:

> "id: An identifier established by the Client that MUST contain a String, Number, or NULL value if included."

**Impact**: Low in practice since Archon always generates numeric ids and responses should match. However, the parser would incorrectly reject valid JSON-RPC 2.0 responses with string ids, which could cause issues if Hermes ever returns string ids or if this parser is reused in other contexts.

**Recommendation**: Accept `string | number` for `id` in response types. The request `id` can stay as `number` since Archon controls generation.

#### I2. `params` Typed as `Record<string, unknown>` — JSON-RPC 2.0 Allows Arrays

**Location**: `acp-protocol.ts` lines 20, 41

```typescript
params?: Record<string, unknown>;  // Only allows objects
```

**Spec**: JSON-RPC 2.0 Section 4:

> "params: A Structured value that holds the parameter values... This member MAY be omitted."
> Section 5 (Parameter Structures): "By-position: params MUST be an Array... By-name: params MUST be an Object."

**Impact**: The ACP spec exclusively uses object params, so this is fine for ACP compliance. But strictly speaking, it's a JSON-RPC 2.0 deviation. If the parser encounters an array-valued params from a non-ACP JSON-RPC source, it would still parse correctly (the type annotation is only at the TypeScript level, not enforced at runtime for received messages).

**Recommendation**: Low priority. Consider `params?: Record<string, unknown> | unknown[]` for full JSON-RPC 2.0 compliance.

#### I3. Missing `authenticate` Method Support

**Location**: `acp-protocol.ts` line 180-186 — `ACP_METHODS` does not include `authenticate`

**Spec**: ACP Overview lists `authenticate` as a **baseline** Agent method:

> "authenticate — Authenticate with the Agent (if required)."

The ACP Initialization page states:

> "After successful authentication, the client can proceed to create sessions with `new_session` without receiving an `auth_required` error."

**Impact**: If Hermes ever requires authentication, the implementation will fail because it jumps directly from `initialize` to `session/new` without checking for auth requirements. Currently this is safe if Hermes doesn't require auth, but it's a spec gap.

**Recommendation**: After `initialize`, check if `authMethods` in the response is non-empty. If so, call `authenticate` before `session/new`. Add `authenticate` to `ACP_METHODS`.

#### I4. `clientCapabilities` Sent as Empty Object

**Location**: `event-bridge.ts` line 338

```typescript
clientCapabilities: {},
```

**Spec**: ACP Schema shows the default client capabilities:

```json
{
  "fs": { "readTextFile": false, "writeTextFile": false },
  "terminal": false
}
```

**Impact**: Sending `{}` is functionally equivalent to all-false defaults per the spec (the spec says "Default: {...}"). However, being explicit about the structure is better practice and ensures the agent knows exactly what the client supports.

**Recommendation**: Send the full default structure for clarity:

```typescript
clientCapabilities: {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
},
```

---

### MINOR

#### M1. Only `TextContentBlock` Supported in Prompts

**Location**: `acp-protocol.ts` lines 147-152

```typescript
export interface TextContentBlock {
  type: 'text';
  text: string;
}
export type ContentBlock = TextContentBlock;
```

**Spec**: ACP Content page defines four content block types:

- `text` — `{type: "text", text: "..."}`
- `image` — `{type: "image", mimeType: "...", data: "..."}`
- `audio` — `{type: "audio", mimeType: "...", data: "..."}`
- `resource` — `{type: "resource", resource: {uri: "...", text: "..."}}`

**Impact**: None currently — Archon sends text-only prompts. But the type definition limits future extensibility. The ACP spec notes that content types are constrained by `promptCapabilities` negotiated during initialization.

#### M2. Only `agent_message_chunk` and `agent_thought_chunk` Update Types Handled

**Location**: `acp-protocol.ts` lines 161-172, `event-bridge.ts` lines 158-168

**Spec**: ACP Prompt Turn page shows additional `sessionUpdate` types:

- `agent_message_chunk` ✅ handled
- `agent_thought_chunk` ✅ handled
- `plan` — not handled (agent plan entries)
- `tool_call` — not handled (tool invocation)
- `tool_result` — not handled (tool output)
- Others may exist

**Impact**: Any `session/update` with an unrecognized `sessionUpdate` value is silently dropped (the `isSessionUpdateParams` guard returns false). This is safe but means tool call progress, plan updates, etc. are invisible to the user.

**Recommendation**: Log unrecognized `sessionUpdate` types at debug level for visibility.

#### M3. No `_meta` Field in Requests

**Location**: `acp-protocol.ts` line 74 — `createRequest` doesn't include `_meta`

**Spec**: ACP Schema consistently includes `_meta` as an optional field on all request/response types:

> "The \_meta property is reserved by ACP to allow clients and agents to attach additional metadata."

**Impact**: None currently. The field is optional. But it's a potential extension point for passing Archon-specific metadata.

#### M4. `session/cancel` Response Handling

**Location**: `event-bridge.ts` lines 250-263

**Spec**: ACP Overview lists `session/cancel` as a **notification**:

> "session/cancel — Cancel ongoing operations (no response expected)."

**Implementation**: The code correctly sends `session/cancel` as a notification via `createNotification` (no `id` field). ✅

However, there's a subtle issue: the code sends the cancel notification and then immediately kills the process. If the agent hasn't finished processing the cancel, the SIGTERM may arrive before the cancel is processed. The 5-second SIGKILL fallback is reasonable.

**Status**: Correctly implemented per spec. No action needed.

#### M5. `JsonRpcRequest.id` Should Allow `string | number | null`

**Location**: `acp-protocol.ts` line 18

**Spec**: JSON-RPC 2.0 Section 4:

> "id: An identifier established by the Client that MUST contain a String, Number, or NULL value if included."

**Impact**: TypeScript type is narrower than the spec allows. Since Archon generates the requests, this is fine in practice.

---

## Positive Findings (Compliant Areas)

| Area                                                     | Status        | Notes                                                           |
| -------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| JSON-RPC 2.0 `jsonrpc: "2.0"` field                      | ✅ Correct    | Required field present in all types                             |
| Notification detection (no `id`)                         | ✅ Correct    | `parseMessage` checks `'method' in record && !('id' in record)` |
| Response/notification discrimination                     | ✅ Correct    | Rejects messages with both `result` and `method`                |
| Success response format                                  | ✅ Correct    | `{jsonrpc, id, result}`                                         |
| Error response format                                    | ✅ Correct    | `{jsonrpc, id, error: {code, message, data?}}`                  |
| Newline-delimited JSON transport                         | ✅ Correct    | `serializeMessage` appends `\n`; parser splits on `\n`          |
| `initialize` → `session/new` → `session/prompt` sequence | ✅ Correct    | Matches ACP lifecycle                                           |
| `session/cancel` as notification                         | ✅ Correct    | Uses `createNotification` (no `id`)                             |
| `session/update` params structure                        | ✅ Correct    | `{sessionId, update: {sessionUpdate, content}}`                 |
| Content block format                                     | ✅ Correct    | `{type: "text", text: "..."}` matches spec                      |
| ACP method names                                         | ✅ Correct    | All 5 methods match spec exactly                                |
| ID generator wraparound                                  | ✅ Safe       | Wraps at `Number.MAX_SAFE_INTEGER`                              |
| Line buffering for partial reads                         | ✅ Correct    | Handles fragmented stdout data                                  |
| Request timeout                                          | ✅ Reasonable | 30s timeout per request                                         |
| Process lifecycle management                             | ✅ Thorough   | SIGTERM → SIGKILL fallback, unref, cleanup                      |

---

## Summary

| Severity  | Count | Key Issues                                                                                                       |
| --------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| CRITICAL  | 1     | Version negotiation field name mismatch (`protocol_version` vs `protocolVersion`) — silently skips version check |
| IMPORTANT | 4     | `id` type restriction; `params` array not supported; missing `authenticate`; empty `clientCapabilities`          |
| MINOR     | 5     | Limited content types; limited update types; no `_meta`; cancel timing; `id` type narrower than spec             |

**Overall Assessment**: The implementation is **largely compliant** with both ACP and JSON-RPC 2.0 specifications. The one CRITICAL finding (C1) is a real bug that silently disables version negotiation due to a snake_case/camelCase field name mismatch. The IMPORTANT findings are mostly about spec completeness rather than functional bugs. The implementation correctly handles the core lifecycle, wire format, and message routing.

**Confidence Level**: High — all findings verified against primary spec sources with exact quotes and line references.
