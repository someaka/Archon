# Cross-Cutting Architecture Fix Plan

> Date: 2026-04-30  
> Status: Plan (read-only)  
> Scope: Architectural issues, test gaps, and integration risks spanning Pi and Hermes providers  
> Based on: verifier-results.md, 17 bugs found across both providers

---

## Executive Summary

The verifier found 17 bugs (7 in Pi code, 10 in Hermes code). Individual fix plans are being handled by two separate planners. This plan identifies **cross-cutting concerns** — architectural issues that span multiple files, shared infrastructure bugs, test coverage gaps for the verifier findings, and integration risks that individual per-file fixes won't address.

**Key finding:** The most critical cross-cutting issue is the **ConcurrencyLock held across retries + exponential backoff** in Hermes provider — it interacts with the session pool, the event bridge timeout, and the error classifier in a way that can cascade into 14+ second starvation for all concurrent queries.

---

## 1. Architectural Issues That Need Fixing

### 1A. [CRITICAL] Lock Held Across Retries + Backoff (Hermes provider.ts:193-217)

**Problem:** `this.lock.acquire()` wraps the entire `sendQuery` including the retry loop with exponential backoff (2s, 4s, 8s = 14s total). A retrying query holds the semaphore for 14+ seconds, starving other queries.

**Interaction chain:**

1. Query A hits a transient error → error-classifier says `shouldRetry: true`
2. Lock is held during `await setTimeout(2000)`, `await setTimeout(4000)`, `await setTimeout(8000)`
3. Queries B, C, D (maxConcurrency=3 means D is queued) all block for 14s
4. If B, C also hit transient errors → cascading starvation

**Current code (provider.ts:193-217):**

```typescript
async *sendQuery(...) {
  await this.lock.acquire();    // ← Lock acquired HERE
  try {
    for (let attempt = 0; ...) {
      try {
        yield* this._sendQueryOnce(...);
        return;
      } catch (err) {
        if (!classified.shouldRetry || attempt >= MAX) throw;
        await new Promise(resolve => setTimeout(resolve, delayMs)); // ← Lock held during sleep!
      }
    }
  } finally {
    this.lock.release();         // ← Lock released HERE
  }
}
```

**Fix approach:** Release the lock during backoff sleep, re-acquire before retry:

```typescript
async *sendQuery(...) {
  await this.lock.acquire();
  try {
    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (options?.abortSignal?.aborted) throw new Error('Query aborted');
      try {
        yield* this._sendQueryOnce(...);
        return;
      } catch (err) {
        if (!classified.shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) throw;
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        this.lock.release();  // Release during backoff
        try {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } finally {
          await this.lock.acquire(); // Re-acquire for retry
        }
      }
    }
  } finally {
    this.lock.release();
  }
}
```

**Risk:** The lock.release() before backoff + re-acquire pattern introduces a window where another query could jump in. This is acceptable — it's the intended behavior of a semaphore.

**Blocks:** Nothing, but failure to fix this causes cascading performance degradation under load.

---

### 1B. [HIGH] Session Pool Acquire Doesn't Check isAlive() (session-pool.ts:56-68)

**Problem:** `pool.acquire()` checks `inUse` but never `client.isAlive()`. The provider then checks `pooled?.client.isAlive()` at line 250, creating a TOCTOU race:

```typescript
// session-pool.ts — acquire doesn't check liveness
acquire(...): PooledSession | undefined {
  if (session.inUse) return undefined;
  session.inUse = true;    // ← Dead session marked inUse=true
  return session;
}

// provider.ts:250 — checks liveness AFTER acquire
const pooled = this.pool.acquire(...);
if (pooled?.client.isAlive()) {   // ← Dead! Pool has it marked inUse=true
  // ...use session...
} else {
  // ...falls through to spawn path...
  // But pool.delete() is called, which calls dispose() on already-dead client
}
```

**Fix:** Add `isAlive()` check inside `pool.acquire()`:

```typescript
acquire(...): PooledSession | undefined {
  const session = this.sessions.get(key);
  if (!session || session.inUse) return undefined;
  if (!session.client.isAlive()) {
    this.killSession(session);
    this.sessions.delete(key);
    return undefined;
  }
  session.inUse = true;
  session.lastUsed = Date.now();
  return session;
}
```

**Fix also needed for release() (session-pool.ts:74-80):** `release()` sets `inUse = false` unconditionally on dead sessions, resurrecting zombies. Add liveness check:

