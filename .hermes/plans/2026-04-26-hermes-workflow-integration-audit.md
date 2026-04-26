# Hermes Workflow Engine Integration Audit

**Date:** 2026-04-26  
**Auditor:** Hermes Agent (subagent)  
**Scope:** `packages/providers/src/hermes` vs `packages/providers/src/{claude,codex,community/pi}` and `packages/workflows/src/dag-executor.ts`

---

## 1. Executive Summary

Hermes is registered as a **built-in** provider alongside Claude and Codex, but its workflow integration is **materially thinner** than every other provider. The provider implements the `IAgentProvider` contract and passes the existing integration tests, yet it **does not translate `nodeConfig` fields into ACP requests**, **does not surface capability warnings from the provider itself**, and **declares several capability flags without corresponding runtime wiring**. Compared with Claude (full `applyNodeConfig`), Codex (structured output + model fallback), and Pi (thinking/tools/skills/env translation), Hermes is essentially a **pass-through spawn-and-bridge** with minimal workflow-aware behavior.

---

## 2. Provider Architecture Comparison

| Dimension                     | Claude                                                                                                                                                 | Codex                                                                 | Pi                                                                                            | Hermes                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **SDK / transport**           | `@anthropic-ai/claude-agent-sdk` (in-process)                                                                                                          | `@openai/codex-sdk` (in-process)                                      | `@mariozechner/pi-coding-agent` (in-process)                                                  | `child_process.spawn('hermes', ['acp'])` (subprocess, ACP JSON-RPC) |
| **Session model**             | Persistent (resume + fork)                                                                                                                             | Persistent (thread resume)                                            | Persistent (session JSONL files)                                                              | Stateless per invocation                                            |
| **`nodeConfig` translation**  | Full `applyNodeConfig` (tools, hooks, MCP, skills, agents, effort, thinking, sandbox, betas, output_format, maxBudgetUsd, systemPrompt, fallbackModel) | Partial (output_format via `buildTurnOptions`)                        | Full (thinking, tools, skills, systemPrompt, extensions, structured output best-effort)       | **None** — only `systemPrompt` is forwarded to ACP                  |
| **Capability warnings**       | Yielded as `system` chunks from `applyNodeConfig`                                                                                                      | Minimal                                                               | Yielded as `system` chunks from `resolvePiThinkingLevel`, `resolvePiTools`, `resolvePiSkills` | **None** — relies entirely on dag-executor static check             |
| **Retry logic**               | `MAX_SUBPROCESS_RETRIES` with exponential back-off                                                                                                     | `MAX_SUBPROCESS_RETRIES` with exponential back-off                    | None (fail-fast on auth)                                                                      | **None**                                                            |
| **Error classification**      | `classifySubprocessError` (rate_limit, auth, crash)                                                                                                    | `classifyAndEnrichCodexError` (rate_limit, auth, crash, model_access) | Auth fail-fast, model fallback message                                                        | Spawn / exit / signal errors surfaced by event-bridge               |
| **Structured output**         | SDK-enforced (`outputFormat`)                                                                                                                          | SDK-enforced (`outputSchema`)                                         | Best-effort prompt engineering + parse in bridge                                              | **Not implemented** (`structuredOutput: false`)                     |
| **Tool restrictions**         | `allowed_tools` / `denied_tools` → SDK options                                                                                                         | Not supported                                                         | `allowed_tools` / `denied_tools` → Pi tool filter                                             | **Not implemented**                                                 |
| **Skills**                    | Wrapped as inline `AgentDefinition`                                                                                                                    | Not supported                                                         | Resolved to `additionalSkillPaths`                                                            | Declared `true` but **no wiring** in provider                       |
| **MCP**                       | Full config load + env expansion + wildcard tools                                                                                                      | Not supported                                                         | Not supported                                                                                 | Declared `false` (honest)                                           |
| **Hooks**                     | YAML → SDK `HookCallbackMatcher`                                                                                                                       | Not supported                                                         | Not supported                                                                                 | Declared `false` (honest)                                           |
| **Agents**                    | Inline `agents` pass-through                                                                                                                           | Not supported                                                         | Not supported                                                                                 | Declared `false` (honest)                                           |
| **Cost control**              | `maxBudgetUsd` → SDK option                                                                                                                            | Not supported                                                         | Not supported                                                                                 | Declared `false` (honest)                                           |
| **Effort / thinking control** | `effort` / `thinking` → SDK options                                                                                                                    | Not supported                                                         | `thinking` / `effort` → `thinkingLevel`                                                       | Declared `false` (honest)                                           |
| **Sandbox**                   | `sandbox` → SDK option                                                                                                                                 | Hard-coded `danger-full-access`                                       | Not supported                                                                                 | Declared `false` (honest)                                           |
| **Fallback model**            | `fallbackModel` → SDK option                                                                                                                           | `CODEX_MODEL_FALLBACKS` + custom message                              | Not supported                                                                                 | Declared `true` but **no runtime wiring**                           |
| **Env injection**             | `options.env` merged into subprocess env                                                                                                               | `buildCodexEnv` merges request env                                    | `requestOptions.env` via bash spawn hook + `piConfig.env` into `process.env`                  | `session.env` merged into spawn env (honest)                        |
| **Abort signal**              | `AbortController` forwarded to SDK                                                                                                                     | `AbortController` forwarded to SDK                                    | `AbortController` forwarded to bridge                                                         | `SIGTERM` + `SIGKILL` fallback in bridge                            |
| **First-event timeout**       | `withFirstMessageTimeout` (60 s default)                                                                                                               | Not implemented                                                       | Not implemented                                                                               | **Not implemented**                                                 |
| **Binary resolution**         | `resolveClaudeBinaryPath` (env → config → autodetect)                                                                                                  | `resolveCodexBinaryPath` (env → config → PATH)                        | N/A (npm package)                                                                             | `resolveHermesBinary` (env → config → autodetect → PATH)            |

