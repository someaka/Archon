# Hermes Parallel Execution Remediation Plan

> Date: 2026-04-28
> Methodology: archon-hermes-methodology (phased, batched, gated)
> Issue: #1106 (Hermes Agent integration)

---

## Executive Summary

The Hermes provider has 4 bugs causing parallel workflow hangs. Root cause:
Hermes manages child processes manually (event-bridge.ts, 687 lines) while
Claude/Codex/Pi delegate to SDKs. The official TypeScript ACP SDK
(`@agentclientprotocol/sdk`) exists but Archon hand-rolls JSON-RPC instead.

**Bugs**: stdout handler leak, JSON-RPC ID collision, state.db contention,
session pool race. **Fix**: 4 batches across 4 files + 1 new file + tests.

---

## Bugs and Root Causes

| Bug                   | File                                       | Root Cause                                                      | Evidence                                          |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------- |
| stdout handler leak   | event-bridge.ts:178,666-686                | finally block doesn't remove stdout/stderr/exit/error handlers  | Listener count grows on pooled reuse              |
| JSON-RPC ID collision | acp-protocol.ts:52                         | createAcpIdGenerator(start=1) per bridge — all bridges use id=1 | 3 bridges on same child = protocol collision      |
| state.db contention   | hermes_state.py (external)                 | 3 hermes acp processes × BEGIN IMMEDIATE on 552MB SQLite        | run_conversation() hangs, 60s timeout × 3 retries |
| Session pool race     | session-pool.ts:41-48, provider.ts:200-201 | Concurrent get() returns same session, no locking               | Both callers create bridges on same child         |

---

## Phase 0: Plan (this document)

---

## Phase 1: 3 Verifiers (pre-execution)

| Verifier              | Scope                                                 | Reads                                                         | Output                              |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| V1: ACP Spec/Docs     | ACP protocol compliance, @agentclientprotocol/sdk API | ACP spec URLs, npm SDK docs, event-bridge.ts, acp-protocol.ts | ACCURATE/WRONG per claim            |
| V2: Codebase Patterns | Code claims against actual repo                       | All 4 hermes provider files, session-pool.ts, async-queue.ts  | VERIFIED/REFUTED per claim          |
| V3: Requirements      | Issue #1106 requirements vs proposed fixes            | Issue URL, synthesis doc, this plan                           | COVERED/PARTIAL/GAP per requirement |

**Dispatch**: 3 parallel read-only verifiers. Synthesize findings. Patch plan.

---

## Phase 2: Synthesize + Patch + 3 Planners

Round 1: Apply verifier corrections to plan.
Round 2: 3 planners (A: docs/ACP spec, B: engine source, C: execution order).
Merge into final plan.

---

## Phase 3: Execution (4 batches with gates)

### FILE OVERLAP CHECK

| File                | Batch 1        | Batch 2                    | Batch 3           | Batch 4           |
| ------------------- | -------------- | -------------------------- | ----------------- | ----------------- |
| event-bridge.ts     | ✓ (handlers)   | ✓ (idGen param)            | ✓ (AcpClient)     | —                 |
| acp-protocol.ts     | ✓ (ID counter) | —                          | —                 | —                 |
| session-pool.ts     | ✓ (inUse flag) | —                          | ✓ (AcpClient)     | —                 |
| provider.ts         | —              | ✓ (ConcurrencyLock, retry) | ✓ (use AcpClient) | ✓ (diagnostics)   |
| error-classifier.ts | —              | —                          | —                 | ✓ (wire to retry) |

**Conflict**: event-bridge.ts touched in batches 1, 2, 3. Must be sequential
for that file. Solution: batch 1 changes (handler cleanup) are additive to
finally block. batch 2 adds idGenerator parameter (non-breaking). batch 3
refactors into AcpClient class (major). Execute in order.

### Batch 1: P0 Bug Fixes (handler cleanup + ID counter + pool lock)

**Executor 1A: event-bridge.ts — handler cleanup**

File: `packages/providers/src/hermes/event-bridge.ts`

Step 1: Write failing test in `event-bridge.test.ts`:

```typescript
it('does not leak stdout listeners after bridge completes', async () => {
  const mock = createAcpMock();
  const bridge = bridgeHermesSession(mock.child, { prompt: 'test', cwd: '/tmp' });
  const before = mock.child.stdout.listenerCount('data');
  for await (const chunk of bridge) {
    /* consume */
  }
  const after = mock.child.stdout.listenerCount('data');
  expect(after).toBe(before);
});
```

