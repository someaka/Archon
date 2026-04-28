# Hermes Parallel Execution — Master Plan

> Date: 2026-04-28
> Issue: #1106 (Hermes Agent integration)
> Methodology: archon-hermes-methodology (phased, batched, gated)
> Status: DRAFT — pending verifier + 3-planner polish pass

---

## 1. Problem Statement

The hermes-pr-verifier workflow hangs when 3 parallel prompt nodes
(code-review, security-scan, protocol-check) all spawn `hermes acp`
processes simultaneously. The e2e-hermes-smoke test (single node) works
fine in 11s.

## 2. Root Cause Analysis

### 2.1 Primary: state.db Contention

3 parallel `hermes acp` processes simultaneously access `~/.hermes/state.db`
(552MB SQLite + 286MB WAL). The ACP adapter's `run_conversation()` calls
`SessionDB._execute_write()` which uses `BEGIN IMMEDIATE` with 15 retries
and 20-150ms jitter. Triple-writer contention on a database this large causes
deadlock-like behavior.

**Evidence**: Debug instrumentation proved all 3 processes reach
`_run_agent BEFORE run_conversation` but `run_conversation ENTRY` NEVER
appears. Single process (smoke test) works fine.

**Source**: `~/.hermes/hermes-agent/hermes_state.py` lines 167-178, 209-250,
`~/.hermes/hermes-agent/acp_adapter/server.py` line 654.

**Note**: HERMES_HOME isolation (provider.ts lines 254-293) only activates
when `options?.model` is specified (per-node model override). It does NOT
apply to the general case.

### 2.2 Secondary: stdout Handler Leak (event-bridge.ts)

`bridgeHermesSession()` registers 4 event handlers (stdout 'data' @L178,
stderr 'data' @L287, 'exit' @L338, 'error' @L379) but the finally block
(lines 666-686) only removes the abort listener. The other 4 handlers leak.
On pooled sessions, handlers accumulate.

**Source**: `packages/providers/src/hermes/event-bridge.ts` lines 178, 287,
338, 379 (register), 666-686 (finally — missing cleanup).
**Verified**: All line numbers confirmed against current source (687 lines).

### 2.3 Secondary: JSON-RPC ID Collision (acp-protocol.ts)

`createAcpIdGenerator()` starts from 1 on every call. When multiple bridges
share a child process (pool reuse), all use id=1 for their first request.
The child responds once, all bridges resolve with the same response.

**Source**: `packages/providers/src/hermes/acp-protocol.ts` line 52.
**Verified**: Confirmed — `createAcpIdGenerator(start = 1)` at line 52.

### 2.4 Secondary: Session Pool Race (session-pool.ts)

Two concurrent `sendQuery()` calls for the same cwd+model both find pool
empty, both spawn fresh processes, second `pool.set()` kills first's process.

**Source**: `packages/providers/src/hermes/session-pool.ts` lines 41-48,
`packages/providers/src/hermes/provider.ts` lines 200-201.
**Verified**: `get()` at L41-48, pool lookup at L200-201 confirmed.

## 3. How Other Providers Avoid This

| Provider | SDK Package                    | Subprocess Mgmt | Session Pool    | Shared State     | Parallel Safe |
| -------- | ------------------------------ | --------------- | --------------- | ---------------- | ------------- |
| Claude   | @anthropic-ai/claude-agent-sdk | SDK-managed     | None            | None             | Yes           |
| Codex    | @openai/codex-sdk              | SDK thread API  | None            | Singleton (r/o)  | Yes           |
| Pi       | @mariozechner/pi-coding-agent  | In-process      | None            | auth.json (r/o)  | Yes           |
| Hermes   | NONE (manual JSON-RPC)         | Direct spawn    | YES (singleton) | state.db (552MB) | NO            |

**Key insight**: Claude, Codex, and Pi delegate subprocess/session management
to their SDKs. Hermes manages child processes manually in event-bridge.ts
(687 lines of hand-rolled JSON-RPC). This is why it has bugs the others don't.

### 3.1 Official ACP TypeScript SDK Exists

`@agentclientprotocol/sdk` (npm, v0.18.2, 2.7M weekly downloads, 0 deps)
provides `ClientSideConnection` with typed `initialize()`, `newSession()`,
`prompt()` methods. Handles JSON-RPC framing, request/response correlation,
and stream lifecycle internally.

Archon currently hand-rolls all of this in event-bridge.ts + acp-protocol.ts.

### 3.2 Hermes ACP Adapter Supports Multi-Session

