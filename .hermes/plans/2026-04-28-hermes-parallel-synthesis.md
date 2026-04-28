# Synthesis — Hermes Parallel Execution Hang Remediation

> Date: 2026-04-28
> Verifiers: 3 (Claude, Codex, Pi provider analysis)
> Planners: 3 (provider fixes, test plan, architecture)

---

## The Problem

The hermes-pr-verifier workflow hangs when 3 parallel prompt nodes (code-review,
security-scan, protocol-check) all spawn `hermes acp` processes simultaneously.

**Root cause**: `run_conversation()` inside the Hermes agent's Python code hangs
when 3 processes simultaneously access `~/.hermes/state.db` (552MB SQLite + 286MB WAL).
The ACP adapter's `BEGIN IMMEDIATE` write lock with 15-retry jitter cannot resolve
triple-writer contention on a database this large.

**Timeout chain**: First-event timeout (60s) fires → SIGKILL → retry × 3 = ~180s
apparent hang before final failure.

---

## How Other Providers Avoid This

| Provider | Session Pool    | Child Process Mgmt | Shared State                 | JSON-RPC        | Parallel Safe |
| -------- | --------------- | ------------------ | ---------------------------- | --------------- | ------------- |
| Claude   | None            | SDK-managed        | None                         | No (SDK events) | Yes           |
| Codex    | None            | SDK thread API     | Singleton client (read-only) | No (SDK API)    | Yes           |
| Pi       | None            | In-process         | auth.json (read-only)        | No (callbacks)  | Yes           |
| Hermes   | YES (singleton) | Direct spawn       | state.db (552MB)             | YES (ACP 2.0)   | NO            |

Claude, Codex, and Pi are architecturally immune because they:

1. Have no session pool — each sendQuery() is independent
2. Delegate subprocess management to their SDKs
3. Have no shared mutable state (databases, file locks)
4. Don't use JSON-RPC over shared stdin/stdout

Hermes is the only provider that directly spawns child processes, manages
stdin/stdout, uses JSON-RPC, and has a shared SQLite database.

---

## Verified Bugs (4 total)

### Bug 1: stdout Handler Leak (event-bridge.ts)

bridgeHermesSession() registers 4 event handlers (stdout 'data', stderr 'data',
'exit', 'error') but the finally block (lines 666-686) only removes the abort
listener. The other 4 handlers leak. On pooled sessions, handlers accumulate.

**Pi's pattern**: unsubscribe() called in finally (event-bridge.ts:274).
**Fix**: Extract handlers to named refs, remove in finally block.

### Bug 2: JSON-RPC ID Collision (acp-protocol.ts)

createAcpIdGenerator() starts from 1 on every call. When multiple bridges share
a child process (pool reuse), all use id=1 for their first request. The child
responds once, all bridges resolve with the same response.

**Fix**: Module-level monotonic counter replacing per-call generator.

### Bug 3: state.db Contention (hermes CLI — external)

3 parallel hermes acp processes contend on 552MB SQLite. run_conversation() hangs.
Not fixable in the Archon codebase — requires upstream Hermes CLI changes.

**Fix**: Provider-level concurrency semaphore (serialize parallel queries).

### Bug 4: Session Pool Race (session-pool.ts + provider.ts)

Two concurrent sendQuery() calls for the same cwd+model both find pool empty,
both spawn fresh processes, second pool.set() kills first's process.

**Fix**: Add inUse flag + release() method to pool entries.

---

## Recommended Remediation

### P0: Provider-Level Concurrency Semaphore

**Why**: The DAG executor is provider-agnostic (3163 lines). Adding provider-specific
branches violates SRP. The Hermes provider knows its own constraints — it should
serialize internally.

**What**: ~30 lines. New file `concurrency-lock.ts` (async semaphore, maxConcurrency=1).
Wraps sendQuery() in acquire/release. Env var `ARCHON_HERMES_MAX_CONCURRENCY` for tuning.

