# Hermes Bridge Timeout & Resilience Audit

**Date:** 2026-04-26
**Auditor:** Hermes Agent (subagent)
**Scope:** Hermes provider bridge (`packages/providers/src/hermes`) compared against Claude, Codex, and Pi provider patterns.
**Goal:** Identify every missing timeout, retry, error classification, and resilience mechanism.

---

## 1. Executive Summary

Hermes is the **least resilient** of the four built-in providers. While the event bridge handles basic abort/cleanup, the provider layer lacks:

- **No subprocess retry loop** (Claude/Codex have 3 retries with exponential backoff)
- **No first-event timeout** (Claude has `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` / 60 s default)
- **No subprocess error classification** (Claude/Codex classify rate_limit/auth/crash/unknown)
- **No spawn failure fast-fail or retry** (Hermes throws raw spawn errors)
- **No idle-timeout enforcement at the provider level** (Claude/Codex rely on dag-executor idle timeout; Hermes has no equivalent)
- **No stderr diagnostics aggregation** (Claude/Codex collect stderr for error enrichment)
- **Missing circuit-breaker / consecutive-failure tracking** (executor-level only, not provider)
- **No request-level timeout on ACP handshake** (`initialize` → `session/new` → `session/prompt` can hang indefinitely)
- **No zombie-process reaper beyond `unref()` and `SIGKILL` fallback** (no periodic health check)

---

## 2. Provider-by-Provider Comparison Matrix

| Mechanism                       | Claude                                                          | Codex                                                                     | Pi                                | Hermes                                              | Gap Severity            |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------- | ----------------------- |
| **Subprocess retry loop**       | 3 retries, exponential backoff (2s base)                        | 3 retries, exponential backoff (2s base)                                  | N/A (in-process SDK)              | **NONE**                                            | 🔴 Critical             |
| **First-event timeout**         | 60s env-configurable (`ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS`)   | Implicit via SDK                                                          | N/A (in-process)                  | **NONE**                                            | 🔴 Critical             |
| **Error classification**        | `classifySubprocessError` → rate_limit / auth / crash / unknown | `classifyCodexError` → rate_limit / auth / crash / model_access / unknown | N/A (SDK handles)                 | **NONE**                                            | 🔴 Critical             |
| **Abort signal wiring**         | `AbortController` per attempt, forwarded to SDK                 | `AbortSignal` forwarded to SDK turn                                       | `session.abort()` + dispose       | `SIGTERM` + 5s `SIGKILL` fallback                   | 🟡 Medium               |
| **Stderr diagnostics**          | Collected in `stderrLines[]`, appended to error message         | Not explicitly collected (SDK opaque)                                     | N/A                               | Captured but **not used for error enrichment**      | 🟡 Medium               |
| **Idle timeout**                | Dag-executor `withIdleTimeout`                                  | Dag-executor `withIdleTimeout`                                            | Dag-executor `withIdleTimeout`    | Dag-executor `withIdleTimeout` only                 | 🟢 N/A (shared)         |
| **Spawn failure handling**      | Fast-fail with enriched error                                   | Fast-fail with model-access check                                         | N/A                               | **Raw Error thrown, no enrichment**                 | 🔴 Critical             |
| **Session resume**              | `resumeSessionId` + `forkSession`                               | `resumeThread` / `startThread` fallback                                   | `resolvePiSession` with fallback  | **Explicitly unsupported** (`sessionResume: false`) | 🟡 Expected (by design) |
| **Terminal result guarantee**   | SDK yields `result` chunk                                       | SDK yields `turn.completed`                                               | `agent_end` → `buildResultChunk`  | **Yes** (bridge emits on all paths)                 | 🟢 Good                 |
| **Zombie prevention**           | `unref()` + `SIGKILL` in finally                                | SDK manages process                                                       | `dispose()` in finally            | `unref()` + `SIGKILL` in finally                    | 🟢 Good                 |
| **Queue single-consumer guard** | N/A (SDK stream)                                                | N/A (SDK stream)                                                          | `AsyncQueue` with `consumed` flag | `AsyncQueue` with `consumed` flag                   | 🟢 Good                 |
| **Structured output**           | SDK-enforced `outputFormat`                                     | SDK-enforced `outputSchema`                                               | Best-effort prompt + parse        | **Not supported** (`structuredOutput: false`)       | 🟡 By design            |
| **Cost / token tracking**       | `total_cost_usd`, `usage`                                       | `usage` on `turn.completed`                                               | `usageToTokens`                   | **Not emitted**                                     | 🟡 Missing              |
| **Model compatibility check**   | `isModelCompatible`                                             | `isModelCompatible`                                                       | `lookupPiModel`                   | **No runtime validation**                           | 🟡 Medium               |

