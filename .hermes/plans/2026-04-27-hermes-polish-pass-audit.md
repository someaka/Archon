# Hermes Polish Pass Plan — Audit Report

## Executive Summary

The polish pass plan is structurally sound and well-scoped, but contains **significant silent failure modes**, **brittle mocking patterns**, and **test design flaws** that will cause regressions, false confidence, and maintenance burden if executed as written. This audit identifies 14 actionable issues across 6 categories.

---

## 1. Silent Failure Modes (5 issues)

### SF-1: PiProvider tests have 4 real failures — plan treats them as "maybe pre-existing"

**Severity: HIGH**

The plan's Phase 1 (P0) frames PiProvider failures as a question: "are they truly pre-existing or caused by recent provider-level changes?" This is the wrong framing. The 4 failures are **real, current regressions** in the test file itself:

- `requestOptions.systemPrompt threads through to DefaultResourceLoader` — fails because `mockBindExtensions` was called 0 times (the provider's default behavior changed; extensions are no longer bound by default, but the test expects binding)
- `extensions are enabled by default (noExtensions: false)` — same root cause
- `interactive: false with extensions on binds empty` — same root cause
- `default (nothing set) binds with UIContext` — same root cause

These are not infrastructure regressions (paths mock, AsyncQueue, lazy-logger). They are **behavioral regressions in the Pi provider's extension-binding logic** that broke 4 tests. The plan's `git stash` verification step is wasted effort — the failures are reproducible right now and the root cause is known: the provider changed its default `enableExtensions` / `interactive` behavior and the tests weren't updated.

**Recommendation:** Remove the "pre-existing vs regression" framing. Fix the 4 failing tests to match the actual provider behavior, or fix the provider to match the tests. Do not gate other work on this.

---

### SF-2: `mock.module()` re-mock in retry tests silently pollutes module cache

**Severity: MEDIUM**

In `provider.test.ts`, lines 370-381 and 412-419:

```typescript
mock.module('./binary-resolver', () => ({ ... }));
const { HermesProvider: HP } = await import('./provider?t=retry1');
```

Bun's `mock.module()` replaces the module in the **process-wide cache**. The `?t=retry1` query parameter does NOT bust Bun's module cache for the `./binary-resolver` dependency — it only busts cache for `./provider.ts`. The re-imported `provider.ts` still resolves `./binary-resolver` from the polluted cache. The test passes by accident because the mock happens to match what the test expects, but if the first mock (line 27-31) and the re-mock (line 370-381) diverged in subtle ways, the test would silently use the wrong mock.

**Recommendation:** Use `mock.module()` with the same module key consistently, or use `import.meta.jest.clearAllMocks()` / `mock.restore()` between tests. Document that `?t=` only busts the target module's cache, not its dependencies.

---

### SF-3: `timeout-utils.ts` has an unhandled Promise rejection on timeout path

**Severity: MEDIUM**

In `withFirstEventTimeout`:

```typescript
const timer = new Promise<never>((_, reject) => {
  setTimeout(() => { reject(...); }, timeoutMs);
});
const result = first ? await Promise.race([gen.next(), timer]) : await gen.next();
```

When the generator wins the race (first event arrives in time), the `timer` promise is never awaited and remains in a pending-then-reject state. In Node/Bun, this creates an **unhandled promise rejection** that may crash the process in future versions or pollute logs. The current tests pass because Bun is lenient about unhandled rejections, but this is a latent bug.

**Recommendation:** Store the timer handle and `clearTimeout()` after the first event arrives. The plan's P2.3 does not mention this — it only checks for top-level await.

---

### SF-4: Error classifier returns `shouldRetry: true` for ALL unknown errors

**Severity: MEDIUM**

`error-classifier.ts` line 66-70:

```typescript
return {
  errorClass: 'unknown',
  shouldRetry: true,
  enrichedMessage: `Hermes error (unknown): ${message}`,
};
```

This means `EACCES` (permission denied), `ENOENT` (file not found), `ENOTDIR`, `EPERM`, and any other non-retryable system error will be retried up to 3 times with exponential backoff. The plan's P6.2 identifies this but does not flag it as a silent failure — it frames it as an edge case to review. It is worse: it is a **production bug** that will delay legitimate failure signals by up to 14 seconds (2s + 4s + 8s).

**Recommendation:** Add `EACCES`, `ENOENT`, `ENOTDIR`, `EPERM`, `EISDIR` to the classifier as non-retryable. This is a code fix, not just a test addition.

---

### SF-5: `verifyHermesBinary` catches ALL errors silently

**Severity: LOW-MEDIUM**

`binary-resolver.ts` line 46-53:

```typescript
export async function verifyHermesBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
```

The bare `catch` swallows `ETIMEDOUT`, `EACCES`, `ENOENT`, and even logical errors (e.g., binary exists but `--version` exits non-zero). The caller cannot distinguish "binary not found" from "binary found but not working" from "permission denied". The provider's error message is the same for all cases: "is not executable or not working".

**Recommendation:** Classify the error type and enrich the message. At minimum, log the raw error for debugging. The plan's P3.1 only asks for a success-path test, not for better error visibility.

---

## 2. Brittle Mocking (4 issues)

### BM-1: `mockSpawn` default implementation throws, but return type is inferred as `never`

**Severity: LOW**

The plan's P2.1 correctly identifies this. `mockSpawn` is declared as:

```typescript
const mockSpawn = mock(
  (_command: string, _args: readonly string[], _options?: Record<string, unknown>) => {
    throw new Error('mockSpawn not implemented for this call');
  }
);
```

Bun infers the return type as `never` because all code paths throw. `mockImplementationOnce(() => mockAcp.process)` then causes TS2322. The plan's fix is correct.

**Status:** Plan handles this correctly.

---

### BM-2: `event-bridge.test.ts` top-level await imports bridge BEFORE mock is set

**Severity: LOW**

Line 8:

```typescript
const { bridgeHermesSession } = await import('./event-bridge');
```

This import happens BEFORE the `@archon/paths` mock on lines 27-30. The plan's P2.2 says the mock "must be established before event-bridge is imported" and proposes reordering. However, the test currently passes because `@archon/paths` is only used for `createLogger`, and the real `createLogger` from `@archon/paths` happens to work in the test environment (it doesn't throw). If `@archon/paths` ever added a side-effect at import time, this test would break.

