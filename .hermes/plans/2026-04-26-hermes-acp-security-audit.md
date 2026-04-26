# Hermes ACP Protocol & Security Audit

**Date:** 2026-04-26  
**Scope:** All Hermes ACP protocol files under `packages/providers/src/hermes/`  
**Auditor:** CLI AI Agent (Hermes ACP Protocol & Security Audit)  
**Deliverable:** Security, dead code, magic string, mutable state, and pattern deviation findings with severity ratings and remediation recommendations.

---

## 1. Executive Summary

The Hermes ACP (Agent Client Protocol) implementation is a JSON-RPC 2.0 stdio transport layer that bridges Archon to the Hermes CLI (`hermes acp`). The codebase is relatively small (~2,500 LOC across 14 files) and generally well-structured, but several security, maintainability, and pattern-consistency issues were identified. The most critical finding is **untrusted JSON-RPC message parsing without schema validation** in `event-bridge.ts`, which could allow malformed or malicious ACP messages to crash the bridge or emit unexpected chunks. Other notable issues include mutable module-level state (the `nextId` counter), magic string/version literals, and deviations from patterns used in Claude/Codex providers (e.g., no retry logic, no first-event timeout, no structured error classification).

**Severity Distribution:**

- Critical: 1
- High: 2
- Medium: 5
- Low: 6
- Info: 4

---

## 2. File Inventory

| File                         | Lines | Role                                                      |
| ---------------------------- | ----- | --------------------------------------------------------- |
| `acp-protocol.ts`            | 126   | JSON-RPC types, builders, parser                          |
| `acp-protocol.test.ts`       | 51    | Unit tests for protocol primitives                        |
| `acp-bridge.ts`              | 52    | Request sequence builder (legacy helper)                  |
| `acp-bridge.test.ts`         | 52    | Unit tests for request builder                            |
| `event-bridge.ts`            | 433   | Core ACP bridge (spawn I/O, async queue, chunk streaming) |
| `event-bridge.test.ts`       | 507   | Unit tests for event bridge                               |
| `provider.ts`                | 127   | `HermesProvider` class (spawn + delegate to bridge)       |
| `provider.test.ts`           | 347   | Unit tests for provider                                   |
| `session-resolver.ts`        | 67    | Session context resolver (cwd, env)                       |
| `session-resolver.test.ts`   | 111   | Unit tests for session resolver                           |
| `binary-resolver.ts`         | 101   | Hermes CLI binary path resolver                           |
| `binary-resolver.test.ts`    | 110   | Unit tests for binary resolver                            |
| `config.ts`                  | 47    | Config parser (`parseHermesConfig`)                       |
| `config.test.ts`             | 131   | Unit tests for config parser                              |
| `model-ref.ts`               | 82    | Model reference parser                                    |
| `model-ref.test.ts`          | 111   | Unit tests for model ref                                  |
| `options-translator.ts`      | 91    | Model/provider/endpoint resolution helpers                |
| `options-translator.test.ts` | 105   | Unit tests for options translator                         |
| `capabilities.ts`            | 38    | Capability flags declaration                              |
| `registration.ts`            | 25    | Provider registry hook                                    |
| `index.ts`                   | 16    | Public API re-exports                                     |

---

## 3. Critical Findings

### 3.1 [CRITICAL] Untrusted JSON-RPC Message Parsing Without Schema Validation

**File:** `event-bridge.ts` (lines 175–208)  
**File:** `acp-protocol.ts` (lines 77–90)

**Issue:** `parseMessage()` in `acp-protocol.ts` only checks that `jsonrpc === '2.0'` and that the object has `method` (for notifications) or `result`/`error` (for responses). It does **not** validate:

- That `id` is a number.
- That `method` is a known/expected string.
- That `params` is an object (not an array, string, etc.).
- That `result` or `error` have the expected shapes.

