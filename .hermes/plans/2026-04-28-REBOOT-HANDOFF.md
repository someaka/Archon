# REBOOT HANDOFF — Hermes Provider PR Readiness

> Date: 2026-04-28 ~19:10 UTC
> Status: POST-OOM-HANG, pre-reboot
> This file is the SINGLE SOURCE OF TRUTH for resuming after reboot.

---

## READ THIS FIRST (in order)

1. THIS FILE (you're reading it)
2. `.hermes/plans/2026-04-28-hermes-master-plan.md` (482 lines — the full plan)
3. `.hermes/plans/2026-04-28-hermes-companion.md` (297 lines — code templates, gates, risks)
4. `.hermes/plans/2026-04-28-phase1-detailed-execution.md` (732 lines — Phase 1 executor specs)

---

## SKILLS REQUIRED (load in this order)

1. `archon-hermes-methodology` — full pipeline: plan → verifiers → synthesis → executors → gates
2. `archon-hermes-provider` — ACP protocol, event-bridge, session pool, test batching
3. `writing-plans` — bite-sized tasks, exact file paths, TDD
4. `subagent-driven-development` — dispatch fresh subagent per task
5. `executor-verifier-loop` — batch execution with gates
6. `systematic-debugging` — 4-phase root cause investigation

---

## WHAT HAPPENED (the hang)

### Root Cause: systemd-oomd OOM Kill

At 19:08:40 UTC, systemd-oomd killed the ptyxis terminal scope running
the hermes agent interface. Chain of events:

1. 18:57:12 — This session dispatched 3 delegate_task verifiers
2. Each spawned a hermes acp subprocess
3. Two existing hermes processes (PIDs 4421, 150345) already held state.db open
4. That's 5 processes fighting over SQLite WAL locks on 851MB database
5. Memory exploded: ptyxis scope peaked at 11.2GB
6. Memory pressure hit 58.11% > 50% systemd-oomd threshold for >20s
7. OOM killer terminated everything

### The Test Suite Also Hangs

Running `bun test packages/providers/src/hermes/` picks up live-integration.test.ts
which loads OLLAMA_API_KEY from ~/.hermes/.env and spawns REAL hermes acp processes.
With existing hermes processes fighting over state.db, this causes a hang.

**FIX**: Run tests with explicit file list from package.json, NOT directory mode:

```bash
# CORRECT (from package.json test script):
bun test src/hermes/config.test.ts src/hermes/concurrency-lock.test.ts src/hermes/error-classifier.test.ts src/hermes/options-translator.test.ts src/hermes/timeout-utils.test.ts src/hermes/model-ref.test.ts src/hermes/session-pool.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts

# WRONG (picks up live-integration.test.ts):
bun test packages/providers/src/hermes/
```

---

## CURRENT REPO STATE

### Branch & Commits

```
Repo: /home/d/Desktop/Archon-canonical
Branch: dev
Ahead of origin/dev: 4 commits (not pushed)
Behind: 0

4 unpushed commits:
  65220e24 feat(hermes): add ConcurrencyLock for serializing parallel sendQuery calls
  3c739bcf fix(hermes): add acquire/release to session pool and wire into provider
  0b31cac1 fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block
  3fe6e66f fix(hermes): use monotonic global counter for ACP request IDs
```

### Uncommitted Changes (4 files)

```
M  packages/providers/src/hermes/provider.test.ts  (+257/-83 lines)
M  packages/providers/src/hermes/provider.ts       (+45/-2 lines)
M  packages/providers/src/hermes/registration.ts   (-2 lines)
M  packages/workflows/src/executor.ts              (+32/-32 lines)
```

### Untracked Files

```
.archon/workflows/e2e-hermes-smoke.yaml
.hermes/plans/2026-04-28-POST-COMPRESSION-HANDOFF.md
.hermes/plans/2026-04-28-hermes-companion.md
.hermes/plans/2026-04-28-hermes-master-plan.md
.hermes/plans/2026-04-28-hermes-parallel-remediation-plan.md
.hermes/plans/2026-04-28-hermes-parallel-synthesis.md
.hermes/plans/2026-04-28-investigation-failure.md
.hermes/plans/2026-04-28-phase1-detailed-execution.md
.hermes/plans/2026-04-28-REBOOT-HANDOFF.md  (this file)
docs/hermes-parallel-execution-remediation-plan.md
```

---

## MASTER PLAN PROGRESS

### Batch 1: P0 Bug Fixes — COMPLETE + COMMITTED

| Task                     | Commit   | Status    |
| ------------------------ | -------- | --------- |
| 1A: Handler cleanup      | 0b31cac1 | COMMITTED |
| 1B: Monotonic ID counter | 3fe6e66f | COMMITTED |
| 1C: Pool acquire/release | 3c739bcf | COMMITTED |

Gate 1: PASSED (all grep checks, targeted tests, type-check)

### Batch 2: P0 ConcurrencyLock — PARTIALLY COMPLETE

| Task                             | Commit   | Status                        |
| -------------------------------- | -------- | ----------------------------- |
| 2A: ConcurrencyLock class        | 65220e24 | COMMITTED                     |
| 2B: Provider integration + retry | —        | UNCOMMITTED (in working tree) |

What's in the uncommitted provider.ts:

- ConcurrencyLock as second constructor param (with default singleton)
- Retry loop wrapping \_sendQueryOnce (up to 3 attempts, exponential backoff)
- classifyHermesError wired into retry decision
- abortSignal check before each retry attempt

What's in the uncommitted provider.test.ts:

- Updated abort signal tests (expect thrown "Query aborted" error)
- Fixed pool eviction test (single mockAcp)
- ~150 new lines: ConcurrencyLock serialization tests, release underflow guard, maxConcurrency env var
- New "sendQuery retry behavior" describe block (3 tests: retry on crash, non-retryable stops, abort before retry)
- Increased timeouts on slow tests to 30s

What's in the uncommitted registration.ts:

- Removed import of isHermesModelCompatible from model-ref
- Removed isModelCompatible from provider registration object

What's in the uncommitted executor.ts:

- Replaced inferProviderFromModel/isModelCompatible with isRegisteredProvider/getRegisteredProviders
- Simplified provider resolution: just workflow.provider ?? config.assistant
- Removed model-based provider inference

**NEXT**: Commit Batch 2B, run Gate 2, proceed to Batch 3.

### Batch 3: P1 HermesAcpClient — NOT STARTED

| Task                                         | Status      |
| -------------------------------------------- | ----------- |
| 3A: acp-client.ts (NEW)                      | NOT STARTED |
| 3B: Provider refactor to use HermesAcpClient | NOT STARTED |

### Batch 4: P1/P2 Diagnostics + Cleanup — NOT STARTED

| Task                    | Status      |
| ----------------------- | ----------- |
| 4A: Timeout diagnostics | NOT STARTED |
| 4B: Skill update        | NOT STARTED |
| 4C: Final validation    | NOT STARTED |

---

## WHAT TO DO AFTER REBOOT

### Step 0: System Health

After reboot, verify system is clean:

```bash
ps aux | grep hermes | grep -v grep  # should be empty
ps aux | grep acp | grep -v grep     # should be empty
free -h                                # memory should be fresh
```

### Step 1: Resume in Archon-canonical

```bash
cd /home/d/Desktop/Archon-canonical
git status
git log --oneline -5
```

The uncommitted changes should still be there (filesystem persists across reboot).

### Step 2: Commit Batch 2B

```bash
git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/provider.test.ts packages/providers/src/hermes/registration.ts packages/workflows/src/executor.ts
git commit -m "fix(hermes): serialize parallel sendQuery via ConcurrencyLock with retry"
```

### Step 3: Run Gate 2

```bash
# Grep checks
grep -c "export class ConcurrencyLock" packages/providers/src/hermes/concurrency-lock.ts
# Expected: 1

grep -c "lock.acquire\|lock.release" packages/providers/src/hermes/provider.ts
# Expected: >= 2

grep -c "MAX_SUBPROCESS_RETRIES\|shouldRetry" packages/providers/src/hermes/provider.ts
# Expected: >= 2

# Targeted tests (use explicit files, NOT directory mode)
cd packages/providers
bun test src/hermes/concurrency-lock.test.ts --timeout 30000
bun test src/hermes/provider.test.ts --timeout 60000

# Type-check
bun run type-check
```

### Step 4: Execute Batch 3 (HermesAcpClient)

Dispatch using subagent-driven-development or executor-verifier-loop:

- 3A: Create acp-client.ts encapsulating child process + ACP protocol
- 3B: Refactor provider.ts and session-pool.ts to use HermesAcpClient

### Step 5: Execute Batch 4 (Diagnostics + Cleanup)

- 4A: Timeout diagnostics in timeout-utils.ts
- 4B: Update archon-hermes-provider skill
- 4C: `bun run validate` (full validation)

### Step 6: E2E Tests

```bash
bun run cli workflow run e2e-hermes-smoke --no-worktree
bun run cli workflow run hermes-pr-verifier --no-worktree
```

### Step 7: Push + PR

```bash
git push origin dev
# Open PR against coleam00/Archon main
```

---

## CRITICAL WARNINGS

1. NEVER run `bun test packages/providers/src/hermes/` (directory mode) —
   it picks up live-integration.test.ts which spawns real hermes processes

2. NEVER run tests while hermes acp processes are running — state.db contention

3. The test command in package.json already has the correct file list — use it:

   ```bash
   cd packages/providers && bun test
   ```

4. provider.ts is touched in ALL 4 batches — changes are additive, applied sequentially

5. The 4 uncommitted files contain Batch 2B work — commit them FIRST before doing anything

6. Upstream (coleam00/Archon) may have new commits — check with:
   ```bash
   git fetch upstream && git log --oneline upstream/dev -5
   ```

---

## ISSUE CONTEXT

- GitHub Issue: coleam00/Archon#1106 "Hermes Agent integration"
- ~40 Definition of Done checkboxes across Core Integration, Configuration,
  CLI Setup, Workflows, Testing, Documentation
- This PR addresses the parallel execution hang (the most critical blocker)
- The Hermes provider has 259+ passing unit tests across 15 test files

---

## KEY FILE PATHS

```
Provider source:   packages/providers/src/hermes/
  provider.ts      — sendQuery, pool reuse, spawn, ConcurrencyLock, retry
  event-bridge.ts  — ACP lifecycle, stdout parsing (687 lines)
  acp-protocol.ts  — JSON-RPC types, ID generator (278 lines)
  session-pool.ts  — Pool with get/set/acquire/release (100 lines)
  concurrency-lock.ts — Async semaphore (NEW, committed)
  error-classifier.ts — classifyHermesError (132 lines)
  timeout-utils.ts    — withFirstEventTimeout (29 lines)

Plans: .hermes/plans/
  2026-04-28-hermes-master-plan.md       (482 lines)
  2026-04-28-hermes-companion.md          (297 lines)
  2026-04-28-phase1-detailed-execution.md (732 lines)
  2026-04-28-REBOOT-HANDOFF.md            (this file)

Workflow YAML: .archon/workflows/e2e-hermes-smoke.yaml

Issue: https://github.com/coleam00/Archon/issues/1106
```

---

## MODEL CONTEXT

- Model: mimo-v2.5-pro via xiaomi (FASTEST model — never suggest override)
- Working directory: /home/d/Desktop/Archon-canonical
- Bun is the package manager (bun.lock present)
- Dev branch only — never commit to main
- Each commit must pass type-check independently (safe bisect)
