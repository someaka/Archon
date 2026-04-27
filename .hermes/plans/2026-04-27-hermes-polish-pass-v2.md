# Hermes Provider — Polish Pass Plan (Verifier-Audited v2)

> **Execution method:** Executor-verifier loop with distinct subagents. Max 3 concurrent executors. Each executor's output is validated by a fresh verifier subagent before marking complete.
>
> **Audit date:** 2026-04-27
> **Auditors:** 3 independent verifier subagents (code quality, silent failures, YAGNI/scope)
> **Changes from v1:** P3.4 replaced (DRY violation found), Phase 5 removed (out-of-scope), 3 new critical items added from prior audit, P7 collapsed to single gate.

---

## Phase 1: Verify PiProvider Regressions (P0 — Blocker Check)

**Goal:** Confirm whether the 4 PiProvider test failures are truly pre-existing or caused by recent provider-level changes.

**Status:** VERIFIER CONFIRMED — failures are pre-existing (not regressions from Hermes migration). No bisection needed.

**Gate:** GREEN — documented as pre-existing. No action required for this polish pass.

---

## Phase 2: Type Safety & Mock Hygiene (P1)

### P2.1: Fix mockSpawn type in provider.test.ts

**File:** `packages/providers/src/hermes/provider.test.ts`

**Issue:** `mockSpawn` is typed as returning `never` because the default implementation throws. All `mockImplementationOnce` calls that return `ChildProcess` cause TS2322 errors. Pre-existing but clutters output.

**Fix:** Change the mock declaration to have explicit `ChildProcess` return type.

**Test:** `bun --filter @archon/providers type-check` must pass with zero errors in `provider.test.ts`.

---

### P2.2: Fix top-level await in event-bridge.test.ts

**File:** `packages/providers/src/hermes/event-bridge.test.ts`

**Issue:** Line 8 uses `const { bridgeHermesSession } = await import('./event-bridge');` which triggers TS1378. Pre-existing.

**Fix:** Reorder file so mocks come first, then use static import.

**Test:** `bun --filter @archon/providers type-check` must pass with zero errors in `event-bridge.test.ts`.

---

### P2.3: Fix top-level await pattern in timeout-utils.test.ts

**File:** `packages/providers/src/hermes/timeout-utils.test.ts`

**Issue:** Same pattern — check if present and fix.

**Test:** `bun --filter @archon/providers type-check` must pass.

---

## Phase 3: Test Quality, Coverage, & Dead Code (P1)

### P3.1: Strengthen verifyHermesBinary tests + improve binary-resolver coverage

**File:** `packages/providers/src/hermes/binary-resolver.test.ts`

**Issue:** The "returns true when binary responds to --version" test only checks `typeof resolver.verifyHermesBinary === 'function'`. It doesn't exercise the success path. Coverage shows 50% funcs / 43% lines.

**Fix:** Mock `execFile` to return success, assert `verifyHermesBinary('/fake/hermes')` returns `true`. `INSTALL_INSTRUCTIONS` constant is a constant — no runtime behavior, no test needed.

**Test:** `bun test packages/providers/src/hermes/binary-resolver.test.ts` must pass with both success and failure paths verified. Coverage >80% funcs / >80% lines.

---

### P3.2: Improve provider.ts coverage (real behavior gaps only)

**File:** `packages/providers/src/hermes/provider.ts`

**Issue:** Coverage shows 42.86% funcs / 65.12% lines. Trivial getters (`getType`, `getCapabilities`) are 1-line functions — testing them is coverage-chasing, not valuable. Real gaps:

- `getFirstEventTimeoutMs` env parsing
- Catch block paths in retry loop
- `verifyHermesBinary` failure → immediate throw (no retry) when `shouldRetry: false`

**Fix:** Add tests for env parsing and non-retryable error classification. Do NOT add tests for trivial getters.

**Test:** Coverage report for `provider.ts` >75% funcs / >80% lines (excluding trivial getters).

---

### P3.3: Remove stale hermes-cli.mock.ts (361 lines dead code)

**File:** `packages/providers/src/hermes/hermes-cli.mock.ts`