---

## 3. Detailed Findings

### 3.1 Missing Retry Loop (`provider.ts`)

**Claude pattern (`packages/providers/src/claude/provider.ts:955-1034`):**

```typescript
for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
  // ... build options, run query, catch error, classify, delay, retry
}
```

**Codex pattern (`packages/providers/src/codex/provider.ts:564-619`):**

```typescript
for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
  // ... create thread, runStreamed, catch error, classify, delay, retry
}
```

**Hermes pattern (`packages/providers/src/hermes/provider.ts:75-126`):**

```typescript
async *sendQuery(...) {
  const child = spawn(hermesBinary, ['acp'], ...);
  yield* bridgeHermesSession(child, ..., options?.abortSignal);
}
```

Hermes has **zero retries**. Any transient spawn failure, ACP handshake failure, or process crash immediately propagates to the caller. The dag-executor's node-level retry (`DEFAULT_NODE_MAX_RETRIES = 2`) is the only safety net, but it treats all errors as transient and does not classify subprocess crashes vs. auth failures.

**Recommendation:** Add a `MAX_SUBPROCESS_RETRIES = 3` loop around `spawn` + `bridgeHermesSession`, with exponential backoff (`RETRY_BASE_DELAY_MS = 2000`) identical to Claude/Codex.

---

### 3.2 Missing First-Event Timeout (`provider.ts`)

**Claude pattern (`packages/providers/src/claude/provider.ts:123-193`):**

```typescript
export async function* withFirstMessageTimeout<T>(
  gen: AsyncGenerator<T>,
  controller: AbortController,
  timeoutMs: number,
  diagnostics: Record<string, unknown>
): AsyncGenerator<T> { ... }
```

Claude wraps the raw SDK generator so that the first `.next()` must resolve within `60_000` ms (env override `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS`). If it hangs, the controller is aborted and a diagnostic-rich error is thrown.

**Hermes gap:** `bridgeHermesSession` awaits `sendRequest(initReq)` and `sendRequest(sessionReq)` without any timeout. If the Hermes binary hangs during ACP handshake (e.g., waiting for a model download, blocked on stdin), the caller hangs indefinitely. The dag-executor's `withIdleTimeout` only starts _after_ the generator begins yielding chunks, so it does not protect the handshake phase.

**Recommendation:** Wrap each `sendRequest` call in `bridgeHermesSession` with a `Promise.race` timeout (e.g., 30 s for `initialize`, 30 s for `session/new`, 120 s for `session/prompt`). Emit a `system` warning and retry at the provider level.

---

### 3.3 Missing Error Classification (`provider.ts`)

**Claude pattern (`packages/providers/src/claude/provider.ts:112-121`):**

```typescript
function classifySubprocessError(
  errorMessage: string,
  stderrOutput: string
): 'rate_limit' | 'auth' | 'crash' | 'unknown' { ... }
```

**Codex pattern (`packages/providers/src/codex/provider.ts:131-140`):**

```typescript
function classifyCodexError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'model_access' | 'unknown' { ... }
```

**Hermes gap:** There is no `classifyHermesError`. The bridge emits `isError: true` result chunks for non-zero exits and signal terminations, but the `provider.ts` `sendQuery` simply re-throws the raw error:

```typescript
catch (err) {
  getLog().error({ err }, 'hermes.query_failed');
  throw err;
}
```

This means:

- A rate-limited Hermes backend will be retried by the dag-executor's generic retry (if `onError: 'all'`), but the provider does not signal that it is transient.
- An auth failure (e.g., invalid API key in Hermes config) will be retried wastefully.
- A spawn crash (e.g., binary not found) will be retried wastefully.

**Recommendation:** Implement `classifyHermesError(errorMessage, stderrLines, exitCode)` in `provider.ts` or `event-bridge.ts`. Return `'rate_limit' | 'auth' | 'crash' | 'unknown'`. Use it to decide retry eligibility in the new retry loop.

---

### 3.4 Missing Stderr Error Enrichment (`event-bridge.ts`)

**Claude pattern (`packages/providers/src/claude/provider.ts:836-873`):**

```typescript
function classifyAndEnrichError(error, stderrLines, controller) {
  const enrichedMessage = stderrContext
    ? `Claude Code ${errorClass}: ${error.message} (stderr: ${stderrContext})`
    : `Claude Code ${errorClass}: ${error.message}`;
  return { enrichedError, errorClass, shouldRetry };
}
```

**Hermes gap:** `event-bridge.ts` captures stderr lines (`stderrLines.push(text)`) and logs them at `warn` level, but:

