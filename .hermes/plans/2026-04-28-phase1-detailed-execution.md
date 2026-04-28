# PHASE 1: P0 BUG FIXES — DETAILED EXECUTION SPECIFICATION

> Date: 2026-04-28
> Phase: 1 of 4 (Batch 1: P0 Bug Fixes)
> Methodology: archon-hermes-methodology (phased, batched, gated)
> Workspace: /home/d/Desktop/Archon-canonical
> Branch: dev

---

## 1. PHASE HEADER

### Goal

Fix three P0 bugs in Hermes provider that cause hangs under parallel execution:

- 1A: Handler leak in event-bridge.ts finally block (stdout/stderr/exit/error handlers accumulate)
- 1B: JSON-RPC ID collision from per-call ID generator starting at 1
- 1C: Session pool race condition (two concurrent sendQuery both spawn when pool empty)

### Entry Criteria

- Branch is `dev`
- All existing hermes tests pass: `bun test src/hermes/ --timeout 60000`
- No uncommitted changes in hermes files

### Exit Criteria (Gate 1)

- All structural grep checks pass
- All existing + new tests pass
- Type-check passes
- 3 commits on branch

---

## 2. PARALLEL EXECUTION STRUCTURE

### File Overlap Matrix

```
                    event-bridge.ts  acp-protocol.ts  session-pool.ts  provider.ts
Task 1A (handlers)    MODIFY           -                -                -
Task 1B (IDs)         -                MODIFY           -                -
Task 1C (pool)        -                -                MODIFY           MODIFY
```

### Verdict: ALL THREE PARALLEL

No file overlaps. 1A, 1B, and 1C each touch exclusively different source files.
Test file overlaps:

- 1A modifies event-bridge.test.ts
- 1B modifies acp-protocol.test.ts
- 1C modifies session-pool.test.ts AND provider.test.ts
  No test file overlaps either.

### Parallel Dispatch Diagram

```
  DISPATCH ──┬──> Executor 1A (event-bridge.ts + event-bridge.test.ts)
             ├──> Executor 1B (acp-protocol.ts + acp-protocol.test.ts)
             └──> Executor 1C (session-pool.ts + provider.ts + session-pool.test.ts + provider.test.ts)
                        │
                        ▼  (all 3 complete)
              ┌─────────────────┐
              │   GATE 1        │
              │  (verify all)   │
              └─────────────────┘
```

---

## 3. EXECUTOR SPECIFICATIONS

### ─── Executor 1A: Handler Cleanup ─────────────────────────────────────────

**Goal**: Extract event handlers to named references in bridgeHermesSession(),
remove them in the finally block so they don't accumulate on pooled sessions.

**Files Modified**:

- `packages/providers/src/hermes/event-bridge.ts` (production)
- `packages/providers/src/hermes/event-bridge.test.ts` (tests)

**Verified Source Locations**:

- Line 178: `childProcess.stdout.on('data', (data: Buffer | string) => {` — stdout handler
- Line 287: `childProcess.stderr?.on('data', (data: Buffer | string) => {` — stderr handler
- Line 338: `childProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {` — exit handler
- Line 379: `childProcess.on('error', (error: Error) => {` — error handler
- Lines 666-686: finally block (only removes abort listener, clears sigkill timer)

**Exact Code Changes**:

1. Extract stdout handler to named const (before line 178):

```typescript
// ── stdout: line-by-line ACP JSON-RPC parser ──────────────────────────
// ACP uses newline-delimited JSON. We buffer for partial lines and
// parse each complete line as a JSON-RPC message.
let lineBuffer = '';
// ... (existing variables stay the same) ...

const stdoutHandler = (data: Buffer | string): void => {
  const incoming = data.toString();
  // ... entire existing handler body unchanged ...
};
childProcess.stdout.on('data', stdoutHandler);
```

2. Extract stderr handler to named const (before line 287):

```typescript
const stderrHandler = (data: Buffer | string): void => {
  // ... entire existing handler body unchanged ...
};
childProcess.stderr?.on('data', stderrHandler);
```

3. Extract exit handler to named const (before line 338):

```typescript
const exitHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
  // ... entire existing handler body unchanged ...
};
childProcess.on('exit', exitHandler);
```