```typescript
release(...): void {
  const session = this.sessions.get(key);
  if (!session) return;
  if (!session.client.isAlive()) {
    this.killSession(session);
    this.sessions.delete(key);
    return;
  }
  session.inUse = false;
}
```

**Blocks:** Provider test for dead-session-handling regression.

---

### 1C. [HIGH] Fire-and-Forget executePrompt() Unhandled Rejection (Hermes event-bridge.ts:689)

**Problem:** `void executePrompt()` starts the prompt concurrently with the consumer loop. If the abort signal fires, `queue.close()` is called in `onAbort`, then `executePrompt`'s catch block tries to call `emitTerminal` + `queue.push` on a closed queue. While `AsyncQueue.push` silently no-ops on closed queues, the error classification and terminal emission logic may throw independently.

**Current pattern:**

```typescript
// Line 689
void executePrompt();  // Fire-and-forget — unhandled rejection possible

// The executePrompt catch block (line 672-684):
catch (err) {
  emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
  queue.push({ kind: 'done' });  // ← Queue may be closed by onAbort
}
```

**Fix:** Add catch handler to fire-and-forget:

```typescript
void executePrompt().catch(err => {
  getLog().error({ err }, 'hermes.bridge.executePrompt_unhandled');
  // Terminal already emitted by executePrompt's catch block, or will be
  // emitted by exitHandler. Just suppress the unhandled rejection.
});
```

**Also applies to Pi event-bridge.ts:** The fire-and-forget pattern `void clientInit.return(undefined)` at provider.ts:403 could also produce unhandled rejections if the generator's finally block throws.

---

### 1D. [HIGH] stdin Listener Leak (Hermes event-bridge.ts:471-474)

**Problem:** Inside `sendRequest()`, anonymous `stdin.once('error', ...)` and `stdin.once('drain', ...)` listeners are created but never tracked for cleanup. The variable `stdinErrorHandler` (line 177) is declared but never assigned — the actual error handler is an anonymous function.

**Each sendRequest call leaks 1-2 listeners:**

- ACP handshake: initialize (1 stdin error listener) + session/new (1) + session/prompt (1) = 3 listeners
- On pooled session reuse: +1 per prompt call
- `MaxListenersExceededWarning` after ~11 requests

**Fix:** Track the anonymous handler and remove in cleanup:

```typescript
async function sendRequest(req, timeoutMs) {
  return Promise.race([
    new Promise((resolve, reject) => {
      const errorHandler = (err: Error) => {
        reject(new Error(`stdin error: ${err.message}`));
      };
      childProcess.stdin.once('error', errorHandler);
      // Store for cleanup
      stdinErrorHandler = errorHandler;
      // ... write ...
    }),
    // ... timeout ...
  ]);
}
```

The cleanup in `rejectPending` and the response handler already reference `stdinErrorHandler` — the fix is to actually assign it.

**Blocks:** Long-running pooled session stability.

---

### 1E. [MEDIUM] activeTimers Leak on Process Death (Hermes event-bridge.ts:307-318)

**Problem:** `rejectPending()` rejects the pending request but doesn't clear timeout timers. The `activeTimers` Map accumulates stale closures that prevent GC of the bridge function scope.

**Fix:** Clear all active timers in `rejectPending`:

```typescript
function rejectPending(reason: string): void {
  // ... existing rejection logic ...
  // Clear all pending timers
  for (const [id, timer] of activeTimers) {
    clearTimeout(timer);
    activeTimers.delete(id);
  }
}
```

---

### 1F. [MEDIUM] process.env Mutation in Pi Provider (provider.ts:171-182)

**Problem:** Config-level env vars injected into `process.env` are never cleaned up. In long-lived processes (Archon server), stale keys persist across workflow runs.

**Current code:**

```typescript
if (piConfig.env) {
  for (const [key, value] of Object.entries(piConfig.env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value; // ← Never cleaned up
    }
  }
}
```

**Fix:** Track applied keys and clean up in a try/finally:

```typescript
const appliedKeys: string[] = [];
try {
  if (piConfig.env) {
    for (const [key, value] of Object.entries(piConfig.env)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        appliedKeys.push(key);
      }
    }
  }
  // ... rest of sendQuery ...
} finally {
  for (const key of appliedKeys) {
    delete process.env[key];
  }
}
```

**Blocks:** Multi-workflow isolation in long-lived processes.

---

### 1G. [LOW] AsyncQueue undefined Sentinel (async-queue.ts:59-60)

**Problem:** `if (next !== undefined)` guard means pushing `undefined` as a value causes the consumer to exit early. Currently safe because `BridgeQueueItem` is never `undefined`, but a latent bug for any future generic use.