---

## 3. Missing Capabilities (Hermes-specific)

### 3.1 `nodeConfig` translation layer

**Gap:** Hermes `sendQuery` never inspects `options.nodeConfig`.  
**Impact:** Workflow YAML fields (`allowed_tools`, `denied_tools`, `skills`, `agents`, `effort`, `thinking`, `sandbox`, `betas`, `output_format`, `maxBudgetUsd`, `fallbackModel`) are silently ignored even when the underlying Hermes CLI might support analogous flags.  
**Reference:** Claude `applyNodeConfig` (~170 lines); Pi `resolvePiThinkingLevel`, `resolvePiTools`, `resolvePiSkills`.

### 3.2 `skills: true` without wiring

**Gap:** `HERMES_CAPABILITIES.skills === true`, yet `sendQuery` does not read `nodeConfig.skills` and does not pass skill paths to the ACP session.  
**Impact:** Workflow authors see no capability warning (because the flag is `true`), but skills are never loaded.  
**Reference:** Claude wraps skills in an `AgentDefinition`; Pi resolves skill names to `additionalSkillPaths`.

### 3.3 `fallbackModel: true` without wiring

**Gap:** Capability flag is `true`, but `sendQuery` does not read `options.fallbackModel` or `nodeConfig.fallbackModel`.  
**Impact:** The fallback model field is silently ignored.  
**Reference:** Claude passes `fallbackModel` to SDK `Options`; Codex has `CODEX_MODEL_FALLBACKS`.

### 3.4 Structured output

**Gap:** `structuredOutput: false`. While honest, there is no best-effort implementation (unlike Pi, which appends a JSON schema instruction).  
**Impact:** Workflows using `output_format` on Hermes nodes will always trigger the `dag.structured_output_missing` warning and may break downstream `$node.output.field` references.  
**Recommendation:** Either implement prompt-level schema injection + JSON parse in the bridge (Pi pattern), or keep the flag `false` and document the limitation.

### 3.5 Retry logic

**Gap:** No retry loop in `HermesProvider.sendQuery`.  
**Impact:** Transient spawn failures (EACCES, EMFILE) or Hermes CLI crashes fail the node immediately.  
**Reference:** Claude and Codex both implement `MAX_SUBPROCESS_RETRIES = 3` with exponential back-off.

