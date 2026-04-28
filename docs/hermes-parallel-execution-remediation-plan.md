# Hermes Provider Parallel Execution Bug Remediation Plan

## Summary

Four proven bugs in the Hermes provider break parallel execution in the DAG
executor. The root cause: `bridgeHermesSession()` registers Node.js stream
event handlers on a child process but never removes them, and the session pool
returns the same child process to concurrent callers. Claude, Codex, and Pi
providers are architecturally immune because they have no session pool and no
direct child process management.

---

## Bug Inventory

| # | Bug | Severity | File | Root Cause |
|---|-----|----------|------|------------|
| 1 | Stdout/stderr/exit/error handler leak | P0 | event-bridge.ts:178,287,338,379 | finally block (666-686) never removes these 4 handlers |
| 2 | Protocol ID collision on pooled reuse | P0 | event-bridge.ts:436, acp-protocol.ts:52 | `createAcpIdGenerator()` starts from 1 every bridge call |
| 3 | state.db contention (3 parallel hermes acp processes) | P2 | External (hermes subprocess) | 552MB SQLite DB with no busy_timeout tuning |
| 4 | No per-bridge unique ID offset | P0 | event-bridge.ts:436 | Same as #2 — no global monotonically increasing counter |

---

## P0 — MUST FIX (handler cleanup + id collision)

### P0-1: Remove stdout/stderr/exit/error handlers in finally block

**File:** packages/providers/src/hermes/event-bridge.ts

**Problem:** Lines 178, 287, 338, 379 register anonymous handlers on
childProcess.stdout, childProcess.stderr, childProcess 'exit', and
childProcess 'error'. The finally block (lines 666-686) only removes the
abort listener. When `keepAlive: true`, the process survives — subsequent
bridge calls pile up duplicate handlers. Each reuse adds another stdout
'data' handler that parses the same JSON-RPC messages, pushing duplicate
chunks to separate queues and corrupting state.

**Fix:** Extract all 4 handlers into named references and remove them in the
finally block.

**Changes at lines 147-172 (handler registration):**

```typescript
// BEFORE (line 178 — anonymous arrow):
childProcess.stdout.on('data', (data: Buffer | string) => {

// AFTER (named reference):
const onStdoutData = (data: Buffer | string) => {
  // ... (existing body unchanged)
};
childProcess.stdout.on('data', onStdoutData);
```

Apply the same pattern for:
- Line 287: `childProcess.stderr?.on('data', ...)` → `const onStderrData = ...; childProcess.stderr?.on('data', onStderrData);`
- Line 338: `childProcess.on('exit', ...)` → `const onExit = ...; childProcess.on('exit', onExit);`
- Line 379: `childProcess.on('error', ...)` → `const onError = ...; childProcess.on('error', onError);`

**Changes in finally block (lines 666-686):**

```typescript
// AFTER — add handler removal BEFORE queue.close():
} finally {
  // 1. Remove stream/process handlers to prevent leaks on pooled reuse.
  if (childProcess.stdout) {
    childProcess.stdout.removeListener('data', onStdoutData);
  }
  if (childProcess.stderr) {
    childProcess.stderr.removeListener('data', onStderrData);
  }
  childProcess.removeListener('exit', onExit);
  childProcess.removeListener('error', onError);

  // 2. Close queue (existing)
  queue.close();

  // 3. Remove abort listener (existing)
  if (abortSignal) {
    abortSignal.removeEventListener('abort', onAbort);
  }
  if (sigkillTimeout) {
    clearTimeout(sigkillTimeout);
  }

  // 4. Kill child if not keepAlive (existing)
  if (!options.skipInit && !options.keepAlive) {
    try {
      childProcess.kill('SIGKILL');
    } catch {
      // Process may already be gone
    }
  }
}
```

**Why remove BEFORE queue.close():** The stdout handler pushes to the queue.
If we close the queue first, the handler's push becomes a no-op (AsyncQueue
guards this), but the handler stays registered. Removing it first is cleaner
— no dangling references.

**Verification:**
```bash
# Unit test: call bridgeHermesSession() twice with same childProcess (keepAlive)
# and assert stdout.listenerCount('data') === 0 after each bridge returns.
bun test packages/providers/src/hermes/event-bridge.test.ts
```

---

### P0-2: Fix ID collision with global monotonic counter

**File:** packages/providers/src/hermes/event-bridge.ts (line 436)

**Problem:** Each call to `bridgeHermesSession()` creates a new
`createAcpIdGenerator()` that starts from 1 (acp-protocol.ts:52). When two
bridges share the same child process (via pool reuse for the same cwd+model
key), both send JSON-RPC requests with id=1, id=2, etc. The stdout handler
routes responses by `msg.id === pendingRequestId` (line 208) — but both
bridges' handlers see ALL stdout output. Bridge A's id=1 response gets
intercepted by Bridge B's handler, or vice versa.