**Issue:** 361 lines of dead code. Not imported by any active file. Left over from pre-ACP migration.

**Fix:** Delete file. Verify nothing breaks.

**Test:** `bun --filter @archon/providers type-check` and `bun test packages/providers/src/hermes/` must pass.

---

### P3.4: Migrate Hermes retry loop to shared utility (DRY fix)

**Files:** `packages/providers/src/hermes/provider.ts`, `packages/providers/src/hermes/error-classifier.ts`

**Issue:** VERIFIER FOUND — repo already has `packages/providers/src/utils/retry-loop.ts` with `withRetry<T>()` and `classifyProviderError()`. Hermes duplicates this with its own inline retry loop and `classifyHermesError()`. Also leaks `ARCHON_HERMES_RETRY_BASE_DELAY_MS` env var for test speed.

**Fix:**

1. Replace Hermes inline retry loop with `withRetry()` from `retry-loop.ts`
2. Fold Hermes error patterns into shared `ErrorClassificationRules` (or verify they already exist)
3. Remove `ARCHON_HERMES_RETRY_BASE_DELAY_MS` env var — tests pass `baseDelayMs: 0` to `withRetry()`
4. Delete `error-classifier.ts` if fully superseded

**Test:** `bun test packages/providers/src/hermes/provider.test.ts` must pass without env var. All retry behavior preserved.

**Risk:** This is the largest refactor in the polish pass. If `withRetry()` API doesn't match Hermes needs, document the gap instead of forcing migration.

---

## Phase 4: Lint & Tooling (P1)

### P4.1: Investigate lint OOM

**Issue:** `bun run lint` crashes with heap limit errors even with `NODE_OPTIONS='--max-old-space-size=4096'`.

**Status:** VERIFIER CONFIRMED — repo-wide infrastructure issue, not Hermes-specific.

**Diagnosis:**

1. Run `bun x eslint packages/providers/` to confirm Hermes scope passes
2. If passes, document as repo-wide known issue
3. If fails, investigate plugin count / cache corruption

**Gate:** Hermes scope lint passes, OR documented as repo-wide issue.

---

### P4.2: Verify no temp files left behind

**Command:** `find packages/providers/src/hermes/ -name "*.tmp" -o -name "*.debug" -o -name "test_*.py" | wc -l`

**Gate:** Expected: 0

---

## Phase 5: Cross-Cutting Verification (P1)

### P5.1: Verify no mock.module pollution across Hermes test files

**Issue:** Bun's `mock.module()` permanently replaces modules. Hermes test files run together in same process.

**Status:** VERIFIER CONFIRMED — all 145 tests pass when run together. No pollution detected.

**Gate:** GREEN — documented. No action required.

---

### P5.2: Fix provider.ts env spread bug

**File:** `packages/providers/src/hermes/provider.ts`

**Issue:** VERIFIER FOUND — line 134 (or nearby) uses `env: { ...process.env, ...session.env }` which loses type safety. `process.env` values are `string | undefined`, spreading them into a typed object is unsafe.

**Fix:** Explicitly type the env object or validate entries before spread.

**Test:** `bun --filter @archon/providers type-check` must pass.

---

### P5.3: Fix test batch isolation (mock.module rules)

**File:** `packages/providers/src/hermes/provider.test.ts` and related test files