The Hermes ACP adapter has `ThreadPoolExecutor(max_workers=4)` at
`server.py:74`. Multiple sessions CAN run in ONE `hermes acp` process.
Archon spawns SEPARATE processes per `sendQuery()` — this is the
contention source. One process with multiple sessions mitigates contention
via BEGIN IMMEDIATE with jitter retries and ContextVar isolation per thread,
but does NOT eliminate it entirely — sessions still share state.db within
the same process.

## 4. Existing Code Inventory

### 4.1 Files That Need Changes

| File                | Lines | Role                              | Bugs                          |
| ------------------- | ----- | --------------------------------- | ----------------------------- |
| event-bridge.ts     | 687   | ACP lifecycle, stdout parsing     | Handler leak (finally block)  |
| acp-protocol.ts     | 278   | JSON-RPC types, ID generator      | ID collision (starts@1)       |
| session-pool.ts     | 100   | Pool with get/set/delete/destroy  | Race condition (no locking)   |
| provider.ts         | 402   | sendQuery, pool reuse, spawn      | No retry, no ConcurrencyLock  |
| error-classifier.ts | 132   | classifyHermesError + shouldRetry | Exists but not wired to retry |
| timeout-utils.ts    | 29    | withFirstEventTimeout             | Working correctly             |

### 4.2 Files That Are Correct (no changes needed)

| File                 | Why Correct                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| dag-executor.ts      | Provider-agnostic parallel execution via Promise.allSettled. No provider-specific branches. |
| idle-timeout.ts      | Resets on each chunk. Working as designed.                                                  |
| executor.ts          | Post-rebase import fix is correct.                                                          |
| utils/async-queue.ts | 78 lines. AsyncQueue used by event-bridge. Working correctly.                               |

### 4.3 External Files (Hermes CLI — not in Archon repo)

| File                   | Role                              | Relevance                        |
| ---------------------- | --------------------------------- | -------------------------------- |
| hermes_state.py        | SQLite session store              | state.db contention source       |
| acp_adapter/server.py  | ACP server, ThreadPoolExecutor(4) | Multi-session support exists     |
| acp_adapter/session.py | Session manager                   | SessionDB connection per process |
| run_agent.py           | Agent loop (13k LOC)              | run_conversation() hang point    |

## 5. Remediation Strategy

### 5.1 Approaches Evaluated

| #   | Approach                        | Pros                                            | Cons                                               | Verdict          |
| --- | ------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ---------------- |
| 1   | Serialize in DAG executor       | Guaranteed fix                                  | Violates SRP (executor is provider-agnostic)       | REJECTED         |
| 2   | Provider-level ConcurrencyLock  | SRP-compliant, ~30 lines, zero executor changes | Serializes all Hermes queries                      | RECOMMENDED      |
| 3   | Fix state.db in Hermes CLI      | Fixes root cause                                | External codebase, structural issue                | DEFERRED         |
| 4   | Remove session pool             | Eliminates pool bugs                            | Loses multi-turn continuity, doesn't fix state.db  | REJECTED         |
| 5   | Workflow YAML `parallel: false` | User-controlled                                 | Pushes problem to every workflow author            | REJECTED         |
| 6   | Use @agentclientprotocol/sdk    | Eliminates hand-rolled JSON-RPC                 | New dependency, migration effort                   | RECOMMENDED (P1) |
| 7   | Single-process multi-session    | Mitigates state.db contention                   | Still shares state.db, requires AcpClient refactor | RECOMMENDED (P1) |

### 5.2 Chosen Strategy

**Immediate (P0)**: Fix the 4 bugs in the existing code.
**Short-term (P1)**: Extract HermesAcpClient, add retry, wire error classifier.
**Long-term (P2)**: Migrate to @agentclientprotocol/sdk, single-process multi-session.

### 5.3 Retry Mechanism

Use INLINE retry matching Claude's pattern (NOT the shared retry-loop.ts utility):

```typescript
const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
// Retry loop runs INSIDE ConcurrencyLock acquire/release
// classifyHermesError returns { errorClass, shouldRetry, enrichedMessage }
```

**Critical**: Retry loop runs INSIDE ConcurrencyLock acquire/release.

## 6. Phase 1: Pre-Execution Verifiers

Before any code changes, 3 verifiers must produce PASS/FAIL verdicts.