**Fix (Option A — recommended):** Replace per-bridge generator with a
module-level atomic counter.

**File:** packages/providers/src/hermes/acp-protocol.ts

```typescript
// BEFORE (line 52-61):
export function createAcpIdGenerator(start = 1): AcpIdGenerator {
  let nextId = start;
  return {
    next: (): number => {
      const id = nextId;
      nextId = (nextId % Number.MAX_SAFE_INTEGER) + 1;
      return id;
    },
  };
}

// AFTER (add module-level counter + keep the original for backward compat):
let globalNextId = 1;

/**
 * Create a globally unique ID generator. Each call to next() returns a
 * monotonically increasing integer across ALL bridge instances, preventing
 * JSON-RPC id collision when multiple bridges share a child process.
 */
export function createAcpIdGenerator(): AcpIdGenerator {
  return {
    next: (): number => {
      const id = globalNextId;
      globalNextId = (globalNextId % Number.MAX_SAFE_INTEGER) + 1;
      return id;
    },
  };
}
```

**Alternative (Option B — if module-level state is rejected):** Pass a unique
offset per bridge call:

```typescript
// In event-bridge.ts line 436:
const idGen = createAcpIdGenerator(Date.now() % 1_000_000);
```

But this is fragile (clock skew, collisions). Option A is simpler and correct.

**Verification:**
```bash
# Test: create two id generators, interleave next() calls,
# assert no duplicates.
bun test packages/providers/src/hermes/acp-protocol.test.ts

# Integration test: two parallel bridge calls to same child process,
# assert no JSON-RPC id collision in logs.
bun test packages/providers/src/hermes/event-bridge.test.ts
```

---

## P1 — SHOULD FIX (pool isolation for parallel execution)

### P1-1: Prevent pool from returning sessions to concurrent callers

**File:** packages/providers/src/hermes/session-pool.ts

**Problem:** `HermesSessionPool.get()` (line 41) returns the same
`PooledSession` to multiple concurrent callers. The DAG executor runs
parallel nodes via `Promise.allSettled()` (dag-executor.ts:2533) — if two
parallel nodes share the same cwd+model key, both get the same pooled child
process. This triggers Bugs 1, 2, and 4 simultaneously.

**Fix:** Add an `inUse` flag. `get()` returns undefined when session is
already checked out. A new `release()` method returns it.

```typescript
export interface PooledSession {
  childProcess: ChildProcess;
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsed: number;
  inUse: boolean;           // ← NEW
}

export class HermesSessionPool {
  // ... existing fields ...

  get(cwd: string, model: string, provider?: string): PooledSession | undefined {
    const key = this.makeKey(cwd, model, provider);
    const session = this.sessions.get(key);
    if (session && !session.inUse) {       // ← ADD !inUse check
      session.lastUsed = Date.now();
      session.inUse = true;                // ← Mark as in-use
      return session;
    }
    return undefined;
  }

  /** Return a session to the pool for reuse. */
  release(cwd: string, model: string, provider?: string): void {
    const key = this.makeKey(cwd, model, provider);
    const session = this.sessions.get(key);
    if (session) {
      session.inUse = false;
    }
  }

  // ... rest unchanged ...
}
```

**File:** packages/providers/src/hermes/provider.ts

**Changes:**
- Line 239 (after `void bridge.return(undefined)`): call `this.pool.release(...)` to return the session
- Line 233 (catch block): evict session AND call `this.pool.release(...)` so it doesn't stay locked

```typescript
// In the pooled path finally block (line 236-240):
} finally {
  void bridge.return(undefined);
  // Return session to pool for reuse by next sequential call.
  this.pool.release(session.cwd, model, config.provider);
}
```

