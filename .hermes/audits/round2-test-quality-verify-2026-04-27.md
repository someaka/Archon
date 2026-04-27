# Round 2: Test Quality Verification Report

**Date:** 2026-04-27  
**Scope:** Verify Round 1 test quality claims + find additional issues  
**Method:** Read-only inspection of all 10 test files, hex-level verification of disputed lines, live test execution

---

## Verification of Round 1 Claims

### CLAIM 1: Lines 509-522 of event-bridge.test.ts have broken syntax

**ROUND 1 VERDICT: BROKEN SYNTAX**  
**ROUND 2 VERDICT: INCORRECT — syntax is valid**

The `read_file` tool truncated long lines, making them APPEAR broken. Hex-level verification
(od -An -tx1) of the actual file bytes reveals:

| Line | read_file display (truncated)                                                      | Actual file content (from hex dump)                                                                   |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 513  | `test('redacts OPENAI_API_KEY=*** () => {`                                         | `test('redacts OPENAI_API_KEY= pattern', () => {`                                                     |
| 514  | `expect(redactSecrets('OPENAI_API_KEY=sk-abc...]\');`                              | `expect(redactSecrets('OPENAI_API_KEY=sk-abc123')).toBe('OPENAI_API_KEY=[REDACTED]');`                |
| 518  | `expect(redactSecrets('Authorization: Bearer token1...ion: [REDACTED] token123');` | `expect(redactSecrets('Authorization: Bearer token123')).toBe('Authorization: [REDACTED] token123');` |
| 522  | `expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant...\');`                            | `expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-abc')).toBe('ANTHROPIC_API_KEY=[REDACTED]');`         |

All lines have:

- Properly quoted string literals
- Correct `.toBe()` assertions
- Valid syntax

**Live test result:** 27/27 tests pass, including all `redactSecrets` tests.

### CLAIM 2: isSessionUpdateParams() has no dedicated tests

**ROUND 2 VERDICT: CONFIRMED**

- `isSessionUpdateParams` is exported from `acp-protocol.ts` (line 188)
- `acp-protocol.test.ts` does NOT import or test it
- No test file references `isSessionUpdateParams` directly
- It receives indirect coverage only through event-bridge integration tests
- The guard branch (line 155) IS exercised, but the invalid-params warning branch
  (lines 156-157) is never triggered — no test sends malformed session updates

**Coverage evidence:** `event-bridge.ts` uncovered lines include 156-157
(the `isSessionUpdateParams` reject path).

### CLAIM 3: classifyHermesError object-style API has no tests

**ROUND 2 VERDICT: CONFIRMED**

- The function accepts two call signatures:
  1. Legacy: `classifyHermesError(message, string[], exitCode)`
  2. Object: `classifyHermesError(message, { jsonRpcCode, stderr, exitCode })`
- All 12 tests in `error-classifier.test.ts` use the legacy signature only
- The object-style branch (lines 46-52 in error-classifier.ts) is uncovered
- The JSON-RPC code classification (lines 62-83, handling codes -32700, -32600,
  -32602, -32603, -32000, -32001, -32002) is completely untested

**Coverage evidence:** `error-classifier.ts` has 65.48% line coverage.
Uncovered: lines 46-52 (object-style dispatch) and 62-83 (JSON-RPC codes).

### CLAIM 4: enrichedMessage fields are never asserted in error-classifier tests

**ROUND 2 VERDICT: CONFIRMED**

- The `ClassifiedError` interface has three fields: `errorClass`, `shouldRetry`, `enrichedMessage`
- All 12 tests destructure only `{ errorClass, shouldRetry }`
- `enrichedMessage` is never destructured, never asserted, never mentioned
- The enriched messages have error-class-specific prefixes:
  - `"Hermes protocol error (code N): ..."`
  - `"Hermes server error (code N): ..."`
  - `"Hermes agent error (code N): ..."`
  - `"Rate limit or timeout detected: ..."`
  - `"Authentication failed: ..."`
  - `"Permission or path error detected: ..."`
  - `"Hermes process crashed: ..."`
  - `"Hermes error (unknown): ..."`
- All of these are untested

### CLAIM 5: Event-bridge error tests don't validate error message content

**ROUND 2 VERDICT: CONFIRMED**

