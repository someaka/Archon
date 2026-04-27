# Documentation Gap Audit: Hermes Implementation Plan vs Official Hermes Agent Docs

**Auditor:** read-only documentation auditor
**Date:** 2026-04-27
**Plan audited:** `.hermes/plans/2026-04-27-hermes-completion-plan.md`
**Official docs sources:**

- Agent Client Protocol specification (`agentclientprotocol.com/protocol/schema` and `/overview`)
- NousResearch/hermes-agent GitHub — Issue #569 (ACP Server Mode feature request)
- NousResearch/hermes-agent — `website/docs/user-guide/features/acp.md`
- NousResearch/hermes-agent — `website/docs/developer-guide/adding-providers.md`
- NousResearch/hermes-agent — `website/docs/developer-guide/architecture.md`

---

## Methodology

1. Read the completion plan and the current provider source files under `packages/providers/src/hermes/`.
2. Cross-reference each area against the official ACP protocol spec and the Hermes Agent documentation.
3. Flag categories where the plan/source does not meet documented expectations.

---

## Gap Analysis Table

| CATEGORY                                                          | PLAN COVERS? | DOCS REQUIRE?     | GAP DESCRIPTION                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP Protocol Version Compatibility                                | Partial      | Yes               | The plan does not address ACP version negotiation. `event-bridge.ts` hardcodes `protocolVersion: 1` in the `initialize` request (line 260) and ignores the `protocol_version` returned by Hermes in `InitializeResponse`. The ACP spec states the client SHOULD disconnect if it does not support the negotiated version returned by the agent. The plan mentions no version-checking gate or fallback logic.          |
| Session Lifecycle — `session/cancel`                              | Partial      | Yes               | The code sends `session/cancel` using `createRequest()` which includes a JSON-RPC `id`. The ACP spec defines `session/cancel` as a **notification** (no response expected). This means the wire format is incorrect — it should use `createNotification()` (no `id` field). The plan does not include a fix for this.                                                                                                  |
| Session Lifecycle — `session/load`                                | No           | Optional          | The ACP spec lists `session/load` as optional (requires `loadSession` capability). Hermes Agent docs describe `session/load` for resuming existing sessions. The provider capabilities declare `sessionResume: false` and the plan does not implement `session/load`. Not a strict violation, but the docs describe it as a first-class feature.                                                                       |
| Session Lifecycle — `session/new` `cwd` absolute path             | No           | Yes               | The ACP spec mandates: "All file paths in the protocol MUST be absolute." `event-bridge.ts` passes `cwd: options.cwd` to `session/new` without checking absoluteness. A relative `cwd` would violate the protocol. The plan does not include validation.                                                                                                                                                               |
| Timeout Configuration                                             | Yes          | No explicit value | The plan adds `withFirstEventTimeout` (20-minute default) to prevent hangs. The official ACP spec does not prescribe a timeout value; it only describes JSON-RPC semantics. The timeout is an Archon-specific defensive choice and not a documentation gap per se, but the plan does not justify the 20-minute value against any documented recommendation.                                                            |
| Error Classification — JSON-RPC codes                             | No           | Yes               | The ACP spec / JSON-RPC 2.0 standard defines structured error objects with `code` and `message` (e.g. -32700 parse error, -32600 invalid request, -32602 invalid params). `error-classifier.ts` classifies entirely by substring matching of stderr text and exit codes. It does not inspect JSON-RPC `error.code` values from ACP responses. The Hermes architecture docs reference standard JSON-RPC error handling. |
| Error Classification — `Cancelled` permission outcome             | No           | Yes               | The ACP schema docs state: "When a client sends a `session/cancel` notification ... it MUST respond to all pending `session/request_permission` requests with this `Cancelled` outcome." The bridge does not implement `session/request_permission` handling, so cancellation of pending permission requests is impossible.                                                                                            |
| Binary Verification Procedures                                    | Yes          | No                | The plan (E16) adds `verifyHermesBinary()` which runs `${binary} --version` with a 5-second timeout. The official Hermes docs describe launching via `hermes acp` and `pip install -e '.[acp]'`. There is no documented requirement for a `--version` pre-flight check. This is an Archon implementation detail, not a docs requirement, but it introduces a procedure not mentioned in any official doc.              |
| Missing `ContentBlock` types                                      | No           | Yes               | The ACP spec baseline requires agents to support `ContentBlock::Text` and `ContentBlock::ResourceLink`, and optionally `Resource`. `acp-protocol.ts` only defines `TextContentBlock`. The bridge sends only `Text` blocks in `session/prompt`. No `ResourceLink` or `Resource` support is planned.                                                                                                                     |
| Missing `session/update` event types                              | No           | Yes               | The ACP spec `session/update` notifications include: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, and `mode_changes`. The bridge only handles `agent_message_chunk` and `agent_thought_chunk`. Tool-call events are silently dropped.                                                                                                           |
| Missing Client methods (`fs/*`, `terminal/*`)                     | No           | Yes               | The ACP client interface lists optional but standardized methods: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`. Hermes in ACP mode may request these from the client. The bridge does not implement incoming request handling for any client-side methods.                                                           |
| Missing `authenticate` flow                                       | No           | Optional          | The ACP spec lists `authenticate` as an optional agent method. If Hermes advertises an auth method in `InitializeResponse`, the client must call `authenticate` before `session/new`. The bridge never checks `auth_methods` and never sends `authenticate`.                                                                                                                                                           |
| Missing capability checks after `initialize`                      | No           | Recommended       | The bridge ignores `agent_capabilities` returned by Hermes in `InitializeResponse` (e.g. `loadSession`, `promptCapabilities`, `sessionCapabilities`). It should gate optional behaviours on these flags. The plan does not address parsing or acting on returned capabilities.                                                                                                                                         |
| `session/set_mode` / `session/list` / `session/set_config_option` | No           | Optional          | These are optional ACP methods. While not strictly required, the ACP spec defines them as standard capabilities. The plan and source do not mention them. Hermes Agent docs describe `session/list`, `load`, `resume`, and `fork` as part of ACP session management.                                                                                                                                                   |
| ACP `mcpServers` passthrough                                      | Partial      | No                | `session/new` hardcodes `mcpServers: []`. The Hermes ACP docs say ACP mode "inherits the currently configured provider and credentials" but do not require MCP server passthrough. This is not a gap against official docs, though it is a limitation.                                                                                                                                                                 |
| INSTALL_INSTRUCTIONS accuracy                                     | Yes          | Yes               | `binary-resolver.ts` recommends `pip install hermes-cli`. The official Hermes ACP docs recommend `pip install -e '.[acp]'` to install the ACP extra. The plan/instructions do not match the official installation command.                                                                                                                                                                                             |

---

## Critical Gaps (must-fix before claiming ACP compliance)

1. **`session/cancel` sent as request instead of notification**
   - **File:** `packages/providers/src/hermes/event-bridge.ts` (lines 208-216)
   - **Fix:** Replace `createRequest('session/cancel', ...)` with `createNotification('session/cancel', ...)` and remove the cast to `Record<string, unknown>`.

2. **`protocolVersion` hardcoded and not validated**
   - **File:** `packages/providers/src/hermes/event-bridge.ts` (line 260)
   - **Fix:** Parse `InitializeResponse.protocol_version`, assert it is supported, and disconnect with a clear error if not.

3. **`cwd` not validated as absolute before `session/new`**
   - **File:** `packages/providers/src/hermes/event-bridge.ts` (line 268)
   - **Fix:** Pre-flight check `path.isAbsolute(options.cwd)`; reject or convert to absolute.

4. **JSON-RPC error codes ignored in error classification**
   - **File:** `packages/providers/src/hermes/error-classifier.ts`
   - **Fix:** Inspect `JsonRpcError.error.code` and map standard JSON-RPC / ACP error codes into classification logic.

---

## Summary

The completion plan is focused on three polish items (binary verification, dead-code removal, and first-event timeout). It does **not** address several ACP protocol-compliance requirements found in the official specification and Hermes Agent documentation:

- **Protocol wire-format error:** `session/cancel` must be a notification (no `id`).
- **Version negotiation is skipped.**
- **Absolute-path requirement for `cwd` is unenforced.**
- **Error classification ignores JSON-RPC structured error codes.**
- **Many optional but standard ACP features are absent:** `session/load`, `authenticate`, `session/request_permission`, `fs/*`, `terminal/*`, tool-call updates, capability-driven gating, and `ResourceLink` content blocks.

These gaps mean the provider works for basic `session/new` → `session/prompt` → `session/update` streaming, but it is not fully ACP-compliant and will fail or misbehave if Hermes exercises any spec-mandated optional capabilities.