**Recommendation:** The plan's fix is correct, but the risk is low. The bigger issue is that the mock on line 27-30 is redundant — the real module works fine. Either remove the mock (simpler) or move it above the import (as the plan suggests).

---

### BM-3: `binary-resolver.test.ts` uses `spyOn` on re-imported module functions

**Severity: MEDIUM**

Line 46:

```typescript
const spy = spyOn(resolver, 'fileExists').mockReturnValue(true);
```

`fileExists` is a real exported function. `spyOn` mutates the module's export object. Because `importResolver` uses `?t=${importCounter++}`, each test gets a fresh module evaluation, so the mutation is isolated. However, this pattern is fragile: if Bun changes how `mock.module()` + dynamic import interact, or if the module gets a default export wrapper, `spyOn` will fail silently.

**Recommendation:** The plan does not address this. Use `mock.module('node:fs', () => ({ existsSync: ... }))` instead of spying on `fileExists`. This is more robust because it mocks the underlying dependency, not the re-export wrapper.

---

### BM-4: `provider.test.ts` `createAcpMock` stdin parser silently ignores invalid JSON

**Severity: LOW**

Line 110-112:

```typescript
try {
  const req = JSON.parse(data.trim());
  // ...
} catch {
  // Ignore invalid JSON.
}
```

If the provider ever sends malformed JSON (e.g., due to a serialization bug), the mock silently swallows it and the test may hang or fail with an unrelated timeout. This is a test-only issue but makes debugging harder.

**Recommendation:** Add a `console.warn` or throw in the catch block when `data.trim().length > 0`, so test failures are actionable.

---

## 3. Test Design Flaws (5 issues)

### TDF-1: `verifyHermesBinary` success path is NOT actually tested

**Severity: MEDIUM**

The plan's P3.1 correctly identifies this. The test at `binary-resolver.test.ts:113-119` only checks `typeof resolver.verifyHermesBinary === 'function'`. It does NOT exercise the success path (calling `execFileAsync` and getting `true`). The plan proposes mocking `execFile` — but `execFileAsync` is created via `promisify(execFile)` at module load time, so mocking `execFile` after the module is imported has no effect.

**Recommendation:** Mock `node:child_process` via `mock.module()` BEFORE importing `binary-resolver`, or mock `node:util.promisify` (harder). Alternatively, test `verifyHermesBinary` via integration with a real stub binary. The plan's proposed fix ("Mock execFile to return success") is technically incomplete because `execFileAsync` is already bound.

---

### TDF-2: Coverage targets in the plan are misaligned with actual gaps

**Severity: LOW**

