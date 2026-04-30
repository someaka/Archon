# Hermes Provider Bug Fix Plan

**Date:** 2026-04-30
**Branch:** dev
**Verifier:** Pi
**Status:** PLANNED

---

## Overview

13 bugs across 4 files in the Hermes provider. Categorized by severity:

- **P0 (crash/leak):** #1 stdin error leak, #3 unhandled rejection, #4 timer leak, #5 lock starvation, #10 spawn crash, #12 unref
- **P1 (correctness):** #7 dead sessions, #8 zombie resurrect, #9 idle-timeout skew, #11 race condition, #13 dispose race
- **P2 (cleanup):** #2 drain leak, #6 unawaited cleanup

---

## File 1: `event-bridge.ts`

**Path:** `packages/providers/src/hermes/event-bridge.ts`

### Bug #1 — stdin error listener leak

**Lines:** 177 (declaration), 471-474 (anonymous once), 219-222 / 314-317 / 489-492 (cleanup refs)

**What's wrong:**
`stdinErrorHandler` is declared at line 177 but never assigned. Each call to `sendRequest()` creates an anonymous `childProcess.stdin.once('error', ...)` listener at line 471 that is **not** captured in `stdinErrorHandler`. The cleanup code at lines 219-222, 314-317, and 489-492 references `stdinErrorHandler` to remove it, but since it's always `undefined`, the cleanup is a no-op. Anonymous `once('error')` listeners accumulate, triggering `MaxListenersExceededWarning`.

**Fix:**

```typescript
// Line 471-474: Replace anonymous arrow with named reference
// BEFORE:
childProcess.stdin.once('error', err => {
  getLog().warn({ err }, 'acp.stdin_error');
  reject(new Error(`Hermes ACP stdin error: ${err.message}`));
});

// AFTER:
stdinErrorHandler = (err: Error) => {
  getLog().warn({ err }, 'acp.stdin_error');
  reject(new Error(`Hermes ACP stdin error: ${err.message}`));
};
childProcess.stdin.once('error', stdinErrorHandler);
```

**Verification:** Run `event-bridge.test.ts`. Add a test that calls `sendRequest` twice on a failing stdin and asserts no `MaxListenersExceededWarning`. Manual: check that `stdinErrorHandler` is `undefined` after response resolves.

**Risk:** Low. The handler was already conceptually supposed to be tracked; this just wires it up.

---

### Bug #2 — stdin drain listener leak

**Lines:** 477-480

**What's wrong:**
`childProcess.stdin.once('drain', ...)` at line 478 is created when `write()` returns `false` (backpressure). If the process dies before `drain` fires, this listener remains attached to stdin. It's never removed in the `finally` cleanup block (lines 715-741). Over time with pooled sessions (same ChildProcess reused), these accumulate.

**Fix:**

```typescript
// Line 178 area: Add a drain handler tracker
let drainHandler: (() => void) | undefined;

// Lines 477-480: Assign the drain handler
if (!canWrite) {
  drainHandler = () => {
    getLog().debug('acp.stdin_drain_complete');
  };
  childProcess.stdin.once('drain', drainHandler);
}

// In the finally block (around line 730), add:
if (drainHandler && childProcess.stdin) {
  childProcess.stdin.removeListener('drain', drainHandler);
  drainHandler = undefined;
}
```

**Verification:** Run `event-bridge.test.ts`. Inspect listener count on mock stdin after bridge completes with backpressure.

**Risk:** Very low. Drain is fire-and-forget logging; removing it early has no behavioral impact.

---

### Bug #3 — Unhandled rejection from fire-and-forget `executePrompt`

**Lines:** 689

**What's wrong:**
`void executePrompt()` discards the returned promise. If `queue.close()` is called (by abort handler at line 444), the consumer loop exits, but `executePrompt` may still be in-flight. While most errors are caught internally by the try/catch at lines 628-684, if the abort fires during `sendRequest`'s `Promise.race`, the race can reject from the timeout promise (line 483-496) **after** the internal catch has already run — or the `executePrompt` function itself can throw before its try block (lines 612-627). Either path produces an unhandled rejection warning/crash.

**Fix:**

```typescript
// Line 689: Add .catch() handler
// BEFORE:
void executePrompt();

// AFTER:
void executePrompt().catch(err => {
  getLog().warn({ err }, 'hermes.bridge.execute_prompt_unhandled');
});
```