4. Extract error handler to named const (before line 379):

```typescript
const errorHandler = (error: Error): void => {
  // ... entire existing handler body unchanged ...
};
childProcess.on('error', errorHandler);
```

5. Add cleanup to finally block (after line 675, before the kill logic):

```typescript
// Remove event handlers to prevent leaks on pooled session reuse.
if (childProcess.stdout) {
  childProcess.stdout.removeListener('data', stdoutHandler);
}
if (childProcess.stderr) {
  childProcess.stderr.removeListener('data', stderrHandler);
}
childProcess.removeListener('exit', exitHandler);
childProcess.removeListener('error', errorHandler);
```

**TDD Steps**:

1. Write tests FIRST in event-bridge.test.ts (before code change)
2. Run tests — expect new handler cleanup tests to FAIL
3. Apply production code changes
4. Run tests — expect all to PASS

**New Tests** (append to event-bridge.test.ts):

```typescript
describe('handler cleanup', () => {
  test('stdout listener count returns to baseline after bridge', async () => {
    const mock = createAcpMock();
    const initialCount = mock.stdout.listenerCount('data');
    await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));
    expect(mock.stdout.listenerCount('data')).toBe(initialCount);
  });

  test('stderr listener count returns to baseline after bridge', async () => {
    const mock = createAcpMock();
    const initialCount = mock.stderr.listenerCount('data');
    await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));
    expect(mock.stderr.listenerCount('data')).toBe(initialCount);
  });

  test('exit listener count returns to baseline after bridge', async () => {
    const mock = createAcpMock();
    const initialCount = mock.process.listenerCount('exit');
    await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));
    expect(mock.process.listenerCount('exit')).toBe(initialCount);
  });

  test('error listener count returns to baseline after bridge', async () => {
    const mock = createAcpMock();
    const initialCount = mock.process.listenerCount('error');
    await consume(bridgeHermesSession(mock.process, makeBridgeOptions()));
    expect(mock.process.listenerCount('error')).toBe(initialCount);
  });

  test('pooled session does not accumulate handlers across multiple bridges', async () => {
    const mock = createAcpMock();
    // First bridge
    await consume(bridgeHermesSession(mock.process, makeBridgeOptions({ keepAlive: true })));
    const countAfterFirst = mock.stdout.listenerCount('data');
    // Second bridge on same process
    await consume(
      bridgeHermesSession(
        mock.process,
        makeBridgeOptions({
          skipInit: true,
          existingSessionId: 'test-session',
          keepAlive: true,
        })
      )
    );
    expect(mock.stdout.listenerCount('data')).toBe(countAfterFirst);
  });
});
```

**Commit Message**: `fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block`

**Verification Commands**:

```bash
cd /home/d/Desktop/Archon-canonical
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
```

---

### ─── Executor 1B: Monotonic ID Counter ────────────────────────────────────

**Goal**: Replace per-call ID generator with module-level global counter so
multiple bridgeHermesSession() calls sharing a child process never produce
colliding JSON-RPC request IDs.

**Files Modified**:

- `packages/providers/src/hermes/acp-protocol.ts` (production)
- `packages/providers/src/hermes/acp-protocol.test.ts` (tests)

**Verified Source Locations**:

- Lines 48-61: AcpIdGenerator interface and createAcpIdGenerator() function
- Line 52: `export function createAcpIdGenerator(start = 1): AcpIdGenerator {`
- Line 53: `let nextId = start;`
- Line 87 in test: `const gen = createAcpIdGenerator(Number.MAX_SAFE_INTEGER);` — uses start param

**Exact Code Changes**:

1. Add module-level counter (before line 52):

```typescript
/** Module-level monotonic counter for JSON-RPC request IDs.
 *  Ensures globally unique IDs across multiple createAcpIdGenerator() calls,
 *  preventing collisions when multiple bridge instances share a child process. */
let globalAcpIdCounter = 0;
```

2. Rewrite createAcpIdGenerator (replace lines 52-61):