**Fix:** Use a sentinel value or check buffer length:

```typescript
private async *iterate(): AsyncGenerator<T> {
  while (true) {
    if (this.buffer.length > 0) {
      yield this.buffer.shift()!;
      continue;
    }
    if (this.closed) return;
    // ...wait for next item...
  }
}
```

**Risk:** Low — current usage is safe. Consider fixing as part of a shared utility hardening pass.

---

### 1H. [LOW] Deterministic tmpdir in Pi shim (provider.ts:49-66)

**Problem:** `ensurePiPackageDirShim` writes to `/tmp/archon-pi-shim/package.json` — a predictable path. In shared-host environments, another user could create a symlink at that path.

**Fix:** Use `mkdtempSync` for the shim directory:

```typescript
function ensurePiPackageDirShim(): void {
  const shimDir = mkdtempSync(join(tmpdir(), 'archon-pi-shim-'));
  // ...write package.json...
  process.env.PI_PACKAGE_DIR = shimDir;
}
```

**Note:** Idempotency check (`existsSync`) would need to be removed since each call creates a new directory. The env var assignment is already per-call, so this is safe.

---

## 2. Test Gaps That Must Be Filled

### 2A. [CRITICAL] Missing Tests for Verifier Findings

| Finding                                 | File                     | Existing Test?                                          | Gap                                                              |
| --------------------------------------- | ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
| Lock held across retries + backoff      | hermes/provider.ts       | Partial (retry tested, lock starvation NOT tested)      | **Need: test that lock is released during backoff**              |
| Session pool hands out dead sessions    | hermes/session-pool.ts   | acquire/release tested, isAlive NOT tested              | **Need: acquire with dead client returns undefined**             |
| Session pool release resurrects zombies | hermes/session-pool.ts   | release tested, dead-client release NOT tested          | **Need: release on dead session removes from pool**              |
| Fire-and-forget unhandled rejection     | hermes/event-bridge.ts   | Abort tested, concurrent executePrompt+abort NOT tested | **Need: abort signal fires during executePrompt**                |
| stdin listener leak                     | hermes/event-bridge.ts   | No test for listener count                              | **Need: verify listeners are cleaned up after bridge completes** |
| activeTimers leak                       | hermes/event-bridge.ts   | No test for timer cleanup                               | **Need: verify timers cleared after rejectPending**              |
| process.env mutation cleanup            | pi/provider.ts           | No test for cleanup                                     | **Need: verify env vars are cleaned up after sendQuery**         |
| AsyncQueue undefined sentinel           | utils/async-queue.ts     | Not tested                                              | **Need: test pushing undefined value**                           |
| ACP client missing unref()              | hermes/acp-client.ts     | Not tested                                              | **Need: verify childProcess.unref() called in constructor**      |
| Pi session-resolver dynamic import      | pi/session-resolver.ts   | Tested (existsSync, session lookup)                     | Covered                                                          |
| options-translator path traversal       | pi/options-translator.ts | Tested                                                  | Covered                                                          |
| 30s timeout on promptPromise            | pi/event-bridge.ts       | Timeout logic in finally tested?                        | **Need: verify 30s timeout prevents hang**                       |
| errorMessage surfacing                  | pi/event-bridge.ts       | Tested in provider.test.ts                              | Covered                                                          |
| Extensions default-off                  | pi/provider.ts           | Tested (PI_CAPABILITIES, config)                        | Covered                                                          |

### 2B. [HIGH] New Test Files / Test Cases Needed

#### hermes/event-bridge.test.ts — Add:

1. **stdin listener cleanup test:** After bridge completes, verify no orphaned listeners on stdin
2. **activeTimers cleanup test:** After process death, verify all timers are cleared
3. **executePrompt + abort concurrency test:** Start bridge, fire abort during prompt execution, verify no unhandled rejection
4. **drain listener cleanup test:** After backpressure resolves, verify drain listener removed

#### hermes/session-pool.test.ts — Add:

1. **acquire returns undefined for dead session:** Mock `isAlive() → false`, verify acquire returns undefined and removes session
2. **release on dead session removes from pool:** Release a dead session, verify it's deleted from pool
3. **get() on dead session still returns it (read-only):** Verify get() doesn't filter dead sessions (it's read-only)

#### hermes/provider.test.ts — Add:

1. **Lock starvation test:** Verify that when query A retries with backoff, query B can proceed (lock is released during sleep)
2. **Pooled dead session fallback:** Pool has a dead session → provider spawns fresh instead