**Impact**: Zero on Claude/Codex/Pi. Hermes parallel nodes run sequentially (3x wall time)
instead of hanging indefinitely.

**Files**:

- NEW: packages/providers/src/hermes/concurrency-lock.ts (~30 lines)
- EDIT: packages/providers/src/hermes/provider.ts (~10 lines — import + wrap sendQuery)

### P0: stdout Handler Cleanup

**What**: Extract stdout/stderr/exit/error handlers to named references. Remove all
4 in the finally block. Pattern matches Pi's unsubscribe() approach.

**Files**:

- EDIT: packages/providers/src/hermes/event-bridge.ts (finally block, lines 666-686)

### P1: JSON-RPC ID Monotonic Counter

**What**: Replace per-call createAcpIdGenerator() with module-level counter.
Each bridge gets unique IDs that never collide.

**Files**:

- EDIT: packages/providers/src/hermes/acp-protocol.ts (lines 52-61)

### P1: Session Pool inUse Flag

**What**: Add `inUse` boolean to PooledSession. pool.get() sets true, release()
sets false. Concurrent get() on same key returns undefined if inUse (forces fresh spawn).

**Files**:

- EDIT: packages/providers/src/hermes/session-pool.ts
- EDIT: packages/providers/src/hermes/provider.ts (release in finally)

### P2: Upstream state.db Fix (deferred)

**What**: Contribute busy_timeout PRAGMA + WAL checkpoint tuning to Hermes CLI.
Not a blocker — the semaphore handles it.

---

## Test Plan (21 tests)

### Event-bridge tests (8):

1. Two concurrent bridges on same child — independent results
2. stdout listener count after bridge completion — no leak
3. stderr listener count after bridge completion — no leak
4. exit/error listener count after bridge completion — no leak
5. Sequential bridge calls with skipInit — correct results
6. Concurrent bridges with overlapping prompt phases — response routing
7. Bridge error does not corrupt concurrent bridge
8. ID monotonicity across multiple bridge calls

### Session pool tests (3):

9. Concurrent get() returns consistent state
10. set() during active bridge kills old process
11. delete() during concurrent access is safe

### Provider integration tests (7):

12. Two concurrent sendQuery on fresh provider — independent responses
13. Two concurrent sendQuery on same pooled session — independent responses
14. Three concurrent sendQuery with different prompts — correct routing
15. Concurrent sendQuery with different cwds — separate pool entries
16. One failing sendQuery does not affect concurrent call
17. ConcurrencyLock serializes concurrent callers
18. ConcurrencyLock respects maxConcurrency env var

### Cross-provider tests (3):

19. Claude concurrent sendQuery — independent responses
20. Codex concurrent sendQuery — independent responses
21. Pi concurrent sendQuery — independent responses

---

## Execution Order

1. ConcurrencyLock (P0) — stops the bleeding immediately
2. Handler cleanup (P0) — prevents memory leak
3. ID monotonic counter (P1) — prevents data corruption on pool reuse
4. Pool inUse flag (P1) — prevents race condition
5. Tests (all 21) — verification
6. Upstream state.db fix (P2) — long-term

---

## Key Design Decisions

1. **Keep the session pool** — Claude/Codex/Pi don't need one because their SDKs
   manage sessions. Hermes uses raw child_process.spawn with ACP. The pool enables
   multi-turn continuity. Removing it loses functionality without fixing the bug
   (parallel layers already force context: fresh).

2. **Provider-level fix, not executor-level** — The DAG executor is provider-agnostic.
   Adding `if (provider === 'hermes') serialize()` is a design regression. The provider
   knows its constraints; the executor doesn't.

3. **Semaphore, not mutex** — maxConcurrency=1 by default but tunable via env var.
   When Hermes CLI fixes state.db contention, set ARCHON_HERMES_MAX_CONCURRENCY=3
   to restore parallelism without code changes.

4. **Monotonic counter, not random IDs** — JSON-RPC spec requires integer IDs.
   A module-level counter ensures uniqueness across all bridges in the process.
   Random IDs could collide; sequential cannot.