1. They are **not returned** to `provider.ts`.
2. They are **not appended** to error messages.
3. On non-zero exit, only the _last_ stderr line is included in the terminal result chunk, truncated to 200 chars.

**Recommendation:** Return `stderrLines` from `bridgeHermesSession` (or include them in the thrown error / result chunk). In `provider.ts`, append stderr context to the enriched error message, matching Claude's pattern.

---

### 3.5 Missing Spawn Failure Fast-Fail (`provider.ts`)

**Claude pattern:** `resolveClaudeBinaryPath` throws _before_ the retry loop if the binary is missing, giving the user a clean error immediately.

**Codex pattern:** `createCodexClient` throws with `buildModelAccessMessage` if the model is unavailable.

**Hermes gap:** `resolveHermesBinary` returns `undefined` when not found, and `provider.ts` falls back to `'hermes'` from PATH. If the binary is missing, `spawn('hermes', ...)` emits an `error` event on the `ChildProcess`, which the bridge catches and emits as `isError: true`. However:

- There is no **pre-flight check** (e.g., `which hermes` or `hermes --version`).
- The error is not enriched with installation instructions (`INSTALL_INSTRUCTIONS` exists in `binary-resolver.ts` but is never surfaced through the provider).

**Recommendation:** In `sendQuery`, after resolving the binary, perform a quick `child_process.execFile(binary, ['--version'])` sanity check (with a 5 s timeout). If it fails, throw a user-actionable error that includes `INSTALL_INSTRUCTIONS`.

---

### 3.6 Missing Request-Level Timeout on ACP Handshake (`event-bridge.ts`)

**Current code (`event-bridge.ts:339-406`):**

```typescript
try {
  await sendRequest(initReq);        // can hang forever
  const sessionResp = await sendRequest(sessionReq); // can hang forever
  const promptResp = await sendRequest(promptReq);     // can hang forever
  // ...
} catch (err) { ... }
```

Each `sendRequest` is a `new Promise` that resolves when a matching JSON-RPC response arrives on stdout. If the Hermes process is alive but unresponsive (e.g., deadlocked, waiting on network), the promise never resolves.

**Recommendation:** Add a `REQUEST_TIMEOUT_MS = 30_000` (or env-configurable) to `sendRequest`. Reject with a clear error (`Hermes ACP request '${method}' timed out after ${timeout}ms`). This timeout should be separate from the first-event timeout and the idle timeout.

---

### 3.7 Missing Token / Cost / StopReason / ModelUsage Emission (`event-bridge.ts`)

**Claude pattern:** The bridge normalizes SDK `result` events into `MessageChunk` with `tokens`, `cost`, `stopReason`, `numTurns`, `modelUsage`.

**Codex pattern:** The bridge extracts `usage` from `turn.completed` and emits it on the `result` chunk.

**Pi pattern:** The bridge computes `usageToTokens` from the last assistant message and emits it.

**Hermes gap:** The Hermes ACP protocol defines `stopReason` in the `session/prompt` response, but the bridge only emits:

```typescript
chunk: {
  type: 'result',
  sessionId,
  stopReason,
}
```

There is **no** `tokens`, `cost`, `numTurns`, or `modelUsage`. This means:

- The dag-executor cannot aggregate token usage or cost across Hermes nodes.
- The workflow completion message cannot show "used X tokens".
- Cost-control (`maxBudgetUsd`) is impossible because there is no usage data to compare against.

**Recommendation:** If the Hermes ACP protocol supports usage data, parse and emit it. If not, document the limitation and set `costControl: false` (already done). At minimum, emit `stopReason` consistently (already done).

---

### 3.8 Missing Model Compatibility Check (`provider.ts`)

**Claude/Codex pattern:** `isModelCompatible(provider, model)` is called before `sendQuery` in the dag-executor.

**Hermes gap:** Hermes does not implement `isModelCompatible` at runtime. The `options-translator.ts` resolves the model from config, but if the user sets `model: 'gpt-4'` with `provider: 'hermes'`, there is no validation that Hermes can actually serve that model. The error will surface only when Hermes tries to load the model and fails (late failure).

**Recommendation:** Add a lightweight model compatibility check in `sendQuery` (or in `resolveHermesModel`) that validates the model string against known Hermes-supported prefixes. Alternatively, delegate to the Hermes CLI via a `--list-models` or `--validate-model` flag if available.

---

### 3.9 Missing Idle-Timeout Integration at Provider Level

**Claude/Codex/Pi:** These providers do not implement idle timeout internally; they rely on the dag-executor's `withIdleTimeout` wrapper, which aborts the `AbortSignal` if no chunk arrives within `STEP_IDLE_TIMEOUT_MS` (default 10 min).