In `event-bridge.ts`, the `stdout.on('data', ...)` handler casts `msg.params` to `SessionUpdateParams` via `as unknown as SessionUpdateParams` (line 194) and then accesses `params.update.sessionUpdate` and `params.update.content.text` without any runtime validation. A malicious or buggy Hermes CLI could send:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "x",
    "update": { "sessionUpdate": "agent_message_chunk", "content": null }
  }
}
```

This would cause `update.content.text` to throw a TypeError (`Cannot read properties of null`), crashing the `stdout` event handler and leaving the bridge hung (pending request never resolves, queue never closes).

**Impact:** Denial of service for the Hermes query; unhandled exception in Node.js event emitter context may also crash the Archon process depending on `uncaughtException` handling.

**Remediation:**

1. Add a runtime validator function `isSessionUpdateParams(value: unknown): value is SessionUpdateParams` that recursively checks shapes.
2. In `event-bridge.ts`, guard the cast with `if (!isSessionUpdateParams(params)) { getLog().warn(...); continue; }`.
3. Similarly validate `initialize` and `session/new` responses before extracting `sessionId`.

**Reference:** See how Claude provider validates SDK event types with `switch (itemType)` and explicit property checks (`item.text`, `item.command`, etc.) in `codex/provider.ts` lines 244–388.

---

## 4. High Findings

### 4.1 [HIGH] Mutable Module-Level State (`nextId` Counter)

**File:** `acp-protocol.ts` (lines 36, 39–41, 49)

**Issue:** The `nextId` variable is a module-level `let` mutated by `createRequest()`. In a concurrent environment (e.g., multiple `sendQuery()` calls in parallel, or tests running in parallel), the auto-incrementing ID is **not** thread-safe. Two requests could get the same ID, causing the response resolver in `event-bridge.ts` to match the wrong response.

**Impact:** Response mis-routing, potential silent data corruption (wrong sessionId used for prompt), or bridge hang if the mismatched response never arrives.

**Remediation:** Replace module-level `nextId` with an `AcpIdGenerator` class or a closure-scoped counter passed into `createRequest`. The `HermesProvider` or `bridgeHermesSession` should own the counter instance. `resetAcpIdCounter()` should be removed or scoped to test fixtures only.

**Reference:** Claude/Codex providers do not maintain global mutable request IDs; they rely on SDK-generated identifiers or per-call UUIDs.

---

### 4.2 [HIGH] No Input Validation on `sessionId` Extraction from Untrusted Response

**File:** `event-bridge.ts` (lines 353–356)

**Issue:** After `session/new`, the bridge extracts `sessionId` with:

```ts
sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
```

There is no check that `sessionId` is a non-empty string. If Hermes returns `sessionId: null`, `sessionId: 123`, or omits it, the bridge continues and later sends `sessionId: undefined` in `session/prompt` and `session/cancel`. The `abortSignal` handler also guards `sessionId` with `if (sessionId)` (line 289), which is fine, but the prompt request itself uses `sessionId` unconditionally (line 370), sending `<pending>` or `undefined` to Hermes.

**Impact:** Hermes may reject the prompt with an opaque error; Archon user sees a generic "ACP request failed" message.

**Remediation:** After extracting `sessionId`, assert `typeof sessionId === 'string' && sessionId.length > 0`; otherwise throw a descriptive error.

---

## 5. Medium Findings

### 5.1 [MEDIUM] Magic Strings / Version Literals

**File:** `acp-protocol.ts` (line 5, 27, 48, 56)  
**File:** `event-bridge.ts` (lines 341–344, 349, 369)  
**File:** `acp-bridge.ts` (lines 39–42)

**Issue:** The string `'2.0'` (JSON-RPC version) and `'initialize'`, `'session/new'`, `'session/prompt'`, `'session/cancel'`, `'session/update'` method names are repeated as raw literals across multiple files. The version `'0.3.9'` (clientInfo version) is hardcoded in both `event-bridge.ts` and `acp-bridge.ts`.

**Impact:** Drift risk when the protocol version or Archon version changes. Easy to miss updates in one file.

**Remediation:**

- Export constants from `acp-protocol.ts`:
  ```ts
  export const JSONRPC_VERSION = '2.0';
  export const ACP_METHOD_INIT = 'initialize';
  export const ACP_METHOD_SESSION_NEW = 'session/new';
  export const ACP_METHOD_SESSION_PROMPT = 'session/prompt';
  export const ACP_METHOD_SESSION_CANCEL = 'session/cancel';
  export const ACP_NOTIFICATION_SESSION_UPDATE = 'session/update';
  export const ACP_AGENT_MESSAGE_CHUNK = 'agent_message_chunk';
  export const ACP_AGENT_THOUGHT_CHUNK = 'agent_thought_chunk';
  ```
- Read the Archon version from `package.json` or a build-time generated constant instead of hardcoding `'0.3.9'`.

---

### 5.2 [MEDIUM] `acp-bridge.ts` is Dead / Unused Code

**File:** `acp-bridge.ts` (all 52 lines)

**Issue:** `buildAcpRequests()` constructs a static request sequence, but `event-bridge.ts` does **not** import or use it. Instead, `bridgeHermesSession` manually calls `createRequest()` for each step (lines 341, 349, 369). The `acp-bridge.test.ts` tests this unused function. The comment in `acp-bridge.ts` says "Unlike the removed `buildHermesCliArgs`..." indicating this file may be a leftover from an earlier refactor.

**Impact:** Maintenance burden, confusion for new developers, test runtime overhead.

**Remediation:** Delete `acp-bridge.ts` and `acp-bridge.test.ts`. If the static request builder is desired in the future, it should be consumed by `event-bridge.ts` or `provider.ts`.

---

### 5.3 [MEDIUM] No Retry Logic for Transient ACP Failures

**File:** `event-bridge.ts` (lines 339–406)  
**File:** `provider.ts` (lines 75–126)

**Issue:** Unlike Claude (`MAX_SUBPROCESS_RETRIES = 3`, `RETRY_BASE_DELAY_MS = 2000`) and Codex providers, Hermes has **no retry logic** for transient failures (e.g., `hermes acp` process crash, EPIPE on stdin, or non-zero exit). The bridge emits a single terminal `result` chunk with `isError: true` and throws.

**Impact:** Flaky Hermes CLI installations or transient resource issues cause workflow nodes to fail permanently, even though a retry might succeed.

**Remediation:** Add a `retryCount` parameter to `sendQuery` (default 0 or 1) and wrap the `bridgeHermesSession` call in a retry loop with exponential backoff, similar to Claude/Codex patterns. Ensure `abortSignal` is respected across retries.

---

### 5.4 [MEDIUM] No First-Event Timeout / Hang Detection

**File:** `event-bridge.ts` (lines 339–406)

**Issue:** Claude provider implements `withFirstMessageTimeout()` (60 s default, configurable via `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS`) to detect subprocess hangs. Hermes has no equivalent. If `hermes acp` spawns successfully but never writes to stdout (e.g., deadlock, missing binary), the `sendRequest()` promise for `initialize` will hang forever, and the consumer async generator will never yield.

**Impact:** Workflow node hangs indefinitely, potentially blocking the entire DAG executor until the process-level timeout (if any) fires.

**Remediation:** Wrap `sendRequest()` in a `Promise.race` with a configurable timeout (e.g., `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS`, default 60 s). On timeout, kill the child process and emit a terminal error chunk.

---

### 5.5 [MEDIUM] `process.env` Spread in `session-resolver.ts` Loses Type Safety

**File:** `session-resolver.ts` (line 53)

**Issue:** `const env: Record<string, string> = { ...process.env } as Record<string, string>;` casts `process.env` (which may contain `undefined` values) to `Record<string, string>`. If a parent process has an env var explicitly set to `undefined`, the spread will include it as `undefined`, violating the `Record<string, string>` contract. This is later passed to `child_process.spawn` `env`, which expects `string | undefined` anyway, but the type lie is misleading.

**Impact:** Potential runtime issues if downstream code (e.g., Hermes CLI) assumes all env values are strings. Type safety degradation.

**Remediation:** Use an explicit filter:

```ts
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]): v is string => typeof v === 'string')
);
```

---

## 6. Low Findings

### 6.1 [LOW] `createRequest` Used for Fire-and-Forget `session/cancel`

**File:** `event-bridge.ts` (lines 290–299)

**Issue:** The abort handler calls `createRequest('session/cancel', ...)` and writes it to stdin. `createRequest` increments `nextId` and includes an `id` field, but `session/cancel` is documented as a notification (fire-and-forget). The Hermes server may treat it as a request and expect a response, or it may ignore the `id`. Either way, the `nextId` counter is advanced unnecessarily, and the pending-request resolver is not set up for this "request", so any response would be dropped.

**Impact:** Minor ID skew; potential protocol confusion if Hermes ever sends a response to `session/cancel`.

**Remediation:** Use `createNotification('session/cancel', { sessionId })` instead of `createRequest`.

---

### 6.2 [LOW] `sigkillTimeout` is Not Cleared on Normal Process Exit

**File:** `event-bridge.ts` (lines 285, 302–305, 422–424)

**Issue:** The `sigkillTimeout` is only cleared in the consumer `finally` block (line 422). If the abort signal fires and then the process exits normally before the 5 s timer, the timer still fires and calls `childProcess.kill('SIGKILL')`. `childProcess.kill` on an already-dead process throws an error (caught by the empty `catch` in the `finally` block at line 427), but the timer remains in memory until it fires.

**Impact:** Minor resource leak (one timer per aborted query). No functional bug because the `catch` suppresses the error.

**Remediation:** Clear `sigkillTimeout` in the `exit` event handler as well, or use `childProcess.once('exit', ...)` to clear it.

---

### 6.3 [LOW] `lineBuffer` Retains Trailing Newline Data Indefinitely

**File:** `event-bridge.ts` (line 157, 167–169)

**Issue:** `lineBuffer` accumulates incomplete lines from `stdout.on('data')`. If Hermes sends a very long line without a newline (e.g., a megabyte of JSON), `lineBuffer` grows unbounded in memory. There is no max-line-length or max-buffer-size check.

**Impact:** Memory exhaustion if Hermes CLI is compromised or buggy.

**Remediation:** Add a `MAX_LINE_BUFFER_LENGTH` constant (e.g., 1 MB). If `lineBuffer.length > MAX_LINE_BUFFER_LENGTH`, log a warning, discard the buffer, and emit an error chunk.

---

### 6.4 [LOW] `terminalEmitted` is Not Reset Between Queries

**File:** `event-bridge.ts` (line 149)

**Issue:** `terminalEmitted` is a local `let` inside `bridgeHermesSession`, so it is technically per-query. However, the comment says "Track whether we've already emitted a terminal result chunk so we don't emit duplicates." The duplicate-prevention logic is correct, but there is no test verifying that two rapid `exit` events (e.g., code + signal) do not emit two terminal chunks. The existing tests cover `error` + `exit` separately, but not both firing in the same microtask.

**Impact:** Low — Node.js `ChildProcess` typically emits only one of `exit` or `error`, but edge cases exist.

**Remediation:** Add a test in `event-bridge.test.ts` that emits both `error` and `exit` in sequence and asserts only one terminal `result` chunk is yielded.

---

### 6.5 [LOW] `INSTALL_INSTRUCTIONS` Constant in `binary-resolver.ts` Contains Hardcoded Version

**File:** `binary-resolver.ts` (lines 35–50)

**Issue:** The install instructions string includes `pip install hermes-cli` and a GitHub URL. These are external dependencies whose installation methods may change. The string is not localized and is thrown as part of an error message in compiled builds.

**Impact:** Stale documentation in error messages; poor user experience if the install method changes.

**Remediation:** Move the instructions to a markdown doc file and reference it in the error message (e.g., `See https://archon.diy/docs/reference/troubleshooting-hermes`).