Step 2: Run test — expect FAIL (listener count grows).
Step 3: Convert anonymous handlers at lines 178, 287, 338, 379 to named refs.
Step 4: Add to finally block (line 666):

```typescript
childProcess.stdout.removeListener('data', stdoutHandler);
childProcess.stderr?.removeListener('data', stderrHandler);
childProcess.removeListener('exit', exitHandler);
childProcess.removeListener('error', errorHandler);
```

Step 5: Run test — expect PASS.
Step 6: `git add packages/providers/src/hermes/event-bridge.ts packages/providers/src/hermes/event-bridge.test.ts && git commit -m "fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block"`

**Executor 1B: acp-protocol.ts — monotonic ID counter**

File: `packages/providers/src/hermes/acp-protocol.ts`

Step 1: Write failing test in `acp-protocol.test.ts`:

```typescript
it('generates unique IDs across multiple generator instances', () => {
  const gen1 = createAcpIdGenerator();
  const gen2 = createAcpIdGenerator();
  const id1 = gen1.next();
  const id2 = gen2.next();
  expect(id1).not.toBe(id2);
});
```

Step 2: Run test — expect FAIL (both return 1).
Step 3: Add module-level counter:

```typescript
let globalAcpIdCounter = 0;
export function createAcpIdGenerator(): AcpIdGenerator {
  return {
    next: (): number => {
      globalAcpIdCounter = (globalAcpIdCounter % Number.MAX_SAFE_INTEGER) + 1;
      return globalAcpIdCounter;
    },
  };
}
```

Step 4: Run test — expect PASS.
Step 5: `git add packages/providers/src/hermes/acp-protocol.ts packages/providers/src/hermes/acp-protocol.test.ts && git commit -m "fix(hermes): use monotonic global counter for ACP request IDs"`

**Executor 1C: session-pool.ts — inUse flag + acquire/release**

File: `packages/providers/src/hermes/session-pool.ts`

Step 1: Write failing test in `session-pool.test.ts`:

```typescript
it('acquire returns undefined when session is in use', () => {
  const pool = new HermesSessionPool();
  pool.set('/tmp', 'm', mockSession(), 'hermes');
  const s1 = pool.acquire('/tmp', 'm', 'hermes');
  expect(s1).toBeDefined();
  const s2 = pool.acquire('/tmp', 'm', 'hermes');
  expect(s2).toBeUndefined();
  pool.release('/tmp', 'm', 'hermes');
  const s3 = pool.acquire('/tmp', 'm', 'hermes');
  expect(s3).toBeDefined();
});
```

Step 2: Run test — expect FAIL.
Step 3: Add `inUse: boolean` to PooledSession interface. Add `acquire()` (sets inUse=true, returns session or undefined) and `release()` (sets inUse=false) methods.
Step 4: Update provider.ts pool reuse path (lines 200-241) to use acquire/release.
Step 5: Run test — expect PASS.
Step 6: `git add packages/providers/src/hermes/session-pool.ts packages/providers/src/hermes/session-pool.test.ts packages/providers/src/hermes/provider.ts && git commit -m "fix(hermes): add acquire/release to session pool to prevent concurrent access race"`

### Gate 1

```
STEP [1]: grep -c "removeListener" packages/providers/src/hermes/event-bridge.ts
  Expected: >= 4 (stdout, stderr, exit, error)

STEP [2]: grep -c "globalAcpIdCounter" packages/providers/src/hermes/acp-protocol.ts
  Expected: >= 1

STEP [3]: grep -c "acquire\|release\|inUse" packages/providers/src/hermes/session-pool.ts
  Expected: >= 3

STEP [4]: bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
  Expected: all pass, 0 failures

STEP [5]: bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
  Expected: all pass, 0 failures

STEP [6]: bun run type-check
  Expected: exit 0
```

---

### Batch 2: P0 ConcurrencyLock + Provider Retry

**Executor 2A: concurrency-lock.ts — new file**

File: `packages/providers/src/hermes/concurrency-lock.ts` (NEW)

Step 1: Write test `concurrency-lock.test.ts`:

```typescript
it('serializes concurrent callers when maxConcurrency=1', async () => {
  const lock = new ConcurrencyLock(1);
  const order: number[] = [];
  const p1 = lock
    .acquire()
    .then(() => {
      order.push(1);
      return delay(50);
    })
    .then(() => {
      lock.release();
    });
  const p2 = lock
    .acquire()
    .then(() => {
      order.push(2);
    })
    .then(() => {
      lock.release();
    });
  await Promise.all([p1, p2]);
  expect(order).toEqual([1, 2]);
});
```