The plan's P3.2 says "Coverage report for provider.ts should show >80% funcs / >85% lines". The current report shows 42.86% funcs / 65.12% lines. The uncovered lines include:

- `getFirstEventTimeoutMs` (line 19) — trivial env parser
- `getType` (line 56) — trivial getter
- `getCapabilities` (line 64) — trivial getter
- Binary not found throw (line 115) — hard to reach because `resolveHermesBinary` returns undefined in dev mode
- Retry delay path (lines 126-129) — tested indirectly by retry recovery test
- Spawn + bridge (lines 132-137) — tested by happy path
- Catch block paths (lines 140-150) — partially tested

The real gap is `getFirstEventTimeoutMs` env parsing and the `shouldRetry: false` immediate-throw path. The plan correctly identifies these but bundles them with trivial getters that don't need tests.

**Recommendation:** Add a targeted test for `getFirstEventTimeoutMs` with env var set/unset. Add a test for `verifyHermesBinary` failure with `shouldRetry: false` (e.g., `EACCES`). Do not chase coverage numbers for trivial getters.

---

### TDF-3: `ARCHON_HERMES_RETRY_BASE_DELAY_MS` env var is a test-only leak

**Severity: MEDIUM**

The plan's P3.4 correctly identifies this. The env var exists only to make the retry-exhaustion test complete in <5000ms. The plan recommends Option 3 (extract retry logic). However, the existing `utils/retry-loop.ts` already has a `withRetry` utility that does exactly this — but `provider.ts` does NOT use it. Instead, `provider.ts` has its own inline retry loop (lines 92-165).

**Recommendation:** Refactor `provider.ts` to use `withRetry` from `utils/retry-loop.ts`. This removes the env var, deduplicates code, and makes the retry logic testable in isolation. The plan should note that the utility already exists.

---

### TDF-4: `event-bridge.test.ts` tests abort signal but does not verify process cleanup

**Severity: LOW**

The abort signal tests (lines 571-631) verify that the stream terminates with an error result, but they do NOT verify:

- `childProcess.kill('SIGTERM')` was called
- `childProcess.kill('SIGKILL')` was called after 5s fallback
- `sigkillTimeout` was cleared if the process exits normally
- The abort listener was removed

The `finally` block in `event-bridge.ts` (lines 381-398) handles all of this, but none of it is asserted in tests.

**Recommendation:** Add assertions on `mock.kill` call count and signal arguments. Add a test where abort fires, then process exits normally before SIGKILL, and verify no timer leak. The plan's P6.1 mentions mock pollution but not cleanup verification.

---

### TDF-5: Plan's executor-verifier loop adds overhead without catching the real risks

**Severity: LOW**

The plan mandates "Each executor's output is validated by a fresh verifier subagent before marking complete" and "Never self-verify". This is good in theory, but the plan's own verification tasks are weak:

- P1 verifier: "Re-run the same command in a fresh session, confirm results match" — this only confirms reproducibility, not correctness.
- P3.1 verifier: "Coverage report must show >80% funcs" — coverage is a proxy, not a guarantee.
- P6.1 verifier: "Run all 145 tests, if mock pollution exists some would fail" — this is probabilistic, not deterministic.

The real risks (silent retries on permission errors, unhandled promise rejections, mock cache pollution) are NOT covered by the verifier tasks as written.

**Recommendation:** Add verifier tasks that specifically inspect:

1. No `catch {}` blocks without logging or re-throwing
2. No `Promise.race` without timer cleanup
3. No `mock.module()` re-mocks without cache-busting ALL dependencies
4. No env vars that are test-only

---

## 4. Lint OOM (P4.1)

The lint OOM is reproducible. The plan's diagnosis steps are correct but incomplete. The OOM happens during `eslint .` on the full repo. Running `bun x eslint packages/providers/` works fine. The issue is likely:

- `.eslintcache` is not the cause (it was removed in the test run)
- A large file or circular dependency in another package causes eslint to blow up
- The `eslint.config.js` may be importing heavy plugins for the whole repo

**Recommendation:** The plan should add a step to run eslint on each package individually to isolate the culprit. The workaround (document OOM as known-issue) is acceptable but should not be the permanent fix.

---

## 5. Workflow Validation Errors (P5.1)

The plan correctly identifies 3 workflow validation errors and proposes investigating whether they are intentional examples. This is the right approach. No additional audit findings.

---

## 6. Cross-Cutting Verification (P6)

### P6.1: Mock module pollution