---

### 6.6 [LOW] `isHermesModelCompatible` Always Returns `true`

**File:** `model-ref.ts` (lines 80–82)

**Issue:** The registry-level `isModelCompatible` check unconditionally returns `true`. While this is intentional ("Archon's workflow loader should not gatekeep models that Hermes itself can handle"), it means a workflow with `model: claude-sonnet` will be accepted for a Hermes node, even though Hermes may not support it. The dag-executor relies on `isModelCompatible` for validation warnings.

**Impact:** Poor user experience — workflow validation passes but the query fails at runtime with an opaque Hermes error.

**Remediation:** Implement a lightweight check: return `true` for `model === 'hermes'` or `model.startsWith('hermes:')`, and `false` for known non-Hermes prefixes (`claude-`, `gpt-`, etc.). Keep the comment explaining that Hermes resolves its own models, but give Archon the ability to warn on obvious mismatches.

---

## 7. Info / Style Findings

### 7.1 [INFO] Missing `tool` and `tool_result` Chunk Support

**File:** `event-bridge.ts` (lines 196–206)

**Issue:** The `session/update` notification handler only recognizes `agent_message_chunk` and `agent_thought_chunk`. If Hermes ever emits tool-use updates (e.g., `agent_tool_call_chunk`, `agent_tool_result_chunk`), they will be silently ignored.