| Verifier                  | Scope                                 | Commands                                                                                                         | Expected Output                                         |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| V1: ACP SDK availability  | @agentclientprotocol/sdk API          | `npm view @agentclientprotocol/sdk version 2>/dev/null && npm view @agentclientprotocol/sdk exports 2>/dev/null` | Version >= 0.18.0, exports include ClientSideConnection |
| V2: Codebase claims       | Source lines in §2 vs actual repo     | See V2 commands below                                                                                            | All line refs VERIFIED                                  |
| V3: Requirements coverage | Issue #1106 requirements vs this plan | Manual review: each requirement maps to ≥1 batch task                                                            | No GAPS                                                 |

### V2 Commands (run from repo root):

```bash
# Verify event-bridge handler registrations + finally block
grep -n "\.on('data'" packages/providers/src/hermes/event-bridge.ts | head -5
# Expected: lines 178, 287

grep -n "\.on('exit'" packages/providers/src/hermes/event-bridge.ts
# Expected: line 338

grep -n "\.on('error'" packages/providers/src/hermes/event-bridge.ts
# Expected: line 379

grep -n "removeEventListener" packages/providers/src/hermes/event-bridge.ts
# Expected: line 671 (abort only — confirms handler leak)

grep -n "removeListener\|off(" packages/providers/src/hermes/event-bridge.ts
# Expected: 0 matches (confirms no stdout/stderr/exit/error cleanup)

# Verify ID generator starts at 1
grep -n "createAcpIdGenerator" packages/providers/src/hermes/acp-protocol.ts
# Expected: line 52, signature createAcpIdGenerator(start = 1)

# Verify pool race
grep -n "pool\.get\|pool\.set" packages/providers/src/hermes/provider.ts
# Expected: get at ~L200, set after spawn (no locking between)

# Verify error-classifier exists but is not wired to retry
grep -c "classifyHermesError" packages/providers/src/hermes/provider.ts
# Expected: 0 (not wired)

grep -c "shouldRetry" packages/providers/src/hermes/provider.ts
# Expected: 0
```

### Gate 0: Verifiers PASS

**PASS criteria**: V1 returns SDK version, V2 all line refs verified, V3 no gaps.
**FAIL action**: Fix plan claims before proceeding to Batch 1.

## 7. Prerequisite Verification (Before Batch 1)

Before starting Batch 1, verify clean working state:

```bash
# 1. All existing hermes tests pass
bun test packages/providers/src/hermes/ --timeout 60000
# Expected: all pass, 0 failures

# 2. No uncommitted changes in hermes files
git status --short packages/providers/src/hermes/
# Expected: empty output

# 3. Type-check passes
bun run type-check
# Expected: exit code 0

# 4. Verify file line counts match plan inventory
wc -l packages/providers/src/hermes/event-bridge.ts
# Expected: 687
wc -l packages/providers/src/hermes/acp-protocol.ts
# Expected: 278
wc -l packages/providers/src/hermes/session-pool.ts
# Expected: 100
wc -l packages/providers/src/hermes/provider.ts
# Expected: 402
wc -l packages/providers/src/hermes/error-classifier.ts
# Expected: 132
wc -l packages/providers/src/hermes/timeout-utils.ts
# Expected: 29
```

**PASS criteria**: All tests pass, no uncommitted changes, type-check clean, line counts match.
**FAIL action**: Resolve before proceeding. Do NOT start Batch 1 with dirty state.

## 8. Execution Plan (4 Batches)

### Batch 1: P0 Bug Fixes

| Task                     | File                          | Change                                            | Tests                           |
| ------------------------ | ----------------------------- | ------------------------------------------------- | ------------------------------- |
| 1A: Handler cleanup      | event-bridge.ts               | Extract handlers to named refs, remove in finally | Listener count test             |
| 1B: Monotonic ID counter | acp-protocol.ts               | Module-level globalAcpIdCounter                   | Cross-generator uniqueness test |
| 1C: Pool acquire/release | session-pool.ts + provider.ts | inUse flag, acquire(), release()                  | Concurrent acquire test         |

### Gate 1: Batch 1 PASS

```bash
# Grep checks
grep -n "removeListener\|\.off(" packages/providers/src/hermes/event-bridge.ts
# Expected: 4+ matches in finally block (stdout data, stderr data, exit, error)

grep -n "globalAcpIdCounter\|module.*counter" packages/providers/src/hermes/acp-protocol.ts
# Expected: at least 1 match showing module-level counter (not per-call)

grep -n "acquire\|release\|inUse" packages/providers/src/hermes/session-pool.ts
# Expected: acquire() and release() methods present, inUse field present

# Targeted tests
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
# Expected: all pass (includes handler cleanup + ID monotonicity tests)

bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
# Expected: all pass (includes acquire/release tests)

bun test packages/providers/src/hermes/acp-protocol.test.ts --timeout 30000
# Expected: all pass

# Type-check
bun run type-check
# Expected: exit code 0
```