#### pi/provider.test.ts — Add:

1. **process.env cleanup test:** Set config env vars, run sendQuery, verify env vars are cleaned up after
2. **Concurrent sendQuery isolation:** Two concurrent Pi queries don't contaminate each other's env

#### utils/async-queue.test.ts — Add (or extend existing in event-bridge.test.ts):

1. **push(undefined) behavior:** Document current behavior (early exit) or fix and test

---

## 3. Integration Risks

### 3A. [HIGH] Lock ↔ Pool ↔ Event Bridge Interaction

**The concurrency stack has three layers:**

1. **ConcurrencyLock** — serializes concurrent queries (max 3)
2. **SessionPool** — caches child processes for reuse
3. **EventBridge** — manages I/O lifecycle per query

**Risk scenario:**

1. Query A acquires lock, gets pooled session, starts bridge
2. Bridge's executePrompt fires concurrently with consumer
3. Abort signal fires → onAbort calls queue.close() + SIGTERM
4. executePrompt catch block runs → emitTerminal on closed queue (no-op per AsyncQueue)
5. Provider's finally block: `void clientInit.return(undefined)` — fire-and-forget
6. Pool releases session (release sets inUse=false)
7. **Race:** If the bridge's finally block hasn't completed cleanup (removing stdout listeners), the next query that acquires this pooled session may see stale listeners

**Mitigation:** The bridge's finally block (event-bridge.ts:715-742) removes stdout/stderr/exit/error listeners. But `void clientInit.return(undefined)` doesn't wait for this cleanup. Fix: await the generator return or add a cleanup-complete signal.

### 3B. [MEDIUM] Error Classification ↔ Retry Interaction

**Risk:** The error classifier treats "timeout" as `shouldRetry: true`, but the event bridge's 30s promptPromise timeout (Pi) and 5min PROMPT_TIMEOUT_MS (Hermes) may produce errors that the classifier misclassifies.

**Example:** Pi's 30s timeout on promptPromise in finally block → timeout error → classifier says retry → but the underlying issue (hung model) will recur.

**Mitigation:** The error classifier already handles "no output within Nms" as `shouldRetry: false` (crash). But promptPromise timeout errors from Pi don't go through the classifier — they're surfaced as thrown errors from the bridge. The Pi provider catches these at line 488-490 and re-throws without classification.

**Fix:** Add error classification to Pi provider's catch block:

```typescript
catch (err) {
  getLog().error({ err }, 'pi.prompt_failed');
  // Classify for retry decisions if orchestrator requests it
  throw err;
}
```

### 3C. [MEDIUM] Orchestrator Provider Failure Handling

**Risk:** The orchestrator's `orchestrator-agent.ts` calls `getAgentProvider(id).sendQuery(...)` and catches errors at the call site. But the error shape varies by provider:

- Hermes: throws `HermesClassifiedError` (retryable) or yields error result chunks
- Pi: throws raw errors or yields system warning chunks
- Claude: throws `ClaudeProviderError` variants

**The orchestrator has no unified error-recovery strategy.** It catches errors and formats them for the user, but doesn't distinguish retryable from non-retryable errors across providers.

**Mitigation:** This is a v2 concern. Current behavior (catch and surface) is acceptable for single-query workflows. Multi-step workflows (dag-executor) handle retries at the workflow level.

### 3D. [LOW] Registry Singleton State Leaks in Tests

**Risk:** The registry uses a module-level `Map` singleton. Tests call `clearRegistry()` + `registerBuiltinProviders()` in `beforeEach`, but if a test fails mid-registration, the singleton may be in an inconsistent state for subsequent tests.

**Mitigation:** Already handled by `clearRegistry()` + `registerBuiltinProviders()` pattern in tests. Low risk.

---

## 4. Priority Ordering

### Phase 1: Critical Fixes (Block other work)

| Priority | Item                                      | Files                  | Effort  |
| -------- | ----------------------------------------- | ---------------------- | ------- |
| P0       | Lock held across retries + backoff        | hermes/provider.ts     | Small   |
| P0       | Session pool isAlive() on acquire/release | hermes/session-pool.ts | Small   |
| P0       | Fire-and-forget unhandled rejection       | hermes/event-bridge.ts | Trivial |

### Phase 2: High-Priority Fixes + Tests