**Remediation:** Document the expected update types in a comment and add an `else` branch that logs an unknown update type at `debug` level.

---

### 7.2 [INFO] `ContentBlock` Union is Under-Utilized

**File:** `acp-protocol.ts` (lines 95–100)

**Issue:** `ContentBlock` is currently only `TextContentBlock`. The ACP protocol may eventually support image, file, or tool-result blocks. The union is ready for extension, but there is no runtime discriminator beyond `type: 'text'`.

**Remediation:** No action needed now; the shape is forward-compatible.

---

### 7.3 [INFO] `acp-protocol.ts` Lacks `resetAcpIdCounter` Test Coverage for Edge Cases

**File:** `acp-protocol.test.ts` (all 51 lines)

**Issue:** Tests cover `createRequest`, `createNotification`, `serializeMessage`, and `parseMessage`, but do not test `resetAcpIdCounter` or concurrent ID generation.

**Remediation:** Add a test that calls `resetAcpIdCounter(42)`, creates a request, and asserts `id === 42`. Add a test simulating two parallel `createRequest` calls to document the non-thread-safe behavior.

---

### 7.4 [INFO] `provider.test.ts` Mocks `child_process.spawn` Globally

**File:** `provider.test.ts` (lines 17–25)

**Issue:** The test uses `mock.module('child_process', ...)` to replace the entire module. This is a broad mock that could affect other tests if not carefully scoped. Bun's `mock.module` is file-scoped, so this is safe in isolation, but it sets a pattern that may be copy-pasted into tests where broader mocking causes issues.