The plan's conclusion ("no issue, document this finding") is correct for the current test suite. However, the audit found that `provider.test.ts` DOES re-mock `./binary-resolver` mid-test (lines 348-353 and 370-381), and the `?t=` cache-bust does NOT apply to the mocked dependency. This IS a pollution risk, just not one that manifests with the current test data.

### P6.2: Error classifier edge cases

The plan proposes adding tests for `EACCES`, `ENOENT`, `ENOTDIR` → `shouldRetry: false`. This is good, but the classifier currently has NO patterns for these errors. Adding tests alone will fail. The classifier itself must be fixed first.

---

## Summary Table

| ID    | Issue                                                               | Severity   | Plan Coverage                  | Action Required                                             |
| ----- | ------------------------------------------------------------------- | ---------- | ------------------------------ | ----------------------------------------------------------- |
| SF-1  | PiProvider 4 real failures mischaracterized as "maybe pre-existing" | HIGH       | P0 — wrong framing             | Fix tests or provider behavior; remove git stash step       |
| SF-2  | `mock.module()` re-mock doesn't bust dependency cache               | MEDIUM     | Not covered                    | Document `?t=` limitation; use consistent mocks             |
| SF-3  | Unhandled promise rejection in `withFirstEventTimeout`              | MEDIUM     | P2.3 — not mentioned           | Add `clearTimeout` on generator win                         |
| SF-4  | All unknown errors retried aggressively                             | MEDIUM     | P6.2 — framed as review        | Fix classifier to mark permission/fs errors non-retryable   |
| SF-5  | `verifyHermesBinary` swallows all errors silently                   | LOW-MEDIUM | P3.1 — not covered             | Log or classify error types                                 |
| BM-1  | `mockSpawn` inferred as `never`                                     | LOW        | P2.1 — correct                 | Apply plan's fix                                            |
| BM-2  | `event-bridge.test.ts` import order                                 | LOW        | P2.2 — correct                 | Apply plan's fix or remove redundant mock                   |
| BM-3  | `spyOn` on re-imported module exports                               | MEDIUM     | Not covered                    | Mock `node:fs` instead of spying on wrapper                 |
| BM-4  | Mock stdin silently ignores invalid JSON                            | LOW        | Not covered                    | Add warn/throw in catch block                               |
| TDF-1 | `verifyHermesBinary` success path not actually exercised            | MEDIUM     | P3.1 — fix incomplete          | Mock `node:child_process` before import, or use stub binary |
| TDF-2 | Coverage targets chase trivial getters                              | LOW        | P3.2 — partially correct       | Target real gaps only                                       |
| TDF-3 | Retry env var leak; existing `withRetry` utility unused             | MEDIUM     | P3.4 — misses existing utility | Refactor `provider.ts` to use `utils/retry-loop.ts`         |
| TDF-4 | Abort signal tests don't verify process cleanup                     | LOW        | Not covered                    | Add kill/cleanup assertions                                 |
| TDF-5 | Verifier tasks are weak proxies for real risks                      | LOW        | P6 — general                   | Add specific structural checks to verifier mandate          |

---

## Recommended Plan Amendments

1. **Remove P0 git stash verification.** Replace with: "Fix the 4 PiProvider failing tests to match current provider behavior, or fix provider if behavior is unintended."

2. **Add to P2.3:** Fix unhandled promise rejection in `withFirstEventTimeout` by clearing the timer when the generator wins the race.

3. **Amend P3.1:** The success-path test for `verifyHermesBinary` requires mocking `node:child_process` before module import, not `execFile` after import. Document this constraint.

4. **Amend P3.4:** Note that `packages/providers/src/utils/retry-loop.ts` already contains `withRetry`. The task is to refactor `provider.ts` to use it, not to create a new utility.

5. **Add new task (P3.5):** Fix `error-classifier.ts` to classify `EACCES`, `ENOENT`, `ENOTDIR`, `EPERM` as `shouldRetry: false`. Add corresponding tests.

6. **Add new task (P3.6):** Improve `verifyHermesBinary` error visibility — at minimum log the raw error, ideally classify it for better error messages.

7. **Add to P6.1 verifier mandate:** Inspect all `mock.module()` re-mocks to confirm `?t=` cache-busting applies to dependencies, or that dependencies are mocked consistently.

8. **Add to P6.2:** The classifier fix must be implemented BEFORE tests are added, or tests will fail.

9. **Amend P4.1:** Add per-package eslint isolation step to identify the OOM culprit.

---

_Audit completed by subagent. All findings are based on direct inspection of source files and test execution in /home/d/Desktop/Archon-canonical._
