# Audit Report: Hermes Polish Pass Plan (2026-04-27)

**Auditor:** Hermes subagent (audit task)
**Date:** 2026-04-27
**Plan audited:** `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-27-hermes-polish-pass.md`
**Scope:** YAGNI violations, scope creep, missing verification gates

---

## Executive Summary

The polish pass plan is **mostly well-scoped** but contains **significant scope creep** in Phases 5–7, **several YAGNI items**, and **missing verification gates** for cross-cutting concerns. The plan should be trimmed by ~30% to stay true to "pure polish, verification, and cleanup."

---

## 1. YAGNI (You Aren't Gonna Need It)

### 1.1 P3.4 — Extract retry logic into a utility (Option 3 recommended)

- **Verdict:** YAGNI / Scope creep
- **Reasoning:** The `ARCHON_HERMES_RETRY_BASE_DELAY_MS` env var is test-only pollution, but extracting a full `runWithRetry<T>` utility with its own test file is over-engineering for a 3-attempt retry loop with exponential backoff. The simpler fix (Option 2: mock `setTimeout` in tests, or Option 1: document the env var) achieves the same goal with 1/10th the code. A standalone retry utility implies it will be reused across the codebase, but no other provider uses this pattern.
- **Recommendation:** Downgrade to Option 1 (add a comment) or Option 2 (mock setTimeout). Do NOT extract a utility.

### 1.2 P5.1 — Fix or document workflow validation errors

- **Verdict:** YAGNI for Hermes polish
- **Reasoning:** The 3 workflow validation errors (`archon-smart-pr-review` MCP config missing, `archon-workflow-builder` unknown node reference) are **not Hermes-related**. Fixing them is a general repo hygiene task that has nothing to do with the Hermes provider. Including this in a Hermes-specific polish pass dilutes focus.
- **Recommendation:** Remove from this plan. File a separate "workflow validation cleanup" ticket if needed.

### 1.3 P7.1 — Update CHANGELOG

- **Verdict:** YAGNI for a polish pass
- **Reasoning:** CHANGELOG updates should happen at release time, not during a polish pass. The plan itself says "No Hermes functional changes — this is pure polish." A polish pass should not bump versions or add CHANGELOG entries for internal cleanup.
- **Recommendation:** Remove. Add a note: "CHANGELOG update deferred to release PR."

### 1.4 P6.2 — Add EACCES/ENOENT/ENOTDIR patterns to error-classifier

- **Verdict:** YAGNI / Speculative
- **Reasoning:** The plan states the classifier "might be too aggressive" but provides **no evidence** that these errors actually occur in production or tests. `verifyHermesBinary` already handles binary-not-found by returning `false` (not throwing). The retry loop only catches errors from `spawn` and `bridgeHermesSession`. Permission-denied on `spawn` is extremely rare and would surface as a `crash` (non-zero exit) anyway.
- **Recommendation:** Remove unless a concrete failure case is demonstrated. If kept, downgrade to a "document current behavior" task, not a code change.

---

## 2. Scope Creep

### 2.1 Phase 5 (Workflow Validation Cleanup) — Entire phase is out-of-scope

- **Evidence:** Workflow validation errors are in `.archon/workflows/`, not `packages/providers/src/hermes/`.
- **Impact:** Diverts 1–2 executor cycles from Hermes-specific work.
- **Fix:** Remove Phase 5 entirely.

### 2.2 Phase 7 (Documentation & Final Gates) — Partially out-of-scope

- **P7.1 (CHANGELOG):** As noted above, this is release work, not polish.
- **P7.2 (Final validation gate):** This is a **meta-gate**, not a task. It should be the closing step of the plan, not a separate phase with its own batch. The `bun run validate` command includes lint, which is known to OOM — the plan already acknowledges this may fail. A gate that is expected to fail is not a useful gate.
- **Fix:** Collapse P7.2 into a single "Final Gate" checklist at the end of the plan. Remove P7.1.

### 2.3 P3.2 — Improve provider.ts coverage to >80% funcs / >85% lines

