# REBOOT HANDOFF — Hermes Provider Integration

> Date: 2026-04-29 ~13:30 UTC (UPDATED)
> Status: ALL 320 PROVIDER TESTS PASSING — dag-executor.ts stagger gate uncommitted
> This file is the SINGLE SOURCE OF TRUTH for resuming after reboot.

---

## READ THIS FIRST (in order)

1. THIS FILE (you're reading it)
2. `.hermes/plans/2026-04-29-hermes-workflow-fixes.md` (master plan — historical context)
3. `.hermes/plans/2026-04-29-error-propagation-remediation.md` (error classifier design — COMPLETED)
4. `.hermes/plans/2026-04-29-MERGED-PLAN.md` (merged plan)

---

## WHAT HAPPENED (2026-04-28 → 2026-04-29, ~24h of work)

### Phase 1: Test Timeout Fix + Parallel Execution (Committed)

- Fixed 7 test timeouts caused by ConcurrencyLock cascade and error classifier misclassification
- Changed ConcurrencyLock default maxConcurrency from 1 to 3 (enables parallel workflow execution)
- Fixed error classifier: 'no output within Nms' → shouldRetry=false (was retryable, causing 14s backoff)
- **Committed**: `2d54bdc8` — fix test timeouts and enable parallel workflow execution

### Phase 2: Session Pool freshSession Fix (Committed)

- Discovered session pool ignores `context: fresh` — evaluate node reused code-review session with 200K+ tokens
- Added `freshSession` flag to SendQueryOptions, bypasses pool.acquire when true
- **Committed**: `58ce0d48` — respect context:fresh by bypassing session pool

### Phase 3: Hermes CLI Fixes — Separate Repo (Committed)

- Fixed context probe tiers (256K → 1M max) in `~/.hermes/hermes-agent/agent/model_metadata.py`
- Fixed token estimation overcount (`len(str(msg))` → content-aware counting)
- Fixed compression provider in `~/.hermes/config.yaml` (auto → google for google/gemini-3-flash-preview)
- **Committed**: `020c1728` in hermes-agent repo

### Phase 4: Adversarial Review Findings (Committed)

- Addressed all 10 findings from hermes-pr-verifier workflow
- **Committed**: `1f19c680` — address all 10 findings from adversarial review

### Phase 5: Error Propagation Fix (Committed)

- 3 debuggers found: retry mechanism never fires, errors silently swallowed
- 3 planners designed fix, 3 reviewers validated, unanimous on Proposal C + A fail-fast
- **Root cause**: Bridge computes correct error classification via `buildTerminalError()` → `classifyHermesError(msg, ctx)`, stores result in error chunk, then throws `new Error(terminalErrorMessage)` — **discarding the classification**. Provider retry loop re-classifies with only `error.message` (no context), messages fall through to `unknown/shouldRetry: true`, causing 3 retries with 2s+4s+8s = 14s backoff.
- **Fix**: `HermesClassifiedError` class carries classification through throw. Provider catches it, reads `.classification` directly instead of re-classifying.
- **Committed**: `e0056adb` — propagate error classification from bridge to retry loop
- **Committed**: `60d9d779` — don't retry timeout errors from bridge

### Phase 6: Stagger Gate for Parallel Workflow Nodes (IN PROGRESS)

- Original approach: fixed 10s delay per parallel node (crude, wastes time)
- New approach: gate-based staggering — each parallel node waits for the previous node's first output before firing
- Non-AI nodes (bash, script, loop, approval, cancel) signal immediately
- AI nodes signal on first assistant chunk from the bridge
- Safety timeout: 60s if a node errors before signaling
- **UNCOMMITTED**: `packages/workflows/src/dag-executor.ts` (+49/-6)

---

## CURRENT REPO STATE

### Branch & Commits

```
Repo: /home/d/Desktop/Archon-canonical
Branch: dev
Synced with origin/dev and upstream/dev

Recent commits (newest first):
  e0014ef1 fix(workflows): stagger parallel node starts to avoid API rate limiting
  60d9d779 fix(hermes): don't retry timeout errors from bridge
  e0056adb fix(hermes): propagate error classification from bridge to retry loop
  1f19c680 fix(hermes): address all 10 findings from adversarial review
  58ce0d48 fix(hermes): respect context:fresh by bypassing session pool
  2d54bdc8 fix(hermes): fix test timeouts and enable parallel workflow execution
  c6a3458b docs(hermes): add parallel execution remediation plans and smoke test
```

### Uncommitted Changes (1 file)

```
 M packages/workflows/src/dag-executor.ts    (+49/-6)  ← STAGGER GATE
```

### What's Implemented in dag-executor.ts (stagger gate)

1. `executeNodeInternal()` — new `onFirstOutput` callback parameter
2. First assistant chunk triggers `onFirstOutput()` (signaled once per node)
3. `executeDagWorkflow()` — creates stagger gates per parallel layer
4. Node 0 starts immediately; node N waits for node N-1's `onFirstOutput`
5. Non-AI nodes (bash, loop, approval, cancel, skipped) signal immediately
6. Safety timeout: 60s if a node never signals
7. `Promise.race([staggerGate, timeout])` prevents deadlock

### Provider Tests: ALL PASSING

```
320 pass, 0 fail, 1948 expect() calls
Ran 320 tests across 15 files in 48.53s
```

**CRITICAL**: Tests are run with individual file arguments, NOT directory mode.
Never run `bun test packages/providers/src/hermes/` — picks up live-integration.test.ts (hangs).

---

## CURRENT BLOCKING ISSUE: xiaomi Silent Rate Limiting

### The Problem

xiaomi endpoint (`https://token-plan-ams.xiaomimimo.com/v1`, model `mimo-v2.5-pro`) silently rate-limits by queuing requests instead of returning HTTP 429. This means:

- No 429 status code → no retry logic triggers
- Responses arrive but with 30-60+ second delays
- Parallel workflow nodes compound the problem (3 nodes × 3 retries = 9 concurrent requests)
- Subagent delegation also affected (subagents hit same endpoint)

### What's Been Done

1. ConcurrencyLock default 1→3 (already done, committed)
2. Stagger gate in dag-executor.ts (uncommitted, above)
3. Error propagation fix (committed) — helps when errors DO occur

### What's NOT Done

- The stagger gate hasn't been tested end-to-end yet (only unit-level)
- No xiaomi-specific retry logic (can't detect silent queuing)
- User needs to change the API endpoint (user handles this, never touch config.yaml)

---

## RELATED WORK: Multi-Provider Memory PR

**Separate from Archon work.** PR #17119 at NousResearch/hermes-agent.

- Fork: `/home/d/Desktop/agenda/hermes-agent`, branch `feat/multi-provider-memory`
- 20 commits, 230+ tests passing
- Removes single-external-provider guard in `MemoryManager.add_provider()`
- Adds `memory.providers` list config key
- Status: PR opened, awaiting review
- Key files: `agent/memory_manager.py`, `plugins/memory/__init__.py`, `hermes_cli/config.py`

---

## RELATED WORK: Mnemosyne Memory Provider

- Installed from source at `/home/d/Desktop/agenda/mnemosyne`
- v1.10.2, active in `~/.hermes/config.yaml` after duplicate holographic key removed
- Provider: mnemosyne (native local memory)

---

## WHAT TO DO AFTER REBOOT

### Step 1: Confirm Test Health

```bash
cd /home/d/Desktop/Archon-canonical/packages/providers && bun test src/hermes/config.test.ts src/hermes/concurrency-lock.test.ts src/hermes/error-classifier.test.ts src/hermes/options-translator.test.ts src/hermes/timeout-utils.test.ts src/hermes/model-ref.test.ts src/hermes/session-pool.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts src/hermes/acp-client.test.ts src/hermes/binary-resolver.test.ts src/hermes/registration.test.ts src/hermes/session-resolver.test.ts src/hermes/hermes-mcp-reader.test.ts --timeout 60000
# Expected: 320 pass, 0 fail
```

### Step 2: Review Uncommitted Stagger Gate

```bash
cd /home/d/Desktop/Archon-canonical && git diff packages/workflows/src/dag-executor.ts
```

Decide: commit as-is, test E2E first, or refine.

### Step 3: Run `bun run validate`

```bash
cd /home/d/Desktop/Archon-canonical && bun run validate
# Expected: exit 0
```

### Step 4: E2E Smoke Test (if xiaomi endpoint is working)

```bash
bun run cli workflow run e2e-hermes-smoke --no-worktree
```

### Step 5: Commit Stagger Gate

```bash
cd /home/d/Desktop/Archon-canonical
git add packages/workflows/src/dag-executor.ts
git commit -m "fix(workflows): gate-based stagger for parallel node execution"
```

### Step 6: Run hermes-pr-verifier (if ready for PR)

```bash
bun run cli workflow run hermes-pr-verifier --no-worktree
```

---

## KEY DESIGN DECISIONS (do not change without user approval)

1. **ConcurrencyLock maxConcurrency = 3** — default, tunable via ARCHON_HERMES_MAX_CONCURRENCY env
2. **Bridge throws HermesClassifiedError** — carries classification through throw, no re-classification
3. **Error classifier separates timeout vs rate_limit** — timeout=false retryable, crash (no output)=false
4. **Stagger gate: onFirstOutput callback** — each parallel node waits for previous node's first assistant chunk
5. **Fail loud** — ALL terminal errors throw, not just retryable ones
6. **User handles config.yaml** — never touch endpoint/model/provider settings

---

## KEY FILE PATHS

```
Provider source:   packages/providers/src/hermes/
  event-bridge.ts      — ACP lifecycle, error propagation, HermesClassifiedError throw
  provider.ts          — sendQuery, retry loop, ConcurrencyLock, HermesClassifiedError catch
  error-classifier.ts  — classifyHermesError with timeout/rate_limit split, HermesClassifiedError class
  concurrency-lock.ts  — Async semaphore, default maxConcurrency=3
  provider.test.ts     — 49 tests, retry behavior, pool tests
  event-bridge.test.ts — 68 tests, handler cleanup, error propagation

Workflow source:   packages/workflows/src/
  dag-executor.ts      — stagger gate, onFirstOutput callback, parallel layer execution

Plans: .hermes/plans/
  2026-04-29-REBOOT-HANDOFF.md                    (this file)
  2026-04-29-hermes-workflow-fixes.md              (master plan)
  2026-04-29-error-propagation-remediation.md      (error classifier design)
  2026-04-29-MERGED-PLAN.md                        (merged plan)
  2026-04-29-REBOOT-COMPANION.md                   (companion)

Hermes CLI: ~/.hermes/hermes-agent/agent/model_metadata.py (context tiers, token estimation)
Config: ~/.hermes/config.yaml (endpoint: xiaomi, NEVER touch)
Issue: https://github.com/coleam00/Archon/issues/1106
```

---

## CRITICAL WARNINGS

1. NEVER run `bun test packages/providers/src/hermes/` (directory mode) — picks up live-integration.test.ts — HANGS
2. NEVER run tests while hermes acp processes are running — state.db contention
3. NEVER touch `~/.hermes/config.yaml` endpoint/model/provider — user only
4. All 320 provider tests pass — no outstanding failures
5. dag-executor.ts changes are uncommitted — needs decision (commit / test / refine)
6. xiaomi silently rate-limits by queuing — no 429, no retry trigger, just slow responses