- Error-path tests (lines 389-488) check only `{ isError: true }`
- No test validates `errors` array content (except abort test which checks
  `errors: ['Query was aborted']`)
- No test validates that stderr output appears in error results
- No test validates error classification integration (error-classifier
  results flowing through to bridge output)

---

## Additional Test Quality Issues Found

### ISSUE 6: error-classifier.ts JSON-RPC error code branch has zero test coverage

**Severity: HIGH**

The entire JSON-RPC error code classification tree (lines 62-83) is untested:

- `-32700` (Parse error) → `protocol`, shouldRetry=false
- `-32600` (Invalid Request) → `protocol`, shouldRetry=false
- `-32602` (Invalid params) → `protocol`, shouldRetry=false
- `-32603` (Internal error) → `crash`, shouldRetry=false
- `-32000` to `-32002` (server errors) → `unknown`, shouldRetry=true

This is a significant feature with zero test coverage.

### ISSUE 7: provider.ts has uncovered error handling paths

**Severity: MEDIUM**

Coverage: 83.33% functions, 80.49% lines.

Uncovered:

- Lines 25-35: Timeout parsing logic (capping at MAX_TIMEOUT_MS)
- Lines 114-116: Binary verification failure error message
- Lines 151-152: Generic query failure error logging

### ISSUE 8: event-bridge.ts has significant uncovered code paths

**Severity: MEDIUM**

Coverage: 76.47% functions, 82.87% lines.

Key uncovered areas:

- Lines 80, 104, 110-116: Stdin write error handling
- Lines 170-173: Process kill with specific signal handling
- Lines 261-272: Session update validation edge cases
- Lines 280-283, 290, 295: Error enrichment paths
- Lines 335-339, 368-370: Timeout and stderr capture paths

### ISSUE 9: No integration test for classifyHermesError → event-bridge error flow

**Severity: MEDIUM**

The event-bridge uses classifyHermesError internally, but no test verifies
that the classification result flows correctly into the bridge output
(e.g., that a rate-limit error produces a retryable result chunk).

### ISSUE 10: isSessionUpdateParams negative path untested

**Severity: LOW**

The guard at event-bridge.ts:155 (`if (!isSessionUpdateParams(params))`) IS
reached in tests, but the negative branch (lines 156-157, logging a warning
and continuing) is never triggered. No test sends a malformed session/update
notification to verify the guard rejects it.

### ISSUE 11: timeout-utils.test.ts has minimal coverage

**Severity: LOW**

Only 3 tests:

1. First event too slow → throws
2. First event arrives in time → passes through
3. Fast generator completes normally

Missing edge cases:

- Timeout of 0ms
- Generator that throws mid-stream
- Very large number of events after first

---

## Summary Table

| #   | Claim/Issue                         | Round 1 Said | Round 2 Verdict                                   |
| --- | ----------------------------------- | ------------ | ------------------------------------------------- |
| 1   | Lines 509-522 broken syntax         | BROKEN       | **INCORRECT** — valid syntax (display truncation) |
| 2   | isSessionUpdateParams no tests      | MISSING      | **CONFIRMED** — no dedicated tests                |
| 3   | Object-style API untested           | MISSING      | **CONFIRMED** — 0% coverage on that branch        |
| 4   | enrichedMessage never asserted      | MISSING      | **CONFIRMED** — never destructured                |
| 5   | Error message content unchecked     | MISSING      | **CONFIRMED** — only isError checked              |
| 6   | JSON-RPC code branch untested       | —            | **NEW** — 0% coverage, 7 error codes              |
| 7   | provider.ts error paths uncovered   | —            | **NEW** — 80.49% line coverage                    |
| 8   | event-bridge uncovered paths        | —            | **NEW** — 76.47% function coverage                |
| 9   | No classify→bridge integration test | —            | **NEW**                                           |
| 10  | isSessionUpdateParams negative path | —            | **NEW**                                           |
| 11  | timeout-utils minimal coverage      | —            | **NEW**                                           |

**Correction rate:** 1 of 5 Round 1 claims was incorrect (20% false positive rate).

---

## Test Suite Health

```
Total: 143 tests across 10 files
Pass:  143
Fail:  0
Assertions: 238 expect() calls
Execution time: 181ms
```

All tests pass. No runtime issues. The test quality concerns are about
coverage gaps and assertion depth, not about broken tests.