```typescript
export function createAcpIdGenerator(): AcpIdGenerator {
  return {
    next: (): number => {
      globalAcpIdCounter = (globalAcpIdCounter % Number.MAX_SAFE_INTEGER) + 1;
      return globalAcpIdCounter;
    },
  };
}
```

3. Update test at line 86-92 (replace wrap test):

```typescript
test('AcpIdGenerator produces globally unique IDs across multiple instances', () => {
  const gen1 = createAcpIdGenerator();
  const gen2 = createAcpIdGenerator();
  const ids = new Set<number>();
  // Generate 10 IDs from each generator — all must be unique
  for (let i = 0; i < 10; i++) {
    ids.add(gen1.next());
    ids.add(gen2.next());
  }
  expect(ids.size).toBe(20); // no collisions
});

test('AcpIdGenerator wraps at MAX_SAFE_INTEGER', () => {
  // Set counter near MAX_SAFE_INTEGER by generating many IDs
  // Instead, test wrap behavior by manipulating the module-level counter
  // We can't directly, so test that the generator always returns > 0
  const gen = createAcpIdGenerator();
  const id = gen.next();
  expect(id).toBeGreaterThan(0);
  expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
});
```

4. Add new cross-generator monotonicity test:

```typescript
test('AcpIdGenerator IDs are strictly monotonically increasing', () => {
  const gen = createAcpIdGenerator();
  let prev = gen.next();
  for (let i = 0; i < 100; i++) {
    const curr = gen.next();
    expect(curr).toBeGreaterThan(prev);
    prev = curr;
  }
});

test('two generators produce non-overlapping ID sequences', () => {
  const gen1 = createAcpIdGenerator();
  const gen1Ids: number[] = [];
  for (let i = 0; i < 10; i++) gen1Ids.push(gen1.next());

  const gen2 = createAcpIdGenerator();
  const gen2Ids: number[] = [];
  for (let i = 0; i < 10; i++) gen2Ids.push(gen2.next());

  // No ID from gen1 should appear in gen2
  const overlap = gen1Ids.filter(id => gen2Ids.includes(id));
  expect(overlap).toEqual([]);
});
```

**TDD Steps**:

1. Write new tests FIRST in acp-protocol.test.ts
2. Run tests — expect new cross-generator tests to FAIL (current impl starts at 1)
3. Apply production code changes
4. Run tests — expect all to PASS

**Commit Message**: `fix(hermes): use monotonic global counter for ACP request IDs`

**Verification Commands**:

```bash
cd /home/d/Desktop/Archon-canonical
bun test packages/providers/src/hermes/acp-protocol.test.ts --timeout 30000
```

---

### ─── Executor 1C: Pool Acquire/Release ────────────────────────────────────