| Priority | Item                         | Files                  | Effort  |
| -------- | ---------------------------- | ---------------------- | ------- |
| P1       | stdin listener leak          | hermes/event-bridge.ts | Small   |
| P1       | activeTimers leak            | hermes/event-bridge.ts | Trivial |
| P1       | process.env mutation cleanup | pi/provider.ts         | Small   |
| P1       | Add missing tests (2B above) | 5 test files           | Medium  |

### Phase 3: Medium-Priority Fixes

| Priority | Item                                    | Files                               | Effort  |
| -------- | --------------------------------------- | ----------------------------------- | ------- |
| P2       | Lock ↔ Pool ↔ Bridge interaction        | hermes/provider.ts, event-bridge.ts | Medium  |
| P2       | Pi error classification in catch block  | pi/provider.ts                      | Trivial |
| P2       | Verify already-applied fixes have tests | Various                             | Small   |

### Phase 4: Low-Priority Hardening

| Priority | Item                                   | Files                | Effort     |
| -------- | -------------------------------------- | -------------------- | ---------- |
| P3       | AsyncQueue undefined sentinel          | utils/async-queue.ts | Trivial    |
| P3       | Deterministic tmpdir in Pi shim        | pi/provider.ts       | Trivial    |
| P3       | Unified error recovery in orchestrator | core/orchestrator/   | Large (v2) |

---

## 5. Already-Applied Fixes — Regression Check

| Fix                                | Commit             | Regression Risk | Missing Test?                               |
| ---------------------------------- | ------------------ | --------------- | ------------------------------------------- |
| Pi errorMessage surfacing          | 92a5f93e           | Low             | Tested in pi/provider.test.ts ✅            |
| Binary resolver dev mode           | 158d0174           | Low             | Tested in binary-resolver.test.ts ✅        |
| Claude stop_sequence fix           | d87b2b31           | Low             | Tested in claude/provider.test.ts ✅        |
| DAG executor thinking chunks       | 271f3172           | Low             | Tested in dag-executor.test.ts ✅           |
| Ollama gateway auto-detect         | e60a0f6f, b778b01c | Medium          | **Needs: test for env var fallback chain**  |
| Pi session-resolver dynamic import | (earlier)          | Low             | Tested ✅                                   |
| options-translator path traversal  | (earlier)          | Low             | Tested ✅                                   |
| Pi extensions default-off          | (earlier)          | Low             | Tested in registry + provider ✅            |
| Pi event-bridge 30s timeout        | (earlier)          | Medium          | **Needs: test for timeout preventing hang** |

---

## 6. Shared Patterns — Opportunities for Consolidation

### 6A. Event Bridge Pattern Duplication

Both `hermes/event-bridge.ts` and `pi/event-bridge.ts` implement the same pattern:

- Create AsyncQueue
- Wire producers (stdout handler / session.subscribe)
- Wire abort signal
- Consumer loop with `for await`
- Finally block: close queue, remove listeners, cleanup

**Opportunity:** Extract a shared `BridgeBase` or factory function that handles the queue lifecycle, abort wiring, and cleanup. Each provider would supply its producer callback.

**Risk of NOT consolidating:** Bug fixes in one bridge don't propagate to the other (e.g., the 30s timeout fix in Pi's bridge wasn't applied to Hermes's bridge — Hermes has a 5min prompt timeout but no equivalent safety timeout in its finally block).

### 6B. Error Classification Pattern

Both providers classify errors, but differently:

- Hermes: `error-classifier.ts` with structured classification + retry semantics
- Pi: No classification — raw errors thrown or system chunks yielded

**Opportunity:** Define a shared `ProviderError` base class with `shouldRetry`, `errorClass`, and `enrichedMessage` fields. Both providers extend it.

### 6C. Session Lifecycle Pattern

Both providers manage sessions:

- Hermes: `HermesSessionPool` + `HermesAcpClient` (explicit lifecycle)
- Pi: `SessionManager` + `resolvePiSession` (file-based persistence)

**Opportunity:** Define a shared `SessionHandle` interface with `isAlive()`, `dispose()`, and cleanup semantics. The pool can operate on any provider's sessions.

---

## Summary

- **3 critical architectural fixes** (lock starvation, pool liveness, unhandled rejection)
- **5 high-priority fixes** (listener leaks, env mutation, missing tests)
- **~15 new test cases** needed across 5 test files
- **3 medium-priority integration risks** (lock/pool/bridge interaction, error classification, orchestrator)
- **2 consolidation opportunities** (event bridge pattern, error classification pattern)

The critical fixes (Phase 1) should be completed before any individual bug fixes are merged, as they affect the stability of the concurrency stack that all provider interactions depend on.