**Verification:** Simulate abort mid-prompt in test. Verify no `UnhandledPromiseRejectionWarning`. Run existing `event-bridge.test.ts` abort tests.

**Risk:** Very low. The error was always swallowed by the queue being closed; this just makes it explicit and prevents Node.js warnings.

---

### Bug #4 — `activeTimers` leak on process death

**Lines:** 178 (declaration), 307-318 (`rejectPending`)

**What's wrong:**
`rejectPending()` rejects the pending request promise (line 309) but does NOT clear the corresponding timeout timer in the `activeTimers` Map. When the timer fires later (up to 30s for REQUEST_TIMEOUT or 5min for PROMPT_TIMEOUT), its closure holds references to `pendingRequestId`, `requestResolve`, `requestReject` — keeping the entire closure scope alive. The timer also tries to call `reject()` on an already-settled promise (harmless but wasteful).

**Fix:**

```typescript
// In rejectPending(), after rejecting and before the stdin cleanup, add:
function rejectPending(reason: string): void {
  if (requestReject) {
    requestReject(new Error(reason));
    requestReject = undefined;
    requestResolve = undefined;
    pendingRequestId = undefined;
  }
  // NEW: Clear all active timers to prevent stale closures
  for (const [id, timer] of activeTimers) {
    clearTimeout(timer);
    activeTimers.delete(id);
  }
  if (stdinErrorHandler && childProcess.stdin) {
    childProcess.stdin.removeListener('error', stdinErrorHandler);
    stdinErrorHandler = undefined;
  }
}
```