- **Verdict:** Scope creep (ambitious target for trivial functions)
- **Reasoning:** The uncovered functions are `getType()` (returns `'hermes'`), `getCapabilities()` (returns `HERMES_CAPABILITIES`), and `getFirstEventTimeoutMs()` (env parser). These are 1-liners. Achieving >80% funcs requires testing these trivial getters, which adds noise, not value. The plan even admits "Some uncovered lines are trivial."
- **Recommendation:** Change target to >70% funcs / >85% lines, or explicitly exclude trivial getters from the target.

### 2.4 P3.3 — Improve binary-resolver.ts coverage

- **Verdict:** Minor scope creep
- **Reasoning:** The only uncovered function is `verifyHermesBinary` (success path) and `INSTALL_INSTRUCTIONS` (constant). P3.1 already covers `verifyHermesBinary`. Having a separate phase (P3.3) with its own gate is redundant.
- **Recommendation:** Merge P3.3 into P3.1. Single gate: `binary-resolver.test.ts` passes with success+failure paths for `verifyHermesBinary`.

---

## 3. Missing Verification Gates

### 3.1 No gate for "mock.module pollution" verification (P6.1)

- **Issue:** P6.1 says "Run `bun test packages/providers/src/hermes/` and verify all 145 tests pass." But the plan does not specify what to do if they **don't** pass. The audit file (`audit-hermes-tests.md`) explicitly warns that mock pollution **will** occur because `provider.test.ts` and `event-bridge.test.ts` both mock `@archon/paths` in the same batch.
- **Fix:** Add a clear gate: If any test fails in combined run, split the test batch in `package.json` as recommended in `audit-hermes-tests.md` (Batch 1–6).

### 3.2 No gate for PiProvider regression root-cause (P1)

- **Issue:** P1 says "If failures disappear → regression, bisect to find cause." But there is no gate for what happens after bisection. If the cause is a shared utility change (e.g., `AsyncQueue`), the fix may touch non-Hermes code.
- **Fix:** Add explicit escalation gate: "If regression is confirmed and root cause is outside `packages/providers/src/hermes/`, pause all Hermes polish work and file a separate P0 fix ticket."

### 3.3 No gate for lint OOM workaround documentation (P4.1)

- **Issue:** P4.1 says "Document workaround" as a fallback, but there is no gate verifying the documentation was actually written or where it lives.
- **Fix:** Add gate: "If lint OOM persists, add a `## Known Issues` section to `packages/providers/README.md` (or `CLAUDE.md`) with the workaround command."

### 3.4 No gate verifying `provider.ts` env spread fix

- **Issue:** `audit-hermes-tests.md` (section 2.5) identifies a real bug: `provider.ts:134` does `env: { ...process.env, ...session.env }`, which re-introduces `undefined` values that `resolveHermesSession` already filtered. This is a **functional bug**, not a polish item. The polish pass plan **completely omits** this.
- **Fix:** Add P2.4: Fix `provider.ts:134` to use `env: session.env` (since `resolveHermesSession` already merges). Gate: `session-resolver.test.ts` passes and `provider.test.ts` passes.

### 3.5 No gate for stale mock file cleanup

- **Issue:** `audit-hermes-tests.md` (section 4.1) identifies `hermes-cli.mock.ts` as 361 lines of dead code. The polish pass plan does not mention it.
- **Fix:** Add P4.3: Delete `packages/providers/src/test/mocks/hermes-cli.mock.ts`. Gate: `grep -r "createMockHermesProcess\|createSimpleTextMock" packages/providers/src/ --include="*.ts"` returns 0 hits.

### 3.6 No gate for test batch isolation fix

- **Issue:** `audit-hermes-tests.md` (section 5.1) warns that 8 Hermes test files run in a single `bun test` invocation, violating the project rule: "Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation."
- **Fix:** Add P4.4: Split Hermes test batch in `package.json` into isolated groups. Gate: `bun test packages/providers/src/hermes/` passes when run as a single command (not just individual files).

---

## 4. Inaccuracies / False Claims in the Plan

### 4.1 "No Hermes functional changes" — False

- **Evidence:** P3.4 (extract retry utility), P6.2 (error-classifier changes), and the missing `env: session.env` fix (section 3.4 above) are all functional changes.
- **Fix:** Change preamble to: "No Hermes **user-facing** functional changes — this is internal cleanup, test hardening, and bug fixes."