**Hermes:** Same pattern — the dag-executor passes `options?.abortSignal` to `sendQuery`, which forwards it to `bridgeHermesSession`. The bridge handles abort with `SIGTERM` + `SIGKILL` fallback.

**Status:** ✅ **Correctly implemented.** No gap here, but worth noting that Hermes benefits from the shared executor mechanism.

---

### 3.10 Missing Circuit Breaker / Consecutive-Failure Tracking

**Claude/Codex/Pi:** None of the providers implement a circuit breaker. The dag-executor tracks `UNKNOWN_ERROR_THRESHOLD = 3` consecutive unknown errors in `safeSendMessage` (platform-level, not provider-level).

**Hermes:** No circuit breaker. A misconfigured Hermes binary (e.g., wrong API key) will be spawned, fail, and retried up to `DEFAULT_NODE_MAX_RETRIES = 2` by the executor, each time incurring the full spawn cost.

**Recommendation:** This is a **cross-provider** concern. Consider adding a provider-level `consecutiveFailureCount` in the registry or executor, with exponential backoff across workflow runs (not just within a single node). Out of scope for this audit, but noted for future resilience work.

---

## 4. Recommendations (Prioritized)

### 🔴 P0 — Critical (Fix Before Production Use)

1. **Add subprocess retry loop in `HermesProvider.sendQuery`**
   - Copy Claude/Codex pattern: `MAX_SUBPROCESS_RETRIES = 3`, `RETRY_BASE_DELAY_MS = 2000`, exponential backoff.
   - Only retry on `errorClass === 'rate_limit' || errorClass === 'crash'`.

2. **Implement `classifyHermesError`**
   - Inspect `error.message`, `stderrLines`, and `exitCode`.
   - Return `'rate_limit' | 'auth' | 'crash' | 'unknown'`.
   - Use for retry eligibility and error enrichment.

3. **Add ACP handshake timeout in `bridgeHermesSession.sendRequest`**
   - `REQUEST_TIMEOUT_MS = 30_000` (or env-configurable).
   - Reject with actionable error message including method name.

### 🟡 P1 — High (Strongly Recommended)

4. **Add first-event timeout in `HermesProvider.sendQuery`**
   - Wrap `bridgeHermesSession` generator in `withFirstMessageTimeout` (copy Claude pattern).
   - Default 60 s, env override `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS`.

5. **Enrich errors with stderr context**
   - Return `stderrLines` from `bridgeHermesSession`.
   - Append to thrown error messages in `provider.ts`.

6. **Add spawn pre-flight check**
   - `execFile(binary, ['--version'], { timeout: 5000 })` before first use.
   - Surface `INSTALL_INSTRUCTIONS` on failure.

### 🟢 P2 — Medium (Nice to Have)

7. **Emit token/cost usage on `result` chunk**
   - If Hermes ACP protocol supports it, parse and forward.
   - If not, document limitation.

8. **Add runtime model compatibility check**
   - Validate `model` against Hermes-supported list before spawning.
   - Fail fast with clear message.

9. **Add `ARCHON_HERMES_REQUEST_TIMEOUT_MS` env var**
   - Allow operators to tune ACP handshake timeout.

---

## 5. Files Audited

- `packages/providers/src/hermes/provider.ts`
- `packages/providers/src/hermes/event-bridge.ts`
- `packages/providers/src/hermes/acp-protocol.ts`
- `packages/providers/src/hermes/acp-bridge.ts`
- `packages/providers/src/hermes/session-resolver.ts`
- `packages/providers/src/hermes/binary-resolver.ts`
- `packages/providers/src/hermes/capabilities.ts`
- `packages/providers/src/hermes/config.ts`
- `packages/providers/src/hermes/options-translator.ts`
- `packages/providers/src/claude/provider.ts` (reference)
- `packages/providers/src/codex/provider.ts` (reference)
- `packages/providers/src/community/pi/provider.ts` (reference)
- `packages/providers/src/community/pi/event-bridge.ts` (reference)
- `packages/workflows/src/dag-executor.ts` (executor-level retry/idle timeout)
- `packages/workflows/src/executor.ts` (orchestrator-level resilience)

---

## 6. Conclusion

Hermes v1 is **functionally minimal but resiliently incomplete**. The ACP bridge correctly handles abort, process cleanup, and terminal result guarantees, but the provider layer lacks the retry, timeout, and error-classification machinery that Claude and Codex have matured over multiple iterations. **The most critical gaps are the missing retry loop and the missing ACP handshake timeout**, both of which can cause workflows to hang or fail permanently on transient Hermes subprocess issues. Addressing the P0 recommendations will bring Hermes to parity with the other built-in providers.