**Why this is the right fix (not removing the pool):**
- Sequential multi-turn (same node's context:shared) still benefits from
  pooling — no cold-start between prompt-response cycles.
- Parallel nodes with the same key correctly get fresh processes (no pool hit).
- Matches the DAG executor's intent: `isFresh = isParallelLayer` forces fresh.

**Verification:**
```bash
# Unit test: two concurrent get() calls with same key — second returns undefined.
bun test packages/providers/src/hermes/session-pool.test.ts

# Integration test: DAG with 2 parallel hermes nodes, same cwd+model.
# Assert: 2 child processes spawned (pool miss on second), no handler leak.
bun test packages/workflows/src/dag-executor.test.ts
```

---

### P1-2: Add pool session health check before reuse

**File:** packages/providers/src/hermes/provider.ts (line 201)

**Problem:** The existing check `!pooled.childProcess.killed && pooled.childProcess.exitCode === null` is insufficient. The process could be in a half-dead state (received SIGTERM, hasn't exited yet) or the stdin pipe could be broken.

**Fix:** Add a stdin writable check:

```typescript
// BEFORE (line 201):
if (pooled && !pooled.childProcess.killed && pooled.childProcess.exitCode === null) {

// AFTER:
if (
  pooled &&
  !pooled.childProcess.killed &&
  pooled.childProcess.exitCode === null &&
  pooled.childProcess.stdin !== null &&
  !pooled.childProcess.stdin.destroyed
) {
```

**Verification:**
```bash
# Test: pool a session, destroy its stdin, attempt reuse.
# Assert: pool miss → fresh spawn.
bun test packages/providers/src/hermes/provider.test.ts
```

---

## P2 — INVESTIGATE (state.db contention)

### P2-1: Document SQLite busy_timeout limitation

**File:** packages/providers/src/hermes/provider.ts (docstring) or README

**Problem:** When 3+ parallel hermes acp processes run simultaneously, they
all contend on the same 552MB `state.db` SQLite file. SQLite's default
busy_timeout is 0 — immediate SQLITE_BUSY error. This causes hangs in
`run_conversation()` when the DAG executor's `Promise.allSettled()` waits
for all parallel nodes.

**Not fixable in the provider layer.** This requires one of:
1. **Hermes upstream fix:** Add `PRAGMA busy_timeout = 30000` to hermes's
   SQLite connection. This is the correct fix — each hermes acp process
   should set a reasonable busy_timeout on its own DB handle.
2. **Serialize parallel hermes nodes in DAG executor:** Adds a mutex/semaphore
   so only one hermes node runs at a time. Violates parallelism contract.
3. **Separate state.db per process:** Use `--state-dir` flag if hermes
   supports it. Avoids contention entirely.

**Recommended action:** File upstream issue against hermes project requesting
`PRAGMA busy_timeout` configuration. Document in provider.ts docstring:

```typescript
/**
 * Known limitation: when multiple parallel DAG nodes use the Hermes provider
 * with the same cwd, they contend on hermes's state.db SQLite file. If hangs
 * occur, serialize hermes nodes in the workflow or use different cwds per node.
 * See: [upstream issue link]
 */
```

**Verification:**
```bash
# Reproduce: run DAG with 3 parallel hermes nodes, same cwd.
# Observe: SQLite BUSY errors in hermes stderr logs.
# After upstream fix: no BUSY errors.
bun test packages/workflows/src/dag-executor.test.ts -t "parallel hermes"
```

---

## Implementation Order

1. **P0-1** (handler cleanup) — standalone fix, no dependencies
2. **P0-2** (id collision) — standalone fix, no dependencies
3. **P1-1** (pool inUse flag) — depends on P0-1 being correct
4. **P1-2** (stdin health check) — standalone, small
5. **P2-1** (documentation) — standalone

P0-1 and P0-2 can be done in parallel. P1-1 should follow P0-1 because the
handler cleanup makes the pool safe for reuse after checkout/checkin.

---

## Files to Modify

| File | Changes | Lines Affected |
|------|---------|----------------|
| event-bridge.ts | Extract 4 handlers to named refs; remove in finally | ~178-296 (registration), 666-686 (finally) |
| acp-protocol.ts | Module-level globalNextId counter | ~52-61 |
| session-pool.ts | Add inUse field, get() guard, release() method | ~3-10 (interface), 41-48 (get), new release() |
| provider.ts | Call pool.release() in finally; add stdin check | ~201 (check), 236-240 (finally) |
| provider.ts | P2-1 docstring about state.db | ~114-138 (docstring) |

## Files to Create

| File | Purpose |
|------|---------|
| packages/providers/src/hermes/event-bridge.test.ts | Handler cleanup + id collision tests |
| packages/providers/src/hermes/session-pool.test.ts | inUse flag + release() tests |
| packages/providers/src/hermes/acp-protocol.test.ts | Global ID generator monotonicity test |

---

## Should the Session Pool Be Removed Entirely?

**No — fix it, don't remove it.**

Rationale:
- Claude/Codex/Pi avoid the pool because their SDKs manage subprocesses
  internally. Hermes uses raw child_process.spawn with ACP JSON-RPC — the
  pool is the only mechanism for multi-turn conversation continuity.
- Removing the pool would force a full cold-start (binary spawn + ACP
  handshake + session/new) on every prompt. For iterative workflows where a
  single node calls sendQuery() multiple times, this is a significant perf hit.
- The P1-1 fix (inUse flag) makes the pool safe for parallel execution while
  preserving sequential reuse benefits.
- The pool is 100 lines of simple code. Adding inUse + release is ~15 lines.
  Removing it and redesigning multi-turn would be much larger.

The pool's architecture is sound for sequential use. The bugs are specific
to concurrent access, which P0-1 + P0-2 + P1-1 comprehensively fix.