**PASS criteria**: All grep checks show expected output, all 3 test suites pass, type-check clean.
**FAIL action**: Fix failing tests before proceeding to Batch 2.

### Batch 2: P0 ConcurrencyLock

| Task                      | File                      | Change                                     | Tests                     |
| ------------------------- | ------------------------- | ------------------------------------------ | ------------------------- |
| 2A: ConcurrencyLock class | concurrency-lock.ts (NEW) | Async semaphore, maxConcurrency=1          | Serialization test        |
| 2B: Provider integration  | provider.ts               | Import + wrap sendQuery in acquire/release | Concurrent sendQuery test |

### Gate 2: Batch 2 PASS

```bash
# Grep checks
grep -n "class ConcurrencyLock" packages/providers/src/hermes/concurrency-lock.ts
# Expected: line N — class definition exists

grep -n "maxConcurrency" packages/providers/src/hermes/concurrency-lock.ts
# Expected: configurable via env ARCHON_HERMES_MAX_CONCURRENCY (default 1)

grep -n "ConcurrencyLock\|concurrencyLock\|acquire\|release" packages/providers/src/hermes/provider.ts
# Expected: import of ConcurrencyLock + acquire/release wrapping sendQuery

# Targeted tests
bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
# Expected: all pass (serialization, maxConcurrency env var, release underflow guard)

bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
# Expected: all pass (includes concurrent sendQuery serialization test)

# Type-check
bun run type-check
# Expected: exit code 0
```

**PASS criteria**: All grep checks show expected output, concurrency-lock and provider tests pass, type-check clean.
**FAIL action**: Fix failing tests before proceeding to Batch 3.

### Batch 3: P1 HermesAcpClient Abstraction

| Task                  | File                          | Change                                     | Tests                             |
| --------------------- | ----------------------------- | ------------------------------------------ | --------------------------------- |
| 3A: HermesAcpClient   | acp-client.ts (NEW)           | Encapsulate child process + ACP + handlers | Init/session/prompt/dispose tests |
| 3B: Provider refactor | provider.ts + session-pool.ts | Use HermesAcpClient, store in pool         | Existing tests pass               |

### Gate 3: Batch 3 PASS

```bash
# Grep checks
grep -n "class HermesAcpClient" packages/providers/src/hermes/acp-client.ts
# Expected: line N — class definition exists

grep -n "HermesAcpClient" packages/providers/src/hermes/provider.ts
# Expected: import + usage (replaces direct bridgeHermesSession calls)

grep -n "HermesAcpClient" packages/providers/src/hermes/session-pool.ts
# Expected: pool stores HermesAcpClient instances

# Full hermes test suite
bun test packages/providers/src/hermes/ --timeout 60000
# Expected: all pass (new + existing tests)

# Type-check + lint
bun run type-check
# Expected: exit code 0
bun run lint packages/providers/src/hermes/
# Expected: exit code 0, no warnings
```

**PASS criteria**: All grep checks show expected output, full test suite passes, type-check + lint clean.
**FAIL action**: Fix issues before proceeding to Batch 4.

### Batch 4: P1/P2 Retry + Diagnostics

| Task                       | File             | Change                                                    | Tests                     |
| -------------------------- | ---------------- | --------------------------------------------------------- | ------------------------- |
| 4A: Retry loop             | provider.ts      | 3 attempts, exponential backoff, wire classifyHermesError | Retry on crash error test |
| 4B: Timeout diagnostics    | timeout-utils.ts | buildFirstEventHangDiagnostics                            | —                         |
| 4C: Cleanup + skill update | —                | Remove stale code, update archon-hermes-provider skill    | bun run validate          |

### Gate 4: Batch 4 PASS (Final)

```bash
# Grep checks
grep -n "MAX_SUBPROCESS_RETRIES\|RETRY_BASE_DELAY" packages/providers/src/hermes/provider.ts
# Expected: constants defined (3 retries, 2000ms base delay)

grep -n "classifyHermesError\|shouldRetry" packages/providers/src/hermes/provider.ts
# Expected: wired into retry loop (was 0 before Batch 4)

# Full validation
bun run validate
# Expected: exit code 0 (type-check + lint + format + tests all pass)

# E2E smoke tests
bun run cli workflow run e2e-hermes-smoke
# Expected: completes in ~15s (was 11s pre-fix)

bun run cli workflow run hermes-pr-verifier --no-worktree
# Expected: completes (was hanging before fix)
```

