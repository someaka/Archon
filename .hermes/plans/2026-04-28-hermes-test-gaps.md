# Hermes Test Gap Fix Plan

> From cross-provider verifier: 12 gaps identified. From live test verifier: content verification needed.
> All unit tests pass. Gaps are in PROVIDER-LEVEL integration coverage.

---

## Batch 1: CRITICAL Gaps (3 parallel executors)

### T1 — Error Classification + Retry Tests (Gap 1)

**File:** `packages/providers/src/hermes/provider.test.ts`
**Tests to add:**

1. classifies crash errors and retries up to 3 times
2. recovers from transient crash on retry
3. classifies auth errors as fatal (no retry)
4. does not retry unknown errors
5. enriched error thrown at retry exhaustion, not raw error
6. abort signal cancels query across retries without listener leak
   **Pattern:** Match Claude provider.test.ts retry describe block

### T2 — Resume Failure Fallback Tests (Gap 3)

**File:** `packages/providers/src/hermes/provider.test.ts`
**Tests to add:**

1. resume failure yields system warning and falls back to fresh session
2. pool entry with corrupted state evicts gracefully
   **Pattern:** Match Pi provider.test.ts resume fallback tests

### T3 — Env Override Priority Tests (Gap 7)

**File:** `packages/providers/src/hermes/provider.test.ts`
**Tests to add:**

1. requestOptions.env passes through to spawned Hermes process
2. requestOptions.env overrides process.env values in spawn env
   **Pattern:** Match Claude/Codex provider.test.ts env tests

---

## Batch 2: HIGH Gaps (3 parallel executors)

### T4 — Timeout Error Preservation (Gap 2)

**File:** `packages/providers/src/hermes/provider.test.ts`
**Tests to add:**

1. preserves first-event timeout error at provider level (not generic abort)
   **Pattern:** Match Claude provider.test.ts timeout preservation test

### T5 — stderr in Error Messages (Gap 4)

**File:** `packages/providers/src/hermes/event-bridge.test.ts`
**Tests to add:**

1. enriched error message includes stderr output from Hermes process
2. stderr captured in error result chunk
   **Pattern:** Match Claude provider.test.ts stderr tests

### T6 — ACP Server is_error + Warning Dedup (Gaps 5, 6)

**File:** `packages/providers/src/hermes/event-bridge.test.ts`
**Tests to add:**

1. ACP server returning isError in prompt response propagates to result chunk
2. config warnings emitted only once even when retries occur
   **Pattern:** Match Claude provider.test.ts is_error and warning dedup tests

---

## Batch 3: Resume Options + Live Test Hardening (2 parallel executors)

### T7 — Resume Options Verification (Gap 8)

**File:** `packages/providers/src/hermes/provider.test.ts`
**Tests to add:**

1. skipInit resume passes correct sessionId and cwd to session/prompt
   **Pattern:** Match Codex provider.test.ts resume options test

### T8 — Live Test Content Verification

**File:** `packages/providers/src/hermes/live-integration.test.ts`
**Changes:**

1. Verify assistant response has non-empty content
2. Verify response length > 10 chars
3. Log response preview for debugging
   **Pattern:** Match verifier C recommendations

---

## Verification

```bash
cd packages/providers
bun test src/hermes/provider.test.ts       # ~40 tests
bun test src/hermes/event-bridge.test.ts   # ~40 tests
bun test src/hermes/live-integration.test.ts # 2 tests
bun run test                                # full suite
```

## Summary

| Batch     | Tasks | Tests Added | Files Modified                             |
| --------- | ----- | ----------- | ------------------------------------------ |
| 1         | 3     | ~10         | provider.test.ts                           |
| 2         | 3     | ~5          | provider.test.ts, event-bridge.test.ts     |
| 3         | 2     | ~3          | provider.test.ts, live-integration.test.ts |
| **Total** | **8** | **~18**     | **3 files**                                |