**Remediation:** Document in a code comment that `mock.module` is Bun-test-scoped and safe here. No code change required.

---

## 8. Pattern Deviations from Claude / Codex Providers

| Pattern                        | Claude/Codex                                                                       | Hermes                                                     | Gap                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Retry logic**                | `MAX_SUBPROCESS_RETRIES = 3`, exponential backoff                                  | None                                                       | Hermes queries fail permanently on transient errors.                            |
| **First-event timeout**        | `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` (60 s default)                              | None                                                       | Hermes queries can hang forever if the subprocess stalls.                       |
| **Error classification**       | `classifySubprocessError()` → `rate_limit`, `auth`, `crash`, `unknown`             | None                                                       | Hermes errors are all surfaced as generic `result` chunks with `isError: true`. |
| **Binary resolver throws**     | Throws descriptive errors with install instructions                                | Throws with install instructions                           | OK — pattern matches.                                                           |
| **Config parser**              | `parseClaudeConfig`, `parseCodexConfig` — defensive, never throws                  | `parseHermesConfig` — defensive, never throws              | OK — pattern matches.                                                           |
| **Singleton / instance reuse** | Codex uses singleton `Codex` instance; Claude creates per-query SDK `query()` call | Hermes spawns fresh process per query                      | OK — by design (Hermes CLI is stateless).                                       |
| **Structured output**          | Codex parses JSON inline; Claude uses SDK schema enforcement                       | Not supported (`structuredOutput: false`)                  | OK — capability honestly declared.                                              |
| **MCP support**                | Claude loads MCP config, expands env vars, warns on missing vars                   | Not supported (`mcp: false`)                               | OK — capability honestly declared.                                              |
| **Session resume**             | Claude supports session resume via SDK                                             | Not supported (`sessionResume: false`)                     | OK — by design.                                                                 |
| **Abort signal**               | Codex passes `signal` to SDK; Claude uses `AbortController`                        | Hermes sends `session/cancel` + SIGTERM + SIGKILL fallback | OK — pattern is actually more robust than Claude's.                             |