Step 2: Run test — expect FAIL.
Step 3: Implement ConcurrencyLock (~30 lines):

```typescript
export class ConcurrencyLock {
  private queue: Array<() => void> = [];
  private running = 0;
  constructor(private readonly maxConcurrency: number = 1) {}
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}
```

Step 4: Run test — expect PASS.
Step 5: `git add packages/providers/src/hermes/concurrency-lock.ts packages/providers/src/hermes/concurrency-lock.test.ts && git commit -m "feat(hermes): add ConcurrencyLock for serializing parallel sendQuery calls"`

**Executor 2B: provider.ts — integrate ConcurrencyLock**

File: `packages/providers/src/hermes/provider.ts`

Step 1: Write test in `provider.test.ts`:

```typescript
it('serializes concurrent sendQuery calls via ConcurrencyLock', async () => {
  // Two concurrent sendQuery on same provider — should not hang or collide
  const provider = new HermesProvider(new HermesSessionPool());
  const [r1, r2] = await Promise.all([
    consume(provider.sendQuery('prompt A', '/tmp')),
    consume(provider.sendQuery('prompt B', '/tmp')),
  ]);
  expect(r1.chunks.length).toBeGreaterThan(0);
  expect(r2.chunks.length).toBeGreaterThan(0);
});
```

Step 2: Run test — expect FAIL or hang.
Step 3: Import ConcurrencyLock. Add module-level `hermesQueryLock`. Wrap sendQuery body in acquire/release.
Step 4: Run test — expect PASS.
Step 5: `git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/provider.test.ts && git commit -m "fix(hermes): serialize parallel sendQuery via ConcurrencyLock"`

### Gate 2

```
STEP [1]: grep -c "ConcurrencyLock" packages/providers/src/hermes/provider.ts
  Expected: >= 2 (import + usage)

STEP [2]: grep -c "acquire\|release" packages/providers/src/hermes/provider.ts
  Expected: >= 2

STEP [3]: bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
  Expected: all pass

STEP [4]: bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
  Expected: all pass

STEP [5]: bun run type-check
  Expected: exit 0
```

---

### Batch 3: P1 HermesAcpClient Abstraction

**Executor 3A: Create acp-client.ts**

File: `packages/providers/src/hermes/acp-client.ts` (NEW)

Encapsulate child process + ACP protocol + handler management in one class.
Session pool stores HermesAcpClient instead of raw ChildProcess.

```typescript
export class HermesAcpClient {
  private child: ChildProcess;
  private idGen: AcpIdGenerator;
  private handlers: { stdout: Function; stderr: Function; exit: Function; error: Function };

  constructor(binary: string, spawnOpts: SpawnOptions) {
    this.child = spawn(binary, ['acp'], spawnOpts);
    this.idGen = createAcpIdGenerator();
    // Register handlers, store refs
  }

  async initialize(): Promise<void> {
    /* sendRequest(initialize) */
  }
  async newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<string> {
    /* sendRequest(session/new) */
  }
  async *prompt(
    sessionId: string,
    prompt: string,
    systemPrompt?: string
  ): AsyncGenerator<MessageChunk> {
    /* yield chunks */
  }

  dispose(): void {
    // Remove ALL handlers
    // Kill child if needed
  }

  get isAlive(): boolean {
    return !this.child.killed && this.child.exitCode === null;
  }
}
```

Step 1: Write tests for HermesAcpClient (initialize, newSession, prompt, dispose cleanup).
Step 2: Run tests — expect FAIL.
Step 3: Implement by extracting logic from event-bridge.ts and provider.ts.
Step 4: Run tests — expect PASS.
Step 5: `git add packages/providers/src/hermes/acp-client.ts packages/providers/src/hermes/acp-client.test.ts && git commit -m "feat(hermes): add HermesAcpClient encapsulating child process + ACP protocol"`

**Executor 3B: Refactor provider.ts to use HermesAcpClient**

File: `packages/providers/src/hermes/provider.ts`

Step 1: Update session-pool.ts PooledSession to store `client: HermesAcpClient` instead of `childProcess: ChildProcess`.
Step 2: Refactor provider.ts sendQuery() to use HermesAcpClient.
Step 3: Run existing tests — expect PASS (no behavior change).
Step 4: `git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/session-pool.ts && git commit -m "refactor(hermes): use HermesAcpClient in provider and session pool"`