**Verification:** Run `event-bridge.test.ts`. In a test that triggers process exit mid-request, assert `activeTimers.size === 0` after the bridge completes (expose via a test hook or inspect the mock's timer calls).

**Risk:** Low. Clearing a timer on an already-rejected promise is a no-op.

---

## File 2: `provider.ts`

**Path:** `packages/providers/src/hermes/provider.ts`

### Bug #5 — Lock held across retries and exponential backoff

**Lines:** 193 (acquire), 196-213 (retry loop), 210 (backoff sleep), 216 (release)

**What's wrong:**
`this.lock.acquire()` at line 193 wraps the entire retry loop including backoff sleeps. With 3 retries and delays of 2s, 4s, 8s, a single retrying query holds the concurrency semaphore for 14+ seconds **beyond** the actual execution time. With `maxConcurrency=3`, this can starve all other queries.

**Fix:**
Restructure so the lock is acquired/released per-attempt, not across the entire retry loop:

```typescript
async *sendQuery(
  prompt: string,
  cwd: string,
  resumeSessionId?: string,
  options?: SendQueryOptions
): AsyncGenerator<MessageChunk> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
    if (options?.abortSignal?.aborted) throw new Error('Query aborted');
    await this.lock.acquire();
    try {
      yield* this._sendQueryOnce(prompt, cwd, resumeSessionId, options);
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classified =
        error instanceof HermesClassifiedError
          ? error.classification
          : classifyHermesError(error.message);
      if (!classified.shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) throw error;
      lastError = error;
    } finally {
      this.lock.release();
    }
    // Backoff sleeps OUTSIDE the lock
    const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
    getLog().info({ attempt, delayMs }, 'hermes.retrying_query');
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw lastError ?? new Error('Hermes query failed after retries');
}
```

**Verification:** Write a test: start 3 concurrent `sendQuery` calls that all fail with retryable errors. Assert that a 4th call can acquire the lock during the backoff window (within 1 second). Run `provider.test.ts`.

**Risk:** Medium. The lock-per-attempt pattern means other queries can interleave between retries. This is **desired** behavior (better throughput), but if the underlying Hermes binary has state issues with concurrent access, it could surface. The existing `maxConcurrency=3` still limits parallel execution. Test carefully.

---

### Bug #6 — Unawaited generator cleanup races with pool hand-off

**Lines:** 283

**What's wrong:**
`void clientPrompt.return(undefined)` at line 283 is fire-and-forget. The bridge's `finally` block may still be running (removing listeners, closing queue) when `this.pool.release()` at line 280 marks the session as available. Another caller could `acquire()` the session and start a new bridge before the old bridge's cleanup completes, leading to overlapping listener removals on the same ChildProcess.

**Fix:**

```typescript
// Lines 277-284: Await cleanup before releasing
// BEFORE:
} finally {
  this.pool.release(session.cwd, model, config.provider);
  void clientPrompt.return(undefined);
}

// AFTER:
} finally {
  try {
    await clientPrompt.return(undefined);
  } catch {
    // Cleanup may throw if bridge already closed — safe to ignore
  }
  this.pool.release(session.cwd, model, config.provider);
}
```

Note: `await` the cleanup **before** `release()` so the session isn't handed out while cleanup is in progress.

**Verification:** Run `provider.test.ts` pooled session tests. Add a test that verifies listener count on the mock ChildProcess after a pooled query completes.

**Risk:** Low. The `await` adds a small latency before the session is reusable, but this is correctness-critical. The try/catch prevents cleanup errors from propagating.

---

## File 3: `session-pool.ts`

**Path:** `packages/providers/src/hermes/session-pool.ts`

### Bug #7 — `acquire()` hands out dead sessions

**Lines:** 56-68

**What's wrong:**
`acquire()` checks `session.inUse` (line 60) but never checks `session.client.isAlive()`. If the child process exited (OOM, crash, external kill), the session object remains in the pool with `inUse: false`. The next `acquire()` call hands it out, and the caller gets a dead client.

**Fix:**

```typescript
acquire(cwd: string, model: string, provider?: string): PooledSession | undefined {
  const key = this.makeKey(cwd, model, provider);
  const session = this.sessions.get(key);
  if (session) {
    if (session.inUse) {
      return undefined;
    }
    // NEW: Check if the underlying process is still alive
    if (!session.client.isAlive()) {
      this.killSession(session);
      this.sessions.delete(key);
      return undefined;
    }
    session.inUse = true;
    session.lastUsed = Date.now();
    return session;
  }
  return undefined;
}
```

**Verification:** Add test: create pool, set a session, kill the client's process, call `acquire()`, assert it returns `undefined` and the pool size is 0.

**Risk:** Very low. Dead sessions are useless; eagerly evicting them is strictly better than handing them out.

---

### Bug #8 — `release()` resurrects zombies

**Lines:** 74-80

**What's wrong:**
`release()` unconditionally sets `session.inUse = false` at line 78, even if the session's process has died while it was acquired. This makes a dead session appear available for re-acquisition (compounding bug #7).

**Fix:**

```typescript
release(cwd: string, model: string, provider?: string): void {
  const key = this.makeKey(cwd, model, provider);
  const session = this.sessions.get(key);
  if (session) {
    // NEW: If process died while in use, evict instead of releasing
    if (!session.client.isAlive()) {
      this.killSession(session);
      this.sessions.delete(key);
      return;
    }
    session.inUse = false;
  }
}
```

**Verification:** Add test: acquire a session, kill its process, release it, assert pool size is 0 and session is gone.

**Risk:** Very low. Releasing a dead session was always a bug. Provider.ts already has a `delete()` call on error paths (line 274), but `release()` in the `finally` block at line 280 runs unconditionally.

---

### Bug #9 — `get()` skews idle-timeout accounting

**Lines:** 42-49

**What's wrong:**
`get()` updates `session.lastUsed = Date.now()` at line 46. This means any read-only access (e.g., checking if a session exists) resets the idle timer. The idle timeout is supposed to measure time since the session was **actually used** for a query, not since it was last inspected.

Currently `get()` is not called from production code in a way that triggers this (the provider uses `acquire()`), but it's a latent bug — any future `get()` call would silently extend session lifetime.

**Fix:**

```typescript
get(cwd: string, model: string, provider?: string): PooledSession | undefined {
  const key = this.makeKey(cwd, model, provider);
  const session = this.sessions.get(key);
  // REMOVED: session.lastUsed = Date.now();
  // lastUsed is only updated by acquire() when the session is actually used
  return session;
}
```

**Note:** This will break the test `'set + get returns the session and updates lastUsed'` (line 40-48 in session-pool.test.ts) and `'cleanup timer kills only idle sessions, not recently-used ones'` (line 143-164) which uses `get()` to keep a session alive. Update those tests to use `acquire()`/`release()` instead.

**Verification:** Update affected tests. Run `session-pool.test.ts`. Verify idle timeout still works correctly with acquire/release.

**Risk:** Low-medium. The behavioral change is intentional, but tests that rely on `get()` resetting `lastUsed` need updating. The `cleanup timer` test at line 143 uses `pool.get()` in an interval to keep a session alive — change to `pool.acquire()` + `pool.release()`.

---

## File 4: `acp-client.ts`

**Path:** `packages/providers/src/hermes/acp-client.ts`

### Bug #10 — Unhandled spawn errors

**Lines:** 51-57 (constructor)

**What's wrong:**
`spawn()` at line 52 attaches zero event listeners. If the binary doesn't exist (ENOENT), `spawn` emits an `'error'` event on the ChildProcess. With no listeners, Node.js treats this as an unhandled error and crashes the process (or emits `uncaughtException`).

The `init()` and `prompt()` methods delegate to `bridgeHermesSession()` which attaches an `error` handler, but there's a window between construction and the first `init()`/`prompt()` call where errors are unhandled.

**Fix:**

```typescript
export class HermesAcpClient {
  private _childProcess: ChildProcess;
  private _sessionId: string | undefined;
  private _activeBridge: AsyncGenerator<MessageChunk> | undefined;
  private _disposed = false;
  private _spawnError: Error | undefined;  // NEW

  constructor(private config: HermesAcpClientConfig) {
    this._childProcess = spawn(config.binary, config.args ?? ['acp'], {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // NEW: Capture spawn errors (ENOENT, EACCES) so init()/prompt() can surface them
    this._childProcess.on('error', (err) => {
      this._spawnError = err;
    });
  }
```

Then in `init()` and `prompt()`, check for spawn errors:

```typescript
async *init(prompt: string, options?: ...): AsyncGenerator<MessageChunk> {
  if (this._disposed) throw new Error('HermesAcpClient has been disposed');
  if (this._spawnError) throw this._spawnError;  // NEW
  // ... rest unchanged
}

async *prompt(prompt: string, options?: ...): AsyncGenerator<MessageChunk> {
  if (this._disposed) throw new Error('HermesAcpClient has been disposed');
  if (this._spawnError) throw this._spawnError;  // NEW
  if (!this._sessionId) throw new Error('No active session. Call init() first.');
  // ... rest unchanged
}
```

**Verification:** Add test: spawn with non-existent binary, call `init()`, assert it throws with ENOENT. Run `acp-client.test.ts`.

**Risk:** Very low. This adds error handling that was missing. The `error` listener is also cleaned up when `dispose()` kills the process (SIGKILL → process exits → EventEmitter cleans up).

---

### Bug #11 — No mutual exclusion between `init()` and `prompt()`

**Lines:** 88-121 (`init`), 130-164 (`prompt`)

**What's wrong:**
Both `init()` and `prompt()` create a new bridge (`bridgeHermesSession`) and assign it to `this._activeBridge`. If called concurrently (e.g., two `prompt()` calls on the same client), both bridges would attach overlapping `data`/`exit`/`error` listeners to the same ChildProcess stdout/stdin, corrupting the ACP protocol stream.

In practice, the provider holds the session pool's `inUse` flag, so concurrent calls are unlikely **through the provider**. But the `HermesAcpClient` class itself offers no protection.

**Fix:**

```typescript
export class HermesAcpClient {
  // ... existing fields
  private _operationInProgress = false;  // NEW

  async *init(prompt: string, options?: ...): AsyncGenerator<MessageChunk> {
    if (this._disposed) throw new Error('HermesAcpClient has been disposed');
    if (this._spawnError) throw this._spawnError;
    if (this._operationInProgress) throw new Error('Another operation is in progress');  // NEW
    this._operationInProgress = true;  // NEW

    const bridge = bridgeHermesSession(/* ... */);
    this._activeBridge = bridge;
    try {
      for await (const chunk of bridge) {
        if (chunk.type === 'result' && chunk.sessionId) {
          this._sessionId = chunk.sessionId;
        }
        yield chunk;
      }
    } finally {
      this._activeBridge = undefined;
      this._operationInProgress = false;  // NEW
    }
  }

  async *prompt(prompt: string, options?: ...): AsyncGenerator<MessageChunk> {
    if (this._disposed) throw new Error('HermesAcpClient has been disposed');
    if (this._spawnError) throw this._spawnError;
    if (this._operationInProgress) throw new Error('Another operation is in progress');  // NEW
    if (!this._sessionId) throw new Error('No active session. Call init() first.');
    this._operationInProgress = true;  // NEW

    const bridge = bridgeHermesSession(/* ... */);
    this._activeBridge = bridge;
    try {
      for await (const chunk of bridge) {
        yield chunk;
      }
    } finally {
      this._activeBridge = undefined;
      this._operationInProgress = false;  // NEW
    }
  }
```

**Verification:** Add test: start `init()`, concurrently call `prompt()` on same client, assert it throws. Run `acp-client.test.ts`.

**Risk:** Low. The guard prevents a real corruption scenario. Any caller hitting this guard has a bug in their own code.

---

### Bug #12 — Missing `unref()` in constructor

**Lines:** 51-57

**What's wrong:**
The constructor spawns a child process but does NOT call `this._childProcess.unref()`. If the `HermesAcpClient` is created but never pooled or used (e.g., an error occurs between construction and `init()`), the child process keeps the Node.js event loop alive, preventing clean shutdown.

The `bridgeHermesSession` function does call `childProcess.unref()` (event-bridge.ts line 158), but only when the bridge starts — there's a window between spawn and bridge creation where the process is ref'd.

The session pool's `set()` method also calls `session.client.childProcess.unref()` (session-pool.ts line 89), but again only at pool insertion time.

**Fix:**

```typescript
constructor(private config: HermesAcpClientConfig) {
  this._childProcess = spawn(config.binary, config.args ?? ['acp'], {
    cwd: config.cwd,
    env: config.env ? { ...process.env, ...config.env } : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // NEW: Prevent child process from keeping parent alive
  this._childProcess.unref();

  this._childProcess.on('error', (err) => {
    this._spawnError = err;
  });
}
```

**Note:** `unref()` is idempotent — calling it again in `bridgeHermesSession` or `sessionPool.set()` is safe.

**Verification:** Create a `HermesAcpClient`, do NOT call `init()`, do NOT dispose. Verify Node.js process exits cleanly (test via `setTimeout(() => process.exit(0), 100)` pattern).

**Risk:** Very low. `unref()` is idempotent and only affects whether the event loop waits for the child.

---

### Bug #13 — Dispose does not await bridge cleanup

**Lines:** 175-191

**What's wrong:**
`void this._activeBridge.return(undefined)` at line 181 is fire-and-forget. The immediately following `this._childProcess.kill('SIGKILL')` at line 187 can fire before the bridge's `finally` block completes (which removes listeners, closes the queue). This creates a race: the bridge's cleanup code runs after the process is already dead, potentially hitting errors when trying to interact with dead stdio streams.

**Fix:**

```typescript
async dispose(): Promise<void> {  // NOTE: now async
  if (this._disposed) return;
  this._disposed = true;

  // Signal active bridge to clean up handlers and AWAIT completion
  if (this._activeBridge) {
    try {
      await this._activeBridge.return(undefined);
    } catch {
      // Cleanup may throw — safe to ignore
    }
    this._activeBridge = undefined;
  }

  // Kill the child process AFTER bridge cleanup is complete
  try {
    this._childProcess.kill('SIGKILL');
  } catch {
    // Process may already be dead (ESRCH) or we lack permissions (EPERM)
  }
}
```

**Important:** `dispose()` becomes `async`, returning `Promise<void>`. All callers must `await` it.

**Callers to update:**

- `provider.ts` line 436: `client.dispose()` → `await client.dispose()`
- `session-pool.ts` line 104: `session.client.dispose()` → make `killSession` async
- `provider.ts` line 274: `this.pool.delete(...)` → make `delete` async (or accept the fire-and-forget here since the pool handles it)

**Alternative (less invasive):** Keep `dispose()` synchronous but add a small delay:

```typescript
dispose(): void {
  if (this._disposed) return;
  this._disposed = true;

  if (this._activeBridge) {
    // Trigger cleanup; don't await but give it a microtask to run
    const bridge = this._activeBridge;
    this._activeBridge = undefined;
    void bridge.return(undefined).catch(() => {});
  }

  // Kill after a microtask to let bridge cleanup start
  queueMicrotask(() => {
    try {
      this._childProcess.kill('SIGKILL');
    } catch {}
  });
}
```

**Recommendation:** Use the async approach. The synchronous alternative with `queueMicrotask` is fragile. Making `dispose()` async requires updating `killSession` and `delete` in the pool to be async too, but this is straightforward.

**Verification:** Add test: start a prompt, call `await dispose()`, verify no race warnings and process is killed. Run `acp-client.test.ts`.

**Risk:** Medium. Changing `dispose()` to async is a signature change. The pool's `killSession` becomes async, which affects `cleanup()`, `destroy()`, and `delete()`. These are all fire-and-forget in the current code, so making them async and using `void killSession(...)` (with `.catch()`) preserves behavior while enabling awaiting when needed.

---

## Test Updates Required

### `session-pool.test.ts`

1. **Line 40-48** (`set + get returns the session and updates lastUsed`): Update to not expect `lastUsed` to change on `get()`. Or test that `acquire()` updates `lastUsed` instead.
2. **Line 143-164** (`cleanup timer kills only idle sessions`): Change `pool.get('/dir2', 'm2')` to `pool.acquire('/dir2', 'm2')` + `pool.release('/dir2', 'm2')` in the keep-alive interval.
3. **New tests needed:**
   - `acquire() returns undefined and evicts dead session`
   - `release() evicts dead session instead of releasing`
   - `dispose() awaits bridge cleanup (no race with SIGKILL)`

### `acp-client.test.ts`

1. **New tests needed:**
   - `constructor captures spawn ENOENT error, init() throws it`
   - `concurrent init()/prompt() throws`
   - `unref() is called in constructor`
   - `dispose() awaits bridge cleanup before SIGKILL`

### `event-bridge.test.ts`

1. **New tests needed:**
   - `stdin error handler is properly tracked and cleaned up`
   - `drain listener is cleaned up in finally block`
   - `executePrompt rejection does not produce unhandled rejection`
   - `activeTimers are cleared on process exit`

### `provider.test.ts`

1. **New tests needed:**
   - `lock is released during retry backoff (other queries can proceed)`
2. **Existing tests:** Should pass unchanged after the lock restructuring.

---

## Execution Order

Recommended order to minimize merge conflicts and maximize incremental testability:

| Step | Bug(s)     | File                            | Rationale                           |
| ---- | ---------- | ------------------------------- | ----------------------------------- |
| 1    | #12        | acp-client.ts                   | Trivial one-liner, zero risk        |
| 2    | #10        | acp-client.ts                   | Simple spawn error capture          |
| 3    | #11        | acp-client.ts                   | Simple guard flag                   |
| 4    | #4         | event-bridge.ts                 | Timer cleanup in rejectPending      |
| 5    | #1         | event-bridge.ts                 | stdin handler wiring                |
| 6    | #2         | event-bridge.ts                 | drain listener tracking             |
| 7    | #3         | event-bridge.ts                 | .catch() on executePrompt           |
| 8    | #7, #8, #9 | session-pool.ts                 | Pool liveness checks + get() fix    |
| 9    | #6         | provider.ts                     | Await clientPrompt.return()         |
| 10   | #5         | provider.ts                     | Lock restructuring (biggest change) |
| 11   | #13        | acp-client.ts + pool + provider | Async dispose (most invasive)       |
| 12   | —          | All test files                  | New tests for all fixes             |

---

## Files Modified

| File                                                 | Bugs Fixed         | Change Size |
| ---------------------------------------------------- | ------------------ | ----------- |
| `packages/providers/src/hermes/event-bridge.ts`      | #1, #2, #3, #4     | ~30 lines   |
| `packages/providers/src/hermes/provider.ts`          | #5, #6             | ~25 lines   |
| `packages/providers/src/hermes/session-pool.ts`      | #7, #8, #9         | ~20 lines   |
| `packages/providers/src/hermes/acp-client.ts`        | #10, #11, #12, #13 | ~40 lines   |
| `packages/providers/src/hermes/session-pool.test.ts` | test updates       | ~30 lines   |
| `packages/providers/src/hermes/acp-client.test.ts`   | new tests          | ~60 lines   |
| `packages/providers/src/hermes/event-bridge.test.ts` | new tests          | ~50 lines   |
| `packages/providers/src/hermes/provider.test.ts`     | new test           | ~20 lines   |

---

## Verification Commands

```bash
# Run all Hermes provider tests
cd /home/d/Desktop/Archon-canonical
bun test packages/providers/src/hermes/

# Run individual test files
bun test packages/providers/src/hermes/event-bridge.test.ts
bun test packages/providers/src/hermes/session-pool.test.ts
bun test packages/providers/src/hermes/acp-client.test.ts
bun test packages/providers/src/hermes/provider.test.ts
bun test packages/providers/src/hermes/concurrency-lock.test.ts
bun test packages/providers/src/hermes/error-classifier.test.ts

# Check for TypeScript errors
bunx tsc --noEmit -p packages/providers/tsconfig.json

# Full test suite
bun test
```