**PASS criteria**: error-classifier wired, bun run validate passes, E2E tests complete without hang.
**FAIL action**: Debug and fix. This is the final gate — must pass before merge.

## 9. File Overlap Analysis

| File                | B1              | B2              | B3        | B4          | Resolution           |
| ------------------- | --------------- | --------------- | --------- | ----------- | -------------------- |
| event-bridge.ts     | handlers        | idGen param     | AcpClient | —           | Sequential: B1→B2→B3 |
| acp-protocol.ts     | ID counter      | —               | —         | —           | B1 only              |
| session-pool.ts     | inUse           | —               | AcpClient | —           | Sequential: B1→B3    |
| provider.ts         | acquire/release | ConcurrencyLock | AcpClient | retry       | Sequential: all      |
| concurrency-lock.ts | —               | NEW             | —         | —           | B2 only              |
| acp-client.ts       | —               | —               | NEW       | —           | B3 only              |
| error-classifier.ts | —               | —               | —         | wire        | B4 only              |
| timeout-utils.ts    | —               | —               | —         | diagnostics | B4 only              |

**No true parallelism possible** within provider.ts. Batches must be sequential.
**Overlap validated**: provider.ts touched in all 4 batches — each batch's changes are additive (B1 adds acquire/release, B2 wraps with lock, B3 replaces with AcpClient, B4 adds retry around AcpClient).

## 10. Test Plan (20 tests)

### Event-bridge tests (9):

1. stdout listener count after bridge — no leak
2. stderr listener count after bridge — no leak
3. exit/error listener count after bridge — no leak
4. Two concurrent bridges — independent results (exposes ID collision)
5. Sequential bridge calls with skipInit — correct results
6. Concurrent bridges with overlapping prompts — response routing
7. Bridge error isolation
8. ID monotonicity across bridges
9. Pooled session handler accumulation

### Session pool tests (5):

10. Concurrent get() consistency
11. set() during active bridge
12. delete() during concurrent access
13. acquire returns undefined when inUse
14. release allows next acquire

### Provider integration tests (4):

15. Two concurrent sendQuery on fresh provider
16. ConcurrencyLock serialization
17. ConcurrencyLock maxConcurrency env var
18. ConcurrencyLock release underflow guard

### Retry tests (2):

19. Retry on crash error (3 attempts)
20. Non-retryable error stops immediately

## 11. Commit Plan

| Batch | Commit | Message                                                                        |
| ----- | ------ | ------------------------------------------------------------------------------ |
| 1A    | 1      | fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block  |
| 1B    | 2      | fix(hermes): use monotonic global counter for ACP request IDs                  |
| 1C    | 3      | fix(hermes): add acquire/release to session pool and wire into provider        |
| 2A    | 4      | feat(hermes): add ConcurrencyLock for serializing parallel sendQuery calls     |
| 2B    | 5      | fix(hermes): serialize parallel sendQuery via ConcurrencyLock                  |
| 3A    | 6      | feat(hermes): add HermesAcpClient encapsulating child process + ACP protocol   |
| 3B    | 7      | refactor(hermes): use HermesAcpClient in provider and session pool             |
| 4A    | 8      | feat(hermes): add retry with exponential backoff matching Claude/Codex pattern |
| 4B    | 9      | feat(hermes): add diagnostic dump on first-event timeout                       |
| 4C    | 10     | chore(hermes): cleanup stale code, update skill                                |

## 12. Verification

```bash
# Per-batch (run after each gate)
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
bun run type-check

# Final
bun run validate

# E2E
bun run cli workflow run e2e-hermes-smoke
bun run cli workflow run hermes-pr-verifier --no-worktree
```

## 13. Out of Scope

- `available_commands_update` protocol mismatch — logged and ignored, not a hang cause
- state.db vacuum — operational fix, recommend `hermes sessions prune --older-than 30`
- @agentclientprotocol/sdk migration — P2 future work
- Cross-provider concurrent tests — YAGNI (deferred, not planned)
- Fix state.db in Hermes CLI — external codebase, structural issue (Approach #3 DEFERRED)

## 14. Phase 2: Synthesize + Patch + 3 Planners

Round 1: Apply verifier corrections.
Round 2: 3 planners polish (docs, codebase, execution order).
Merge into final plan.