**Summary:** The biggest deviations are the **absence of retry logic**, **first-event timeout**, and **structured error classification**. These are not bugs per se, but they reduce reliability and observability compared to the Claude and Codex providers.

---

## 9. Recommendations (Prioritized)

### Immediate (Critical / High)

1. **Add runtime validation for `SessionUpdateParams`** in `event-bridge.ts` to prevent crashes on malformed ACP messages.
2. **Replace module-level `nextId` with a per-bridge counter** to eliminate race conditions.
3. **Validate `sessionId` type and non-emptiness** after `session/new` response.

### Short-Term (Medium)

4. **Extract ACP method names and version constants** into `acp-protocol.ts` and replace all magic strings.
5. **Delete `acp-bridge.ts` and `acp-bridge.test.ts`** (dead code).
6. **Add retry logic (1–2 retries) with exponential backoff** to `HermesProvider.sendQuery`.
7. **Add first-event timeout** (default 60 s, env-configurable) to `bridgeHermesSession`.
8. **Fix `process.env` type safety** in `session-resolver.ts`.

### Long-Term (Low / Info)

9. **Add max-line-buffer protection** in `event-bridge.ts` stdout handler.
10. **Use `createNotification` for `session/cancel`** instead of `createRequest`.
11. **Improve `isHermesModelCompatible`** to warn on obvious non-Hermes model strings.
12. **Add tests for concurrent ID generation and `resetAcpIdCounter`**.
13. **Document unsupported `session/update` types** with a debug log fallback.

---

## 10. Appendix: Code Snippets for Key Findings

### A.1 Unsafe `SessionUpdateParams` Cast

```ts
// event-bridge.ts:193-207
if (notif.method === 'session/update' && notif.params) {
  const params = notif.params as unknown as SessionUpdateParams; // UNSAFE
  const update = params.update;
  if (update.sessionUpdate === 'agent_message_chunk') {
    queue.push({
      kind: 'chunk',
      chunk: { type: 'assistant', content: update.content.text }, // CRASH if content is null
    });
  }
}
```

### A.2 Mutable `nextId`

```ts
// acp-protocol.ts:36,48
let nextId = 1;
export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}
```

### A.3 Dead Code `acp-bridge.ts`

```ts
// acp-bridge.ts:24-52
export function buildAcpRequests(options: { ... }): AcpRequests {
  // ... builds initialize, newSession, prompt requests
}
// NEVER imported by event-bridge.ts or provider.ts
```

---

_End of Report_