### 4.2 "Coverage report shows 42.86% funcs / 65.12% lines" for provider.ts — Accurate but misleading

- **Evidence:** The 42.86% funcs includes trivial getters. The actual logic (sendQuery, retry loop) is well-covered.
- **Fix:** Clarify in P3.2 that the target excludes `getType`, `getCapabilities`, and `getFirstEventTimeoutMs`.

### 4.3 "All 145 tests pass" in P6.1 — Unverified claim

- **Evidence:** The plan assumes 145 tests, but `bun test packages/providers/src/hermes/` was not actually run during planning. The test count may have changed.
- **Fix:** Change to: "Run `bun test packages/providers/src/hermes/` and verify **all** tests pass. Record the actual test count in the verifier report."

---

## 5. Recommended Plan Restructure

### Removed items

- P3.4 (extract retry utility) → Replace with P3.4-light: Add comment to `ARCHON_HERMES_RETRY_BASE_DELAY_MS`.
- P5.1 (workflow validation) → Remove entirely.
- P6.2 (error-classifier EACCES/ENOENT) → Remove unless evidence provided.
- P7.1 (CHANGELOG) → Remove.

### Added items

- P2.4: Fix `provider.ts:134` env spread bug (from `audit-hermes-tests.md` 2.5).
- P3.3-light: Merge binary-resolver coverage into P3.1.
- P4.3: Delete stale `hermes-cli.mock.ts`.
- P4.4: Split Hermes test batch in `package.json` to prevent mock pollution.

### Rewritten items

- P7.2: Collapse into a single "Final Gate" checklist.
- P6.1: Add explicit failure-handling gate.

### Revised batch structure

```
Batch 1 (independent, can parallelize):
  P2.1 — Fix mockSpawn type in provider.test.ts
  P2.2 — Fix top-level await in event-bridge.test.ts
  P2.3 — Fix top-level await in timeout-utils.test.ts
  P2.4 — Fix provider.ts env spread bug
  P4.2 — Verify no temp files
  P4.3 — Delete stale hermes-cli.mock.ts

Batch 2 (depends on Batch 1):
  P3.1 — Strengthen verifyHermesBinary tests (covers P3.3-light)
  P3.2 — Improve provider.ts coverage (adjusted target)

Batch 3 (depends on Batch 2, touches provider.ts):
  P3.4-light — Document ARCHON_HERMES_RETRY_BASE_DELAY_MS

Batch 4 (independent research):
  P1 — Verify PiProvider regressions
  P4.1 — Investigate lint OOM
  P4.4 — Split Hermes test batch in package.json

Batch 5 (final):
  P6.1 — Verify no mock.module pollution
  Final Gate — Run all Hermes tests, type-check, verify no temp files
```

---

## 6. Risk Assessment

| Risk                                               | Severity | Mitigation                                        |
| -------------------------------------------------- | -------- | ------------------------------------------------- |
| P3.4 (retry extraction) is large refactor          | Medium   | Already addressed: replace with comment/doc       |
| Missing `env: session.env` fix causes runtime bugs | High     | Add P2.4 to plan                                  |
| Test batch mock pollution causes flaky tests       | High     | Add P4.4 to plan                                  |
| Stale `hermes-cli.mock.ts` misleads future devs    | Low      | Add P4.3 to plan                                  |
| Lint OOM blocks final gate                         | Low      | Document workaround; gate passes with known issue |

---

## 7. Files Created

- `/home/d/Desktop/Archon-canonical/.hermes/audits/2026-04-27-polish-pass-plan-audit.md`

---

## 8. Conclusion

The polish pass plan is **sound in intent** but needs **trimming and hardening**:

1. Remove out-of-scope items (workflow validation, CHANGELOG, speculative error-classifier changes).
2. Add missing items identified in prior audits (`env` spread bug, stale mock deletion, test batch isolation).
3. Soften coverage targets to avoid testing trivial getters.
4. Add explicit failure-handling gates for every verification task.

**Estimated scope reduction:** 30% fewer tasks, 100% more relevant gates.