### Gate 3

```
STEP [1]: grep -c "class HermesAcpClient" packages/providers/src/hermes/acp-client.ts
  Expected: 1

STEP [2]: grep -c "HermesAcpClient" packages/providers/src/hermes/provider.ts
  Expected: >= 2

STEP [3]: grep -c "childProcess.stdout.on" packages/providers/src/hermes/event-bridge.ts
  Expected: 0 (moved to AcpClient)

STEP [4]: bun test packages/providers/src/hermes/ --timeout 60000
  Expected: all pass

STEP [5]: bun run type-check
  Expected: exit 0

STEP [6]: bun run lint
  Expected: 0 warnings
```

---

### Batch 4: P1/P2 Retry + Diagnostics + Cleanup

**Executor 4A: Wire error classifier to retry loop**

File: `packages/providers/src/hermes/provider.ts`

Step 1: Write test:

```typescript
it('retries on transient errors up to MAX_SUBPROCESS_RETRIES', async () => {
  // Mock first call to fail with 'crash' error, second to succeed
  // Verify retry happened
});
```

Step 2: Add retry loop (3 attempts, exponential backoff) matching Claude/Codex pattern.
Step 3: Wire classifyHermesError for shouldRetry decision.
Step 4: `git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/provider.test.ts && git commit -m "feat(hermes): add retry with exponential backoff matching Claude/Codex pattern"`

**Executor 4B: Add diagnostic dump on first-event timeout**

File: `packages/providers/src/hermes/timeout-utils.ts`

Step 1: Add buildFirstEventHangDiagnostics() (like Claude's pattern).
Step 2: Include stderr lines, process state, session info in timeout error.
Step 3: `git add packages/providers/src/hermes/timeout-utils.ts && git commit -m "feat(hermes): add diagnostic dump on first-event timeout"`

**Executor 4C: Final cleanup**

- Remove stale event-bridge.ts handler registration (moved to AcpClient)
- Update skill `archon-hermes-provider` with new patterns
- `bun run validate`

### Gate 4

```
STEP [1]: bun run type-check
  Expected: exit 0

STEP [2]: bun run lint
  Expected: 0 warnings

STEP [3]: bun run format:check
  Expected: exit 0

STEP [4]: bun run test
  Expected: all pass

STEP [5]: bun run check:bundled
  Expected: exit 0

STEP [6]: bun test packages/providers/src/hermes/ --timeout 60000
  Expected: all pass (259+ tests)
```

---

## Phase 4: Final Validation

```bash
bun run type-check     # exit 0
bun run test           # all pass
bun run lint           # zero warnings
bun run format:check   # exit 0
git log --oneline -N   # verify all commits
git status --short     # clean
```

Run e2e-hermes-smoke.yaml — single node, should complete in <15s.
Run hermes-pr-verifier.yaml — 3 parallel nodes should execute
sequentially (via ConcurrencyLock) without hanging.

---

## Commit Plan

| Batch | Commit | Message                                                                            |
| ----- | ------ | ---------------------------------------------------------------------------------- |
| 1A    | 1      | fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block      |
| 1B    | 2      | fix(hermes): use monotonic global counter for ACP request IDs                      |
| 1C    | 3      | fix(hermes): add acquire/release to session pool to prevent concurrent access race |
| 2A    | 4      | feat(hermes): add ConcurrencyLock for serializing parallel sendQuery calls         |
| 2B    | 5      | fix(hermes): serialize parallel sendQuery via ConcurrencyLock                      |
| 3A    | 6      | feat(hermes): add HermesAcpClient encapsulating child process + ACP protocol       |
| 3B    | 7      | refactor(hermes): use HermesAcpClient in provider and session pool                 |
| 4A    | 8      | feat(hermes): add retry with exponential backoff matching Claude/Codex pattern     |
| 4B    | 9      | feat(hermes): add diagnostic dump on first-event timeout                           |
| 4C    | 10     | chore(hermes): cleanup stale code, update skill                                    |

---

## Verification Commands

```bash
# Per-batch (run after each batch)
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
bun run type-check

# Full (run at end)
bun run validate

# E2E
bun run cli workflow run e2e-hermes-smoke
bun run cli workflow run hermes-pr-verifier --no-worktree
```