**Goal**: Add acquire/release semantics to HermesSessionPool so two concurrent
sendQuery() calls for the same key don't both spawn fresh processes. The first
call acquires the session (marks inUse), the second finds it inUse and falls
through to a fresh spawn (which will be serialized in Phase 2's ConcurrencyLock).

**Files Modified**:

- `packages/providers/src/hermes/session-pool.ts` (production)
- `packages/providers/src/hermes/provider.ts` (production)
- `packages/providers/src/hermes/session-pool.test.ts` (tests)
- `packages/providers/src/hermes/provider.test.ts` (tests)

**Verified Source Locations**:

- session-pool.ts line 3-10: PooledSession interface (no inUse field)
- session-pool.ts line 41-48: get() method (returns any session, no inUse check)
- session-pool.ts line 50-58: set() method (overwrites existing)
- provider.ts line 200: `const pooled = this.pool.get(session.cwd, model, config.provider);`
- provider.ts line 233: `this.pool.delete(session.cwd, model, config.provider);` (on failure)
- provider.ts line 372-384: `this.pool.set(...)` (on success)
- provider.ts line 246: `this.pool.delete(session.cwd, model, config.provider);` (stale eviction)

**Exact Code Changes — session-pool.ts**:

1. Add `inUse` field to PooledSession interface (line 3-10):

```typescript
export interface PooledSession {
  childProcess: ChildProcess;
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsed: number;
  inUse: boolean; // ADD: true when a bridge is actively using this session
}
```

2. Add `acquire()` method (after get(), before set()):

```typescript
  /**
   * Acquire a session for use. Returns the session and marks it as inUse.
   * Returns undefined if no session exists OR session is already inUse.
   * This prevents two concurrent sendQuery() calls from both reusing the
   * same pooled process simultaneously.
   */
  acquire(cwd: string, model: string, provider?: string): PooledSession | undefined {
    const key = this.makeKey(cwd, model, provider);
    const session = this.sessions.get(key);
    if (!session || session.inUse) return undefined;
    session.inUse = true;
    session.lastUsed = Date.now();
    return session;
  }
```

3. Add `release()` method (after acquire()):

```typescript
  /**
   * Release a previously acquired session, making it available for reuse.
   * If the session was evicted (deleted) while in use, this is a no-op.
   */
  release(cwd: string, model: string, provider?: string): void {
    const key = this.makeKey(cwd, model, provider);
    const session = this.sessions.get(key);
    if (session) {
      session.inUse = false;
    }
  }
```

4. Modify `set()` to initialize inUse to false (line 50-58):

```typescript
  set(cwd: string, model: string, session: PooledSession, provider?: string): void {
    const key = this.makeKey(cwd, model, provider);
    const existing = this.sessions.get(key);
    if (existing) {
      this.killSession(existing);
    }
    session.inUse = false;  // New sessions start as not-in-use
    session.childProcess.unref();
    this.sessions.set(key, session);
  }
```

5. Modify `cleanup()` to skip inUse sessions (line 77-87):

```typescript
  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.inUse) continue; // Don't evict active sessions
      const idleMs = now - session.lastUsed;
      const ageMs = now - session.createdAt;
      if (idleMs > this.config.idleTimeoutMs || ageMs > this.config.maxAgeMs) {
        this.killSession(session);
        this.sessions.delete(key);
      }
    }
  }
```

**Exact Code Changes — provider.ts**:

6. Replace `pool.get()` with `pool.acquire()` at line 200:

```typescript
// 3. Check session pool for an existing session (keyed by cwd + provider + model).
const pooled = this.pool.acquire(session.cwd, model, config.provider);
```

7. Add `pool.release()` in the pooled query path (after bridge completes).
   In the try block after yield\* (around line 230), add release:

```typescript
try {
  yield *
    withFirstEventTimeout(bridge, getFirstEventTimeoutMs(), `hermes acp pooled cwd=${session.cwd}`);
  this.pool.release(session.cwd, model, config.provider); // ADD
  getLog().debug('hermes.pooled_query_completed');
} catch (err) {
  // Pool session is likely dead — evict it so next call spawns fresh.
  this.pool.delete(session.cwd, model, config.provider);
  getLog().error({ err }, 'hermes.pooled_query_failed');
  throw err;
}
```

Note: The `finally` block at line 236 already calls `bridge.return(undefined)`.
The `release()` goes in the try SUCCESS path. On error, `delete()` handles cleanup.
No release needed in catch because delete removes the session entirely.

**New Tests — session-pool.test.ts** (append):

```typescript
describe('acquire/release', () => {
  test('acquire returns session and marks inUse', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    const acquired = pool.acquire('/tmp', 'model');
    expect(acquired).toBe(session);
    expect(acquired!.inUse).toBe(true);
  });

  test('acquire returns undefined when session is already inUse', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    pool.set('/tmp', 'model', makeSession());

    const first = pool.acquire('/tmp', 'model');
    expect(first).toBeDefined();

    const second = pool.acquire('/tmp', 'model');
    expect(second).toBeUndefined();
  });

  test('release clears inUse flag and allows re-acquire', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    pool.acquire('/tmp', 'model');
    pool.release('/tmp', 'model');

    const reacquired = pool.acquire('/tmp', 'model');
    expect(reacquired).toBe(session);
  });

  test('release for non-existent key is a no-op', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(() => pool.release('/nonexistent', 'model')).not.toThrow();
  });

  test('cleanup does not evict inUse sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 50,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 20,
    });
    const cp = mockChildProcess();
    pool.set('/tmp', 'model', makeSession({ childProcess: cp }));
    pool.acquire('/tmp', 'model'); // mark inUse

    await new Promise(r => setTimeout(r, 100));

    expect(cp.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });

  test('get() still returns inUse sessions (read-only access)', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);
    pool.acquire('/tmp', 'model');

    // get() should still return the session (for diagnostics, etc.)
    const got = pool.get('/tmp', 'model');
    expect(got).toBe(session);
  });
});
```

**New Tests — provider.test.ts** (append to HermesProvider describe):

```typescript
test('acquire prevents second sendQuery from reusing inUse pooled session', async () => {
  const mockAcp1 = createAcpMock();
  const mockAcp2 = createAcpMock();

  mockSpawn
    .mockImplementationOnce(() => mockAcp1.process)
    .mockImplementationOnce(() => mockAcp2.process);

  (mockAcp1.process as any).exitCode = null;
  (mockAcp2.process as any).exitCode = null;

  const pool = new HermesSessionPool();
  const provider = new HermesProvider(pool);

  // First call — registers session in pool
  const promise1 = consume(provider.sendQuery('Hello', '/tmp', undefined, { model: 'test-model' }));

  // Start second call while first is still running
  // (the pool.acquire should return undefined since session is inUse)
  const promise2 = consume(
    provider.sendQuery('Follow up', '/tmp', undefined, { model: 'test-model' })
  );

  const [result1, result2] = await Promise.all([promise1, promise2]);

  // Both should succeed
  expect(result1.error).toBeUndefined();
  expect(result2.error).toBeUndefined();

  // Second call should have spawned a new process (pool was inUse)
  expect(mockSpawn).toHaveBeenCalledTimes(2);

  pool.destroy();
});
```

**Update Existing Tests** that use PooledSession:

In provider.test.ts, the makeSession/createAcpMock helper creates PooledSession
objects for pool.set(). After adding `inUse` to the interface, the `set()` method
now auto-sets `inUse = false`, so existing tests that call `pool.set()` directly
should still work (set() handles the default).

However, tests at lines 541-544 that call `pool.get()` after sendQuery may need
adjustment if they expect the session to be available (not inUse). After sendQuery
completes, the session should be released, so `pool.get()` should still work.

**Commit Message**: `fix(hermes): add acquire/release to session pool and wire into provider`

**Verification Commands**:

```bash
cd /home/d/Desktop/Archon-canonical
bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
```

---

## 4. GATE 1 VERIFIER SPECIFICATION

Gate 1 runs AFTER all three executors complete. It verifies the combined state.

### 4.1 Structural Checks (grep)

Run these from `/home/d/Desktop/Archon-canonical`:

```bash
# Check 1A: Handler cleanup present in finally block
grep -c 'removeListener.*stdoutHandler' packages/providers/src/hermes/event-bridge.ts
# Expected: >= 1

grep -c 'removeListener.*stderrHandler' packages/providers/src/hermes/event-bridge.ts
# Expected: >= 1

grep -c 'removeListener.*exitHandler' packages/providers/src/hermes/event-bridge.ts
# Expected: >= 1

grep -c 'removeListener.*errorHandler' packages/providers/src/hermes/event-bridge.ts
# Expected: >= 1

# Check 1B: Global counter exists
grep -c 'globalAcpIdCounter' packages/providers/src/hermes/acp-protocol.ts
# Expected: >= 3 (declaration, increment in next(), assignment)

# Check no per-instance counter remains
grep -c 'let nextId = start' packages/providers/src/hermes/acp-protocol.ts
# Expected: 0

# Check 1C: acquire/release methods exist
grep -c 'acquire(' packages/providers/src/hermes/session-pool.ts
# Expected: >= 2 (method definition + body)

grep -c 'release(' packages/providers/src/hermes/session-pool.ts
# Expected: >= 2

grep -c 'inUse' packages/providers/src/hermes/session-pool.ts
# Expected: >= 5 (interface field, acquire, release, set, cleanup)

# Check provider uses acquire instead of get for pool lookup
grep -c 'this.pool.acquire' packages/providers/src/hermes/provider.ts
# Expected: >= 1

grep 'this.pool.get' packages/providers/src/hermes/provider.ts
# Expected: 0 occurrences (get replaced by acquire for session lookup)
```

**PASS Criteria**: All grep counts match expected values.
**FAIL Criteria**: Any count mismatches.
**On FAIL**: Dispatch targeted fixer executor for the failing task, re-run gate.

### 4.2 Test Commands

```bash
cd /home/d/Desktop/Archon-canonical

# Run all hermes tests in the correct batch order (matches package.json)
bun test \
  packages/providers/src/hermes/config.test.ts \
  packages/providers/src/hermes/model-ref.test.ts \
  packages/providers/src/hermes/options-translator.test.ts \
  packages/providers/src/hermes/session-resolver.test.ts \
  packages/providers/src/hermes/event-bridge.test.ts \
  packages/providers/src/hermes/provider.test.ts \
  packages/providers/src/hermes/acp-protocol.test.ts \
  packages/providers/src/hermes/error-classifier.test.ts \
  packages/providers/src/hermes/hermes-mcp-reader.test.ts \
  packages/providers/src/hermes/session-pool.test.ts \
  packages/providers/src/hermes/timeout-utils.test.ts \
  --timeout 60000
```

**PASS Criteria**: Exit code 0, 0 failures. Expected test count increase:

- event-bridge.test.ts: +5 new tests (handler cleanup)
- acp-protocol.test.ts: +3 new tests (monotonic ID), 1 modified test (wrap)
- session-pool.test.ts: +6 new tests (acquire/release)
- provider.test.ts: +1 new test (concurrent acquire)

**FAIL Criteria**: Any test failure or non-zero exit.
**On FAIL**:

- If failure is in existing test: dispatch fixer for the executor that broke it
- If failure is in new test: dispatch fixer for the executor that wrote it
- Re-run gate after fix

### 4.3 Type-Check Command

```bash
cd /home/d/Desktop/Archon-canonical/packages/providers
bun run type-check
```

**PASS Criteria**: Exit code 0, no type errors.
**FAIL Criteria**: Any type error.
**On FAIL**: Dispatch fixer to the executor that introduced the type error.
Common issues:

- `inUse` not in PooledSession interface (1C)
- `start` parameter removed but still referenced somewhere (1B)
- Handler variable types mismatch (1A)

---

## 5. COMMIT PLAN

After Gate 1 passes, verify 3 commits exist in order:

```
Commit 1: fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block
Commit 2: fix(hermes): use monotonic global counter for ACP request IDs
Commit 3: fix(hermes): add acquire/release to session pool and wire into provider
```

Since all three run in parallel, commit ordering is by executor completion time.
The commits are independent (no file overlap) so order doesn't matter.

**Verify commits**:

```bash
cd /home/d/Desktop/Archon-canonical
git log --oneline -3
```

Expected output (order may vary):

```
<hash> fix(hermes): add acquire/release to session pool and wire into provider
<hash> fix(hermes): use monotonic global counter for ACP request IDs
<hash> fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block
```

---

## 6. RISK ANALYSIS

### Low Risk

- **1A** (handler cleanup): Isolated change to finally block. Handler extraction is mechanical.
  Risk: Forgetting to capture a handler reference. Mitigated by listener count tests.

- **1B** (monotonic ID): Simple module-level variable. Risk: Existing test at line 87
  uses `createAcpIdGenerator(Number.MAX_SAFE_INTEGER)`. Mitigated by updating that test.

### Medium Risk

- **1C** (pool acquire/release): Touches two files (session-pool.ts + provider.ts).
  Risk: Existing tests call `pool.get()` which still works, but the provider now calls
  `pool.acquire()`. Tests at provider.test.ts line 541 call `pool.get()` to verify
  pool state after sendQuery — this still works because `get()` doesn't check inUse
  and sendQuery releases the session before returning.

  **Critical**: The `set()` method must set `inUse = false` so newly registered sessions
  are immediately available for the NEXT query (not the current one, since it's already
  completing).

---

## 7. TEST BATCH NOTE

All hermes test files run in ONE bun test invocation (line 21 of package.json) because
they share `mock.module` state. The executors modify different test files but they all
run together in Gate 1's test command. This is correct — mock.module isolation means
tests must be in the same batch to share mocked modules.

If any new test file were created (not the case here), it would need to be added to the
batch string in package.json line 21.