### 3.6 First-event timeout

**Gap:** No timeout on the first ACP response.  
**Impact:** If `hermes acp` hangs after spawn, the workflow node will block until the global `idle_timeout` (default 10 min) fires.  
**Reference:** Claude `withFirstMessageTimeout` (default 60 s).

### 3.7 Token / cost / usage metadata

**Gap:** The ACP bridge emits a `result` chunk with `sessionId` and `stopReason`, but never populates `tokens`, `cost`, `numTurns`, or `modelUsage`.  
**Impact:** Workflow run records lack cost/usage data for Hermes nodes; dashboards and cost-tracking features will show blanks.  
**Reference:** Claude normalizes `usage` from SDK result events; Codex extracts `usage` from `TurnCompletedEvent`.

### 3.8 Tool call / result chunking

**Gap:** The event-bridge only handles `agent_message_chunk` and `agent_thought_chunk`. It does not map ACP tool-use events to Archon `tool` / `tool_result` chunks.  
**Impact:** If Hermes CLI invokes tools via ACP, the workflow executor will not render tool cards or persist tool events.  
**Reference:** Claude normalizes `tool_use` content blocks; Codex maps `command_execution`, `mcp_tool_call`, etc.

---

## 4. Incorrect / Questionable Flags

| Flag               | Value   | Assessment                                                                                                           |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `skills`           | `true`  | **Over-declared.** No runtime wiring exists. Should be `false` until skill paths are passed through ACP.             |
| `fallbackModel`    | `true`  | **Over-declared.** No runtime wiring exists. Should be `false` until `fallbackModel` is forwarded to the CLI or ACP. |
| `structuredOutput` | `false` | **Correctly conservative**, but creates a gap vs. Pi which implements best-effort support.                           |
| `sessionResume`    | `false` | **Correct.** Hermes ACP is stateless per invocation.                                                                 |
| `mcp`              | `false` | **Correct.** No MCP config loading in Hermes provider.                                                               |
| `hooks`            | `false` | **Correct.** No hook translation in Hermes provider.                                                                 |
| `agents`           | `false` | **Correct.** No inline agent pass-through.                                                                           |
| `toolRestrictions` | `false` | **Correct.** No tool filtering wired.                                                                                |
| `costControl`      | `false` | **Correct.** No `maxBudgetUsd` forwarding.                                                                           |
| `effortControl`    | `false` | **Correct.** No `effort`/`thinking` forwarding.                                                                      |
| `thinkingControl`  | `false` | **Correct.** No `thinking` forwarding.                                                                               |
| `sandbox`          | `false` | **Correct.** No sandbox option forwarding.                                                                           |
| `envInjection`     | `true`  | **Correct.** `session.env` is merged into spawn env.                                                                 |

---

## 5. Integration Gaps in `dag-executor.ts`

### 5.1 Capability warning logic is static only

The executor checks `getProviderCapabilities(provider)` and warns when a node sets a field the provider does not support. This works for **false** flags, but when a flag is **true** (e.g., Hermes `skills`, `fallbackModel`) the executor assumes the provider will handle it. Because Hermes declares these true without wiring, the executor **never warns** and the feature silently disappears.

**Recommendation:** Either lower the flags to `false` (honest under-declaration) or add runtime wiring.

### 5.2 No Hermes-specific `nodeConfig` passthrough

The executor builds a universal `NodeConfig` object (line ~437) and passes it to every provider. Claude and Pi actively consume it; Hermes ignores it. There is no executor-level fallback that, for example, converts `nodeConfig.output_format` into a CLI flag when the provider is Hermes.

**Recommendation:** Add an `applyNodeConfig` equivalent in `packages/providers/src/hermes/provider.ts` that translates supported fields into ACP request parameters or CLI arguments.

### 5.3 Test coverage is mock-heavy

`hermes-integration.test.ts` and `hermes-e2e.test.ts` use fully mocked `sendQuery` generators. They verify that the executor **calls** the Hermes provider with the right `provider` ID, but they do not exercise real ACP stdio parsing, error handling, or `nodeConfig` translation.

