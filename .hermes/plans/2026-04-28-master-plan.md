# Master Plan — Hermes Provider Fixes

> Merged from 3 planner deliverables (1437 lines total)
> Date: 2026-04-28
> Status: READY FOR EXECUTION

---

## Issue 1: event-bridge.ts Generator Architecture (CRITICAL)

**Root cause:** `bridgeHermesSession` generator awaits `session/prompt` (line 578) before entering the consumer loop (line 628). Session/update notifications are queued during prompt but never yielded until prompt completes. First-event timeout degenerates into full-prompt-completion timeout.

**Fix:** Move the `for await` consumer loop BEFORE `sendRequest(session/prompt)`. Start yielding from queue concurrently with prompt processing.

**Changes:**

- event-bridge.ts: Wrap prompt logic (lines 562-624) in `async function executePrompt()`. Call WITHOUT await. Start consumer loop immediately after. Consumer yields queued items as they arrive during prompt processing.
- Preserve: backpressure, error propagation, isError, terminal events, abort handling

**Files:** `packages/providers/src/hermes/event-bridge.ts`
**Planner deliverable:** `/tmp/plannerA-event-bridge-fix.md` (589 lines)

---

## Issue 2: Hermes Config Discovery (CRITICAL)

**Root cause:** provider.ts trusts `assistantConfig` from Archon's config.yaml (kimi-k2.6 via opencode-go). Never reads `~/.hermes/config.yaml` to discover what Hermes is actually using (mimo-v2.5-pro via xiaomi).

**Fix:** Add `getHermesLiveConfig()` that reads from `~/.hermes/config.yaml`. Live config wins for model/provider. Archon config only for operational settings (globalAuth, hermesBinaryPath).

**Changes:**

- config.ts: Add `getHermesLiveConfig()` — reads ~/.hermes/config.yaml, extracts model.default and model.provider. Returns {} on error (defensive).
- provider.ts: Add `buildHermesConfig()` — merges operational settings from Archon with live model/provider from hermes. Live config wins.
- provider.ts: Fix temp HERMES_HOME condition from `if (options?.model || config.provider || config.endpoint)` to `if (options?.model)` — only create temp home when workflow explicitly overrides model.
- dag-executor.ts: Add debug log when hermes has no model specified.

**Files:** `packages/providers/src/hermes/config.ts`, `packages/providers/src/hermes/provider.ts`, `packages/workflows/src/dag-executor.ts`
**Planner deliverable:** `/tmp/plannerB-hermes-config-discovery.md` (425 lines)

---

## Issue 3: Workflow Setup Node (HIGH)

**Root cause:** hermes-pr-verifier.yaml has NO bun install step. Worktrees don't have node_modules. All validation gates fail.

**Same issue in:** archon-audit-to-pr.yaml, archon-adversarial-fix.yaml

**Fix:** Add setup node with bun install to all 3 workflows. Wire as dependency for validation gates.

**Changes:**

- hermes-pr-verifier.yaml: Add setup node after scope. Wire type-check, lint-check, test-gates to depend on [scope, setup].
- archon-audit-to-pr.yaml: Add setup node after branch-setup. Wire implement-fixes, validate to depend on [setup].
- archon-adversarial-fix.yaml: Add setup node after parse-audit. Wire implement-fixes, type-check, lint-check, test-gates to depend on [setup].
- hermes-local-review.yaml: No change needed (no bash commands).

**Files:** `.archon/workflows/hermes-pr-verifier.yaml`, `.archon/workflows/archon-audit-to-pr.yaml`, `.archon/workflows/archon-adversarial-fix.yaml`
**Planner deliverable:** `/tmp/plannerC-workflow-fixes.md` (423 lines)

---

## Issue 4: Hard-Coded Model Removal (HIGH)

**Root cause:** archon-audit-to-pr.yaml (line 3) and archon-adversarial-fix.yaml (line 17) hard-code `model: kimi-k2.6`. This overrides hermes config and forces the reasoning model that causes timeouts.

**Fix:** Remove hard-coded model lines. Let hermes config be authoritative (depends on Issue 2 being fixed first).

**Changes:**

- archon-audit-to-pr.yaml: Remove `model: kimi-k2.6` (line 3)
- archon-adversarial-fix.yaml: Remove `model: kimi-k2.6` (line 17)

**Files:** `.archon/workflows/archon-audit-to-pr.yaml`, `.archon/workflows/archon-adversarial-fix.yaml`
**Dependency:** Issue 2 must be fixed first (config discovery must work before removing explicit models)

---

## Execution Order

```
Batch 1 (parallel):
  E1: event-bridge.ts generator fix (Issue 1)
  E2: hermes config discovery (Issue 2)
  E3: workflow setup nodes (Issue 3 — hermes-pr-verifier only)

Batch 2 (sequential after Batch 1):
  E4: Remove hard-coded models (Issue 4 — depends on E2)
  E5: Setup nodes for remaining workflows (Issue 3 — archon-audit-to-pr, archon-adversarial-fix)

Batch 3 (verification):
  V1: Run hermes-pr-verifier workflow — all agents should succeed
  V2: Run unit tests — 263+ pass
  V3: Run validate — type-check, lint, format, tests all pass
```

---

## Verification Gates

| Gate             | Command                                                             | Expected            |
| ---------------- | ------------------------------------------------------------------- | ------------------- |
| Unit tests       | `bun run test`                                                      | 263+ pass, 0 fail   |
| Type check       | `bun run type-check`                                                | clean               |
| Lint             | `bun run lint`                                                      | 0 warnings          |
| Live test        | `bun test src/hermes/live-integration.test.ts --timeout 300000`     | 2 pass              |
| PR verifier      | `bun run cli workflow run hermes-pr-verifier "test"`                | All 6 nodes succeed |
| Config discovery | Manual: verify hermes uses mimo-v2.5-pro from ~/.hermes/config.yaml | Correct model       |
