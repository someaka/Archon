# POST-COMPRESSION HANDOFF — Hermes Parallel Execution Fix

> Read this FIRST after compression. It tells you exactly what to do.

---

## Quick Resume

1. Load skill: `archon-hermes-methodology`
2. Load skill: `archon-hermes-provider`
3. Read files in this order:
   - This file (you're reading it)
   - `.hermes/plans/2026-04-28-hermes-master-plan.md` (482 lines — the plan)
   - `.hermes/plans/2026-04-28-hermes-companion.md` (297 lines — code templates, gates, risks)
   - `.hermes/plans/2026-04-28-phase1-detailed-execution.md` (732 lines — Phase 1 executor specs)
4. Run Gate 0 (prerequisites)
5. Roll out Phase 1 (3 parallel executors)

---

## Skills Required

- `archon-hermes-methodology` — full pipeline: plan → verifiers → synthesis → executors → gates
- `archon-hermes-provider` — ACP protocol, event-bridge, session pool, test batching
- `writing-plans` — bite-sized tasks, exact file paths, TDD
- `technical-plan-verification` — verify claims against source
- `subagent-driven-development` — dispatch fresh subagent per task
- `executor-verifier-loop` — batch execution with gates
- `systematic-debugging` — 4-phase root cause investigation

---

## Current State

- **Repo**: `/home/d/Desktop/Archon-canonical`, branch `dev`
- **Dev server**: check if running on 127.0.0.1:5173 (`bun run dev`)
- **Git**: clean working tree, 64 ahead / 0 behind upstream/dev
- **Modified files**: packages/workflows/src/executor.ts (post-rebase fix, uncommitted)
- **Hermes tests**: 259 passing (unit + live)
- **Hermes provider**: packages/providers/src/hermes/
- **Issue**: #1106 (Hermes Agent integration)

---

## The Problem

The hermes-pr-verifier workflow hangs when 3 parallel prompt nodes
(code-review, security-scan, protocol-check) all spawn `hermes acp`
processes simultaneously. The e2e-hermes-smoke test (single node) works
fine in 11s.

**Root cause**: `run_conversation()` inside the Hermes agent's Python code
hangs when 3 processes simultaneously access `~/.hermes/state.db` (552MB
SQLite + 286MB WAL). The ACP adapter's `BEGIN IMMEDIATE` write lock with
15 retries and 20-150ms jitter cannot resolve triple-writer contention.

---

## 4 Bugs to Fix

| Bug                   | File                                       | Fix                                               |
| --------------------- | ------------------------------------------ | ------------------------------------------------- |
| stdout handler leak   | event-bridge.ts:178,287,338,379,666-686    | Extract handlers to named refs, remove in finally |
| JSON-RPC ID collision | acp-protocol.ts:52                         | Module-level monotonic counter                    |
| Session pool race     | session-pool.ts:41-48, provider.ts:200-201 | inUse flag + acquire/release                      |
| state.db contention   | provider.ts (external root cause)          | ConcurrencyLock wrapping sendQuery                |

---

## Execution Plan (4 Batches, 10 Commits)

### Gate 0: Prerequisites (before any batch)

```bash
bun test packages/providers/src/hermes/ --timeout 60000  # all pass
git status --short packages/providers/src/hermes/        # no uncommitted changes
bun run type-check                                        # exit 0
```

### Batch 1: P0 Bug Fixes (3 PARALLEL executors)

| Executor | File                                  | Change                           |
| -------- | ------------------------------------- | -------------------------------- |
| 1A       | event-bridge.ts + test                | Handler cleanup in finally block |
| 1B       | acp-protocol.ts + test                | Monotonic global ID counter      |
| 1C       | session-pool.ts + provider.ts + tests | inUse flag, acquire/release      |

**Gate 1**: grep removeListener >= 4, grep globalAcpIdCounter >= 1,
grep acquire/release/inUse >= 3, targeted tests, type-check

### Batch 2: P0 ConcurrencyLock (2 executors, 2A→2B sequential)

| Executor | File                                            | Change                                     |
| -------- | ----------------------------------------------- | ------------------------------------------ |
| 2A       | concurrency-lock.ts (NEW) + test + package.json | Async semaphore                            |
| 2B       | provider.ts + package.json                      | Import lock, wrap sendQuery + retry inside |

**Gate 2**: grep ConcurrencyLock in provider, grep MAX_SUBPROCESS_RETRIES,
grep shouldRetry, concurrency-lock tests, provider tests, type-check

### Batch 3: P1 HermesAcpClient (2 executors, 3A→3B sequential)

| Executor | File                                      | Change                             |
| -------- | ----------------------------------------- | ---------------------------------- |
| 3A       | acp-client.ts (NEW) + test + package.json | Encapsulate child process + ACP    |
| 3B       | provider.ts + session-pool.ts             | Use HermesAcpClient, store in pool |

**Gate 3**: grep HermesAcpClient in pool/provider, grep childProcess = 0 in
provider, verify ConcurrencyLock still present, full hermes tests, type-check, lint

### Batch 4: P1/P2 Diagnostics + Cleanup (3 executors)

| Executor | File             | Change                              |
| -------- | ---------------- | ----------------------------------- |
| 4A       | timeout-utils.ts | buildFirstEventHangDiagnostics      |
| 4B       | —                | Update archon-hermes-provider skill |
| 4C       | —                | bun run validate                    |

**Gate 4**: bun run validate (all pass)

---

## File Overlap

provider.ts is touched in ALL 4 batches — must be sequential.
event-bridge.ts: B1 only. acp-protocol.ts: B1 only.
session-pool.ts: B1→B3. concurrency-lock.ts: B2 only. acp-client.ts: B3 only.

---

## Commit Plan

| #   | Message                                                                       |
| --- | ----------------------------------------------------------------------------- |
| 1   | fix(hermes): remove stdout/stderr/exit/error handlers in bridge finally block |
| 2   | fix(hermes): use monotonic global counter for ACP request IDs                 |
| 3   | fix(hermes): add acquire/release to session pool and wire into provider       |
| 4   | feat(hermes): add ConcurrencyLock for serializing parallel sendQuery calls    |
| 5   | fix(hermes): serialize parallel sendQuery via ConcurrencyLock with retry      |
| 6   | feat(hermes): add HermesAcpClient encapsulating child process + ACP protocol  |
| 7   | refactor(hermes): use HermesAcpClient in provider and session pool            |
| 8   | feat(hermes): add diagnostic dump on first-event timeout                      |
| 9   | chore(hermes): update archon-hermes-provider skill                            |
| 10  | chore(hermes): final validation                                               |

---

## Key Design Decisions

1. **Provider-level fix, not executor-level** — DAG executor is provider-agnostic (SRP)
2. **Keep session pool** — enables multi-turn continuity (Claude/Codex/Pi don't need one)
3. **Inline retry matching Claude** — NOT shared retry-loop.ts (unused dead code)
4. **Retry INSIDE ConcurrencyLock** — not outside (defeats serialization otherwise)
5. **ConcurrencyLock default=1** — tunable via ARCHON_HERMES_MAX_CONCURRENCY env var
6. **HermesAcpClient exposes childProcess getter** — backward-compatible pool migration

---

## Out of Scope

- `available_commands_update` protocol mismatch (logged, ignored)
- state.db vacuum (operational fix, recommend `hermes sessions prune --older-than 30`)
- @agentclientprotocol/sdk migration (P2 future work)
- Cross-provider concurrent tests (YAGNI)

---

## Verification Commands

```bash
# Per-batch
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
bun test packages/providers/src/hermes/acp-client.test.ts --timeout 30000
bun test packages/providers/src/hermes/acp-protocol.test.ts --timeout 30000
bun run type-check

# Final
bun run validate

# E2E
bun run cli workflow run e2e-hermes-smoke --no-worktree
bun run cli workflow run hermes-pr-verifier --no-worktree
```

---

## Risk Register

| Risk                                              | Mitigation                                    |
| ------------------------------------------------- | --------------------------------------------- |
| provider.ts merge conflict between Phase 2 and 3  | \_sendQueryOnce extraction creates clean seam |
| HermesAcpClient.init() double-prompt              | Use empty prompt for init                     |
| event-bridge handler leak persists in Phase 3     | Verify Gate 1 passes before Phase 3           |
| session-pool.test.ts needs mock updates           | Add mockHermesClient() helper                 |
| state.db contention persists with ConcurrencyLock | Lock serializes at Archon level               |

---

## Mnemosyne Context

- User compresses context between phases, expects skills and plans reloaded on resume
- Shorthand: "roll out" = start executing the plan
- mimo-v2.5-pro via xiaomi is the FASTEST model — never blame speed or suggest override
- Zero tolerance for imperfections. All issues are critical.
- CoT is fully visible. Never add hostile characterizations.
- When told to stop: output nothing. When told continue: continue.