**Recommendation:** Add a provider-level integration test that spawns a fake `hermes` binary (similar to `provider.test.ts`) but exercises `nodeConfig` fields and verifies capability warnings.

---

## 6. Positive Findings

1. **ACP bridge is robust.** `event-bridge.ts` correctly handles abort signals, process exit/error events, zombie-process prevention (`unref`, `SIGKILL` fallback), and always emits a terminal `result` chunk. This matches the reliability patterns seen in Claude/Codex.
2. **Config parsing is defensive.** `parseHermesConfig` silently drops invalid fields (matching Claude/Codex/Pi conventions) and validates URLs.
3. **Binary resolver follows the established pattern.** `resolveHermesBinary` mirrors `resolveClaudeBinaryPath` and `resolveCodexBinaryPath` (env → config → autodetect → PATH).
4. **Registration is idempotent and correct.** `registerHermesProvider()` follows the Phase 2 community-provider contract and is called from `registerBuiltinProviders()`.
5. **Model compatibility is permissive.** `isHermesModelCompatible` returns `true` for all models, which is appropriate because Hermes CLI resolves its own backend.

---

## 7. Recommendations (Prioritized)

| Priority | Item                                                                                                                                      | Effort    | Rationale                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------- |
| **P0**   | Set `skills: false` and `fallbackModel: false` in `HERMES_CAPABILITIES` until wired.                                                      | 1 line    | Prevents silent feature loss.       |
| **P0**   | Add `nodeConfig` translation in `HermesProvider.sendQuery` (at minimum `output_format`, `systemPrompt`, `maxBudgetUsd`, `fallbackModel`). | ~50 lines | Brings Hermes to parity with Codex. |
| **P1**   | Implement retry loop (`MAX_SUBPROCESS_RETRIES = 3`) in `sendQuery`.                                                                       | ~20 lines | Matches Claude/Codex reliability.   |
| **P1**   | Add first-event timeout wrapper around `bridgeHermesSession`.                                                                             | ~15 lines | Prevents indefinite hangs.          |
| **P1**   | Populate `tokens`, `cost`, `modelUsage` on the terminal `result` chunk if/when ACP exposes them.                                          | ~10 lines | Needed for cost tracking.           |
| **P2**   | Implement best-effort structured output (prompt schema injection + JSON parse in bridge).                                                 | ~30 lines | Closes gap with Pi.                 |
| **P2**   | Map ACP tool-use notifications to `tool` / `tool_result` chunks.                                                                          | ~40 lines | Enables tool rendering in UI.       |
| **P2**   | Add integration test that exercises `nodeConfig` fields end-to-end with a mock Hermes binary.                                             | ~80 lines | Prevents regressions.               |

---

## 8. Files Audited

- `packages/providers/src/hermes/capabilities.ts`
- `packages/providers/src/hermes/provider.ts`
- `packages/providers/src/hermes/config.ts`
- `packages/providers/src/hermes/event-bridge.ts`
- `packages/providers/src/hermes/acp-protocol.ts`
- `packages/providers/src/hermes/acp-bridge.ts`
- `packages/providers/src/hermes/session-resolver.ts`
- `packages/providers/src/hermes/binary-resolver.ts`
- `packages/providers/src/hermes/model-ref.ts`
- `packages/providers/src/hermes/options-translator.ts`
- `packages/providers/src/hermes/registration.ts`
- `packages/providers/src/hermes/index.ts`
- `packages/providers/src/hermes/provider.test.ts`
- `packages/providers/src/hermes/config.test.ts`
- `packages/providers/src/hermes/event-bridge.test.ts`
- `packages/providers/src/claude/provider.ts`
- `packages/providers/src/codex/provider.ts`
- `packages/providers/src/community/pi/provider.ts`
- `packages/providers/src/types.ts`
- `packages/providers/src/registry.ts`
- `packages/providers/src/index.ts`
- `packages/workflows/src/dag-executor.ts`
- `packages/workflows/src/hermes-integration.test.ts`
- `packages/workflows/src/hermes-e2e.test.ts`

---

_End of audit._
