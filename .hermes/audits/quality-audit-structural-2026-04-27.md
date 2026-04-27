# Structural Code Quality Audit — Hermes Provider

**Date:** 2026-04-27  
**Scope:** `packages/providers/src/hermes/*.ts`  
**Auditor:** Sub-agent (read-only review)

---

## Summary by Severity

| Severity | Count |
| -------- | ----- |
| Critical | 4     |
| High     | 3     |
| Medium   | 4     |
| Low      | 2     |

---

## Findings

### 1. CRITICAL — Timer leak + stale-state race in `sendRequest`

- **File:** `event-bridge.ts`
- **Lines:** 280–300
- **Description:** `sendRequest` races a request promise against a `setTimeout`. The timeout handle is never cleared when the request succeeds. When the timer fires later it mutates shared state (`pendingRequestId`, `requestResolve`, `requestReject`) that may already belong to a subsequent request, causing a stale-state race or spurious rejection.
- **Recommended Fix:** Store the timer handle and clear it after `Promise.race` settles (wrap in `try/finally`), or use `AbortSignal` + `clearTimeout`.

### 2. CRITICAL — Unhandled rejection + timer leak in `withFirstEventTimeout`

- **File:** `timeout-utils.ts`
- **Lines:** 1–27
- **Description:** `await Promise.race([gen.next(), timer])` settles on `gen.next()` rejection, but the `timer` Promise is still pending. If the timeout fires later, its rejection is unhandled (Node.js unhandled promise rejection). Additionally, `clearTimeout(timerHandle)` is skipped when the race rejects, leaking the timer handle.
- **Recommended Fix:** Wrap the race in `try/finally` and unconditionally clear `timerHandle`. Attach a no-op `.catch(() => {})` to the timer Promise, or use an `AbortController` to cancel the timer.

### 3. CRITICAL — Inner generator leak on timeout/throw

- **File:** `timeout-utils.ts`
- **Lines:** 1–27
- **Description:** `withFirstEventTimeout` iterates the inner generator manually (`gen.next()`). If it throws (timeout or inner error), it never calls `gen.return()`, so `bridgeHermesSession`’s `finally` block never runs. This leaks the child process, event listeners, abort signal handlers, and the `sigkillTimeout` timer.
- **Recommended Fix:** Add a `try/finally` in `withFirstEventTimeout` that calls `await gen.return?.()` and clears the timer. Alternatively, replace manual iteration with `yield*` wrapped in a timeout helper that preserves cleanup semantics.

### 4. CRITICAL — `childProcess.stdin?.write` can throw uncaught inside abort handler

- **File:** `event-bridge.ts`
- **Lines:** 238–244
- **Description:** Inside `onAbort`, `childProcess.stdin?.write(...)` is called without try/catch. If the child has already crashed and stdin is closed, `write` throws `EPIPE` or similar, producing an unhandled exception in the event listener.
- **Recommended Fix:** Wrap `stdin.write` in `try/catch` and log the failure (it is best-effort cleanup).

### 5. HIGH — Unbounded `stderrLines` growth

- **File:** `event-bridge.ts`
- **Lines:** 82–83
- **Description:** `stderrLines` is appended on every stderr data event with no truncation limit. A noisy or runaway child process can cause unbounded memory growth.
- **Recommended Fix:** Cap `stderrLines` to a fixed size (e.g., last 50 lines) or total byte budget, dropping older entries.

### 6. HIGH — `childProcess.kill` can throw uncaught in abort handler

- **File:** `event-bridge.ts`
- **Lines:** 246, 249
- **Description:** `childProcess.kill('SIGTERM')` and `childProcess.kill('SIGKILL')` inside `onAbort` can throw if the process has already exited. No try/catch guards these calls.
- **Recommended Fix:** Wrap both calls in `try/catch` (the `finally` block in the generator already does this for the fallback kill, but the abort path does not).

### 7. MEDIUM — Silent error swallow in `parseMessage`

- **File:** `acp-protocol.ts`
- **Line:** 102
- **Description:** `catch { return null; }` silently discards all JSON parse errors. In a stdio bridge where malformed lines are possible, missing diagnostics makes debugging impossible.
- **Recommended Fix:** Log the caught error at `debug` or `warn` level before returning `null`.

### 8. MEDIUM — Silent error swallow in `verifyHermesBinary`