**Issue:** VERIFIER FOUND — if one test file mocks `./binary-resolver` and another imports it, the first mock wins permanently (Bun #7823). Need to verify all Hermes test files that mock the same module include ALL exports.

**Fix:** Audit all `mock.module()` calls in Hermes test files. Ensure every mock factory for the same module exports the same shape. If dynamic imports with cache-busting exist, isolate them in separate `bun test` invocations.

**Test:** `bun test packages/providers/src/hermes/` must pass (already does, but verify mock shapes are complete).

---

### P5.4: Error-classifier edge cases (conditional)

**File:** `packages/providers/src/hermes/error-classifier.ts`

**Issue:** All `unknown` errors get `shouldRetry: true`. EACCES/ENOENT/ENOTDIR should not retry.

**Status:** VERIFIER DEMOTED — no evidence these errors occur in practice. If P3.4 migrates to shared `classifyProviderError()`, this is handled there.

**Gate:** If P3.4 does NOT migrate to shared utility, add EACCES/ENOENT/ENOTDIR → `shouldRetry: false` with tests. Otherwise, handled by shared utility.

---

## Phase 6: Final Gate (P2)

### P6.1: Single validation gate

**Commands:**

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check
bun test packages/providers/src/hermes/
```

**Expected:** Type-check passes, 145 tests pass, 0 fail.

**If lint still OOMs:** Document as repo-wide known issue.

---

## Execution Batches

```
Batch 1 (independent, can parallelize):
  P2.1 — Fix mockSpawn type in provider.test.ts
  P2.2 — Fix top-level await in event-bridge.test.ts
  P2.3 — Fix top-level await in timeout-utils.test.ts
  P4.2 — Verify no temp files

Batch 2 (depends on Batch 1, touches test files):
  P3.1 — Strengthen verifyHermesBinary tests
  P3.2 — Improve provider.ts coverage (real gaps only)
  P3.3 — Remove stale hermes-cli.mock.ts

Batch 3 (depends on Batch 2, touches provider.ts):
  P3.4 — Migrate Hermes retry to shared retry-loop.ts (or document gap)

Batch 4 (independent research, can parallelize with Batch 1):
  P4.1 — Investigate lint OOM (Hermes scope)
  P5.2 — Fix provider.ts env spread bug
  P5.3 — Fix test batch isolation (mock.module shapes)

Batch 5 (depends on Batch 3 and 4):
  P5.4 — Error-classifier edge cases (conditional on P3.4 outcome)

Batch 6 (final):
  P6.1 — Single validation gate
```

---

## Executor-Verifier Rules

1. **Max 3 concurrent executors** at any time
2. **Never self-verify**: Each executor's work is validated by a fresh verifier subagent
3. **Context isolation**: Each agent receives only its task's scope and file paths
4. **Test mandate**: Every code change must include a test addition or modification
5. **Rollback on failure**: If a task cannot be fixed after 3 iterations, escalate to user
6. **Clean workspace**: No temp files, debug prints, or half-finished changes
7. **Absolute paths**: All file references use absolute paths
8. **Location check**: Every verifier gate starts with `pwd | grep -q "Archon-canonical"`

---

## Risks

| Risk                                              | Mitigation                                                     |
| ------------------------------------------------- | -------------------------------------------------------------- |
| P3.4 migration to shared retry-loop.ts is complex | If API mismatch, document gap instead of forcing migration     |
| Lint OOM is unfixable                             | Document as repo-wide known issue; Hermes scope lint must pass |
| mock.module shape mismatch across test files      | Audit all mocks before Batch 5; fix shapes if needed           |
| Dead code removal (P3.3) breaks unexpected import | Verify with type-check and full test suite before deleting     |

---

## Files Modified (Expected)

| File                                                    | Action                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/providers/src/hermes/provider.test.ts`        | Fix mockSpawn type, add coverage tests                                   |
| `packages/providers/src/hermes/event-bridge.test.ts`    | Fix top-level await                                                      |
| `packages/providers/src/hermes/timeout-utils.test.ts`   | Fix top-level await if present                                           |
| `packages/providers/src/hermes/binary-resolver.test.ts` | Strengthen verifyHermesBinary tests                                      |
| `packages/providers/src/hermes/provider.ts`             | Migrate to shared retry-loop.ts OR document gap; fix env spread          |
| `packages/providers/src/hermes/error-classifier.ts`     | Delete if superseded by shared utility, OR add permission-error patterns |
| `packages/providers/src/hermes/hermes-cli.mock.ts`      | **DELETE** (361 lines dead code)                                         |

---

## Remember

```
Fresh subagent per task
Two-stage review every time
Primary source FIRST
No guesses, only verified claims
DRY — use shared retry-loop.ts, don't duplicate
YAGNI — don't test trivial getters, don't fix non-Hermes issues
```
