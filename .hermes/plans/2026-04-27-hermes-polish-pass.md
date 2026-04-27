# Hermes Provider — Polish Pass Plan

> **Execution method:** Executor-verifier loop with distinct subagents. Max 3 concurrent executors. Each executor's output is validated by a fresh verifier subagent before marking complete.
>
> **Context:** This plan covers all pre-existing issues, inelegances, coverage gaps, and verification items discovered during the Hermes ACP migration (B1–B7) and final gate run (FG). Items are grouped by domain and dependency. No Hermes functional changes — this is pure polish, verification, and cleanup.

---

## Phase 1: Verify PiProvider Regressions (P0 — Blocker Check)

**Goal:** Confirm whether the 4 PiProvider test failures are truly pre-existing or caused by recent provider-level changes.

**Why this matters:** If PiProvider failures are regressions from shared provider infrastructure changes (e.g., `@archon/paths` mock, `AsyncQueue`, lazy-logger), they must be fixed before any release. If pre-existing, they get their own ticket.

**Verification method:**

1. `git stash` current changes
2. `bun test packages/providers/src/community/pi/provider.test.ts`
3. If failures persist → pre-existing, document and move on
4. If failures disappear → regression, bisect to find cause

**Executor task:** Run the verification steps above, report findings.
**Verifier task:** Re-run the same command in a fresh session, confirm results match.

**Gate:** GREEN = confirmed pre-existing OR root cause identified and fixed.

---

## Phase 2: Type Safety & Mock Hygiene (P1)

### P2.1: Fix mockSpawn type in provider.test.ts

**File:** `packages/providers/src/hermes/provider.test.ts`

**Issue:** `mockSpawn` is typed as returning `never` because the default implementation throws. All `mockImplementationOnce` calls that return `ChildProcess` cause TS2322 errors. These are pre-existing but clutter output and mask real issues.

**Fix:** Change the mock declaration to have a proper return type:

```typescript
const mockSpawn = mock(
  (
    _command: string,
    _args: readonly string[],
    _options?: Record<string, unknown>
  ): ChildProcess => {
    throw new Error('mockSpawn not implemented for this call');
  }
);
```

**Test:** `bun --filter @archon/providers type-check` must pass with zero errors in `provider.test.ts`.

---

### P2.2: Fix top-level await in event-bridge.test.ts

**File:** `packages/providers/src/hermes/event-bridge.test.ts`

**Issue:** Line 8 uses `const { bridgeHermesSession } = await import('./event-bridge');` which triggers TS1378. Pre-existing but should be cleaned up.

**Fix:** Move the dynamic import into a `beforeAll` or use static import after setting up mocks. The mock for `@archon/paths` must be established before `event-bridge` is imported. Reorder the file so mocks come first, then use a static import.

**Test:** `bun --filter @archon/providers type-check` must pass with zero errors in `event-bridge.test.ts`.

---

### P2.3: Fix top-level await pattern in timeout-utils.test.ts

**File:** `packages/providers/src/hermes/timeout-utils.test.ts`

**Issue:** Same pattern — check if it exists and fix if present.

**Test:** `bun --filter @archon/providers type-check` must pass.

---

## Phase 3: Test Quality & Coverage (P1)

### P3.1: Strengthen verifyHermesBinary tests

**File:** `packages/providers/src/hermes/binary-resolver.test.ts`

**Issue:** The "returns true when binary responds to --version" test only checks `typeof resolver.verifyHermesBinary === 'function'`. It doesn't actually exercise the success path. The failure path is tested (non-existent binary returns false), but not the success path.

**Fix:** Mock `execFile` to return success, then assert `verifyHermesBinary('/fake/hermes')` returns `true`. Or use `spyOn` on `child_process.execFile` if accessible.

**Test:** `bun test packages/providers/src/hermes/binary-resolver.test.ts` must pass with both success and failure paths verified.

---

### P3.2: Improve provider.ts coverage

**File:** `packages/providers/src/hermes/provider.ts`

**Issue:** Coverage report shows 42.86% funcs / 65.12% lines. Uncovered lines: 19 (getFirstEventTimeoutMs), 56 (getType), 64 (getCapabilities), 115 (binary not found throw), 121-124 (verifyHermesBinary failure), 126-129 (retry delay), 132-137 (spawn + bridge), 140-150 (catch block paths), 159-160 (final throw).

**Note:** Some uncovered lines are trivial (getType, getCapabilities) or are already tested indirectly. The real gaps are:

- `verifyHermesBinary` failure path (already covered by retry tests)
- Retry delay path (covered by retry recovery test)
- First-event timeout bypass in catch block (covered by hanging test)
- `getFirstEventTimeoutMs` env parsing

**Fix:** Add a test for `getFirstEventTimeoutMs` env parsing. Add a test that verifies the provider throws immediately (no retry) when `verifyHermesBinary` fails with `shouldRetry: false` classification.

**Test:** Coverage report for `provider.ts` should show >80% funcs / >85% lines.

---

### P3.3: Improve binary-resolver.ts coverage

**File:** `packages/providers/src/hermes/binary-resolver.ts`

**Issue:** Coverage shows 50% funcs / 43.24% lines. Uncovered: `INSTALL_INSTRUCTIONS` constant (line 20), `verifyHermesBinary` (lines 62-81).

**Fix:** `INSTALL_INSTRUCTIONS` is a constant — no runtime behavior to test. `verifyHermesBinary` needs the success path test (see P3.1). After P3.1, coverage should improve significantly.

**Gate:** `binary-resolver.ts` coverage >80% funcs / >80% lines.

---

### P3.4: Remove or justify the `ARCHON_HERMES_RETRY_BASE_DELAY_MS` env var

**File:** `packages/providers/src/hermes/provider.ts`

**Issue:** `RETRY_BASE_DELAY_MS` was made env-overridable solely to make the retry-exhaustion test complete in under 5000ms. This is a test-only concern leaking into production code.

**Options:**

1. **Keep with documentation:** Add a comment explaining it's for testability.
2. **Remove and mock time instead:** Use `mock.fn` on `setTimeout` or `Date.now` in tests to make delays instant without env vars.
3. **Extract retry logic:** Move the retry loop into a testable pure function that accepts `delayMs` as a parameter.

**Recommended:** Option 3 — extract `runWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>` into a utility. The provider calls it with default options; tests call it directly with `delayMs: 0`.

**Test:** `bun test packages/providers/src/hermes/provider.test.ts` must pass without setting `ARCHON_HERMES_RETRY_BASE_DELAY_MS`. New utility must have its own test file.

---

## Phase 4: Lint & Tooling (P1)

### P4.1: Investigate lint OOM

**Issue:** `bun run lint` crashes with "Ineffective mark-compacts near heap limit" even with `NODE_OPTIONS='--max-old-space-size=4096'`.

**Diagnosis steps:**

1. Run `bun x eslint . --debug` to see where it hangs
2. Check if `.eslintcache` is corrupted — `rm .eslintcache` and retry
3. Run on individual packages to isolate: `bun x eslint packages/providers/`, `bun x eslint packages/core/`, etc.
4. Check eslint version and plugin count: `bun x eslint --version`, count plugins in `eslint.config.js`

**Fix:** If a specific package or plugin causes the OOM, document and file a separate issue. If cache corruption, document the workaround.

**Gate:** `bun run lint` completes without OOM, OR a documented workaround exists.

---

### P4.2: Verify no temp files left behind

**Command:** `find packages/providers/src/hermes/ -name "*.tmp" -o -name "*.debug" -o -name "test_*.py" | wc -l`

**Gate:** Expected: 0

---

## Phase 5: Workflow Validation Cleanup (P2)

### P5.1: Fix or document workflow validation errors

**Issue:** `bun run cli validate workflows` reports 3 errors:

1. `ERROR [mcp] Node 'notify': MCP config file not found: '.archon/mcp/ntfy.json'`
2. `ERROR [validation_error] Node 'generate-yaml' references unknown node '$other-node.output'` (×2)

**Investigation:**

1. Is `.archon/mcp/ntfy.json` supposed to exist in the repo? Check if it's in `.gitignore` or should be created.
2. Is `$other-node.output` a valid reference pattern? Check the workflow DAG validation logic.

**Fix or document:** If these are intentional examples / documentation workflows, add comments or move them to an `examples/` directory that isn't validated. If they're real bugs, fix them.

**Gate:** `bun run cli validate workflows` reports 0 errors, OR each error has a documented justification.

---

## Phase 6: Cross-Cutting Verification (P1)

### P6.1: Verify no mock.module pollution across Hermes test files

**Issue:** Bun's `mock.module()` permanently replaces modules in the process-wide cache. `provider.test.ts` mocks `./binary-resolver` for specific tests. If other test files in the same process import `./binary-resolver`, they get the mock.