- **File:** `binary-resolver.ts`
- **Lines:** 41–48
- **Description:** `catch { return false; }` discards the exec error without logging. The caller throws its own message, but the underlying stderr/cause is lost.
- **Recommended Fix:** Log the error at `debug` level inside the catch, or attach it to the returned boolean/context.

### 9. MEDIUM — Mutable shared module state (`legacyId`)

- **File:** `acp-protocol.ts`
- **Lines:** 51–52, 58
- **Description:** `let legacyId = 1` is module-level mutable state. Multiple concurrent bridges (or other callers omitting `idGenerator`) can observe duplicate or interleaved IDs because all callers share the same counter.
- **Recommended Fix:** Remove the fallback entirely and make `idGenerator` required, or document explicitly that callers must supply an `idGenerator` for concurrent use. If backward compat is required, consider a `WeakMap`-based per-caller generator.

### 10. MEDIUM — Race-prone shared flag `terminalEmitted`

- **File:** `event-bridge.ts`
- **Line:** 79
- **Description:** `terminalEmitted` is read and written by the `exit`, `error`, and `onAbort` event handlers as well as by the main sequential loop. Although Node.js is single-threaded, cross-event-loop reordering between stream data events and process exit events can still produce duplicate terminal chunks or lost state.
- **Recommended Fix:** Mediate terminal-chunk emission through the `queue` (e.g., a single `queue.push({kind:'terminal', ...})`) and have the consumer deduplicate, or guard reads/writes with a lock-like pattern or move all terminal logic into a single cleanup function.

### 11. LOW — Defensive `catch {}` without logging in generator finally

- **File:** `event-bridge.ts`
- **Lines:** 414–418
- **Description:** `try { childProcess.kill('SIGKILL'); } catch {}` silently ignores kill failures. A comment explains why, but there is no log line.
- **Recommended Fix:** Log at `debug` level inside the catch so operators can observe pathological process-lifecycle problems.

### 12. LOW — Unbounded temporary array from `split('\n')` on massive stdout chunk

- **File:** `event-bridge.ts`
- **Lines:** 96–103
- **Description:** `lineBuffer.split('\n')` creates an array whose largest element can be as big as the input chunk. If the child writes a single 1+ MiB line, the split produces a huge intermediate array before the line buffer is truncated. The `MAX_LINE_BUFFER_LENGTH` guard only truncates the leftover buffer after the split.
- **Recommended Fix:** Measure input chunk size before splitting and truncate/flush aggressively if a single line exceeds a safe limit.

---

## Checklist Results

| Check                                           | Status  | Notes                                                                                                                                                             |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `catch {}` without logging / re-throw        | ❌ FAIL | `acp-protocol.ts:102`, `binary-resolver.ts:45`, `event-bridge.ts:416`                                                                                             |
| No `Promise.race` without timer cleanup         | ❌ FAIL | `event-bridge.ts:280`, `timeout-utils.ts:15`                                                                                                                      |
| All async errors propagated or logged           | ❌ FAIL | `withFirstEventTimeout` leaks unhandled rejections; `stdin.write` throws uncaught                                                                                 |
| No mutable shared state races                   | ❌ FAIL | `legacyId` module state; `terminalEmitted` cross-handler updates; `pendingRequest*` shared across promises                                                        |
| No unbounded growth                             | ❌ FAIL | `stderrLines` unbounded; `split('\n')` temporary unbounded                                                                                                        |
| TS types strict (no implicit any, unsafe casts) | ⚠️ WARN | `acp-protocol.ts` uses `as JsonRpcSuccess/Error/Notification` after minimal key checks; acceptable for a parser but could be tightened with a validation function |
| Generator/yield exceptions handled              | ❌ FAIL | `timeout-utils.ts` does not call `gen.return()` on throw/timeout                                                                                                  |
| Timer handles always cleaned up                 | ❌ FAIL | `event-bridge.ts` race timer not cleared; `timeout-utils.ts` timer not cleared on rejection                                                                       |
| No deprecated API usage                         | ✅ PASS | `resetAcpIdCounter` is marked `@deprecated` but not used by active path                                                                                           |
| Error messages actionable                       | ✅ PASS | Error messages include context, codes, and stderr snippets                                                                                                        |
| No boolean traps                                | ✅ PASS | No ambiguous boolean params found                                                                                                                                 |
| No dead / unreachable code                      | ✅ PASS | `resetAcpIdCounter` is a deprecated no-op but may be part of public API; not "dead"                                                                               |