**Check:** Are Hermes test files run in separate processes? `bun test` runs each file in isolation by default, but `bun test packages/providers/src/hermes/` runs them sequentially in the same process.

**Verification:** Run `bun test packages/providers/src/hermes/` and verify all 145 tests pass. If mock pollution exists, some tests would fail. They pass, so no issue. Document this finding.

---

### P6.2: Verify error-classifier edge cases

**File:** `packages/providers/src/hermes/error-classifier.ts`

**Issue:** The classifier returns `shouldRetry: true` for all `unknown` errors. This might be too aggressive. For example, `EACCES` (permission denied) is unlikely to be fixed by retrying.

**Check:** Review the classifier patterns. Should `EACCES`, `ENOENT`, `ENOTDIR` be classified as non-retryable?

**Fix:** Add specific patterns for permission errors and file-not-found errors that should not retry.

**Test:** Add tests for `EACCES`, `ENOENT`, `ENOTDIR` → `shouldRetry: false`.

---

## Phase 7: Documentation & Final Gates (P2)

### P7.1: Update CHANGELOG

**Rule from CLAUDE.md:** Releases follow Semantic Versioning. Since this is a significant feature addition (ACP migration + resilience features), it warrants a minor version bump.

**Task:** Add entries under `## [Unreleased]` for:

- ACP JSON-RPC 2.0 migration
- First-event timeout
- Subprocess retry loop with exponential backoff
- Error classification
- Spawn pre-flight check
- Per-bridge ID generation
- Stderr enrichment
- Max line buffer guard

**Gate:** CHANGELOG.md updated with accurate, concise entries.

---

### P7.2: Final validation gate

**Command:**

```bash
cd /home/d/Desktop/Archon-canonical
bun run validate
```

**Expected:** All five checks pass (check:bundled, type-check, lint, format check, tests).

**If lint still OOMs:** Document the workaround and mark lint as known-issue.

---

## Execution Batches

```
Batch 1 (independent, can parallelize):
  P2.1 — Fix mockSpawn type in provider.test.ts
  P2.2 — Fix top-level await in event-bridge.test.ts
  P2.3 — Fix top-level await in timeout-utils.test.ts
  P4.2 — Verify no temp files

Batch 2 (depends on Batch 1):
  P3.1 — Strengthen verifyHermesBinary tests
  P3.2 — Improve provider.ts coverage
  P3.3 — Improve binary-resolver.ts coverage

Batch 3 (depends on Batch 2, touches provider.ts):
  P3.4 — Extract retry logic or document env var

Batch 4 (independent research):
  P1 — Verify PiProvider regressions
  P4.1 — Investigate lint OOM
  P5.1 — Fix/document workflow errors

Batch 5 (depends on Batch 4 findings):
  P6.2 — Fix error-classifier edge cases (if P1 confirms no regressions)

Batch 6 (final):
  P7.1 — Update CHANGELOG
  P7.2 — Final validation gate
```

---

## Executor-Verifer Rules

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

| Risk                                      | Mitigation                                                         |
| ----------------------------------------- | ------------------------------------------------------------------ |
| PiProvider failures are regressions       | P1 verifies this first; if true, all other work pauses until fixed |
| Lint OOM is unfixable                     | Document workaround; gate passes with known issue                  |
| Retry extraction (P3.4) is large refactor | Keep scope minimal; if complex, document env var instead           |
| Workflow errors are intentional           | Document justification; don't waste time "fixing" examples         |

---

## Files Modified (Expected)

| File                                                     | Action                                  |
| -------------------------------------------------------- | --------------------------------------- |
| `packages/providers/src/hermes/provider.test.ts`         | Fix mockSpawn type, add coverage tests  |
| `packages/providers/src/hermes/event-bridge.test.ts`     | Fix top-level await                     |
| `packages/providers/src/hermes/timeout-utils.test.ts`    | Fix top-level await if present          |
| `packages/providers/src/hermes/binary-resolver.test.ts`  | Strengthen verifyHermesBinary tests     |
| `packages/providers/src/hermes/provider.ts`              | Extract retry logic or document env var |
| `packages/providers/src/hermes/error-classifier.ts`      | Add permission-error patterns           |
| `packages/providers/src/hermes/error-classifier.test.ts` | Add permission-error tests              |
| `CHANGELOG.md`                                           | Add unreleased entries                  |

---

## Remember

```
Fresh subagent per task
Two-stage review every time
Primary source FIRST
No guesses, only verified claims
```
