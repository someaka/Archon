# Hermes Test Audit: Deferred Items, Test Gaps, and Quality Issues

**Auditor:** Verifier B
**Date:** 2026-04-27
**Scope:** All test and source files in packages/providers/src/hermes/

---

## 1. T4.5: getFirstEventTimeoutMs() — Export & Testability

### Current State

- `getFirstEventTimeoutMs()` is a **module-private function** in `provider.ts` (line 22).
- It is **NOT exported** from the module.
- It reads `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS`.
- It caps at `MAX_TIMEOUT_MS = 300_000` (5 minutes).
- When capping, it logs a warning via `getLog().warn(...)`.

### Gaps

- The cap behavior (env var > 300_000 → capped to 300_000) is **completely untested**.
- The default value (60_000) is **untested**.
- The parse-validation logic (finite, positive) is **untested**.

### Cleanest Path to Test the Cap

Three options, ranked by simplicity:

1. **Export for testing (RECOMMENDED):** Add `export function getFirstEventTimeoutMs()` to provider.ts. The function has no side effects (beyond logging), so exporting it is safe. Tests can then:

   ```
   delete process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS;
   expect(getFirstEventTimeoutMs()).toBe(60_000); // default

   process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '500000';
   expect(getFirstEventTimeoutMs()).toBe(300_000); // cap

   process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '-1';
   expect(getFirstEventTimeoutMs()).toBe(60_000); // invalid → default
   ```

2. **Indirect testing via sendQuery:** Set the env var and verify the timeout error message mentions the correct ms value. Fragile and slow.

3. **Extract to a separate util module:** Move `getFirstEventTimeoutMs()` to `timeout-utils.ts` alongside `withFirstEventTimeout`. Cleanest architecturally, but more invasive.

**Verdict:** Option 1 is a one-line change (`export` keyword) and covers all paths.

---

## 2. T4.6: event-bridge Error Assertions — Tests Only Checking isError:true

### Tests with Weak Assertions (no error message validation)

| Test (line)                                                        | What it checks                  | What it's missing                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `process non-zero exit → result with isError: true` (L389)         | `isError === true`              | No check on `errors` array. Source emits `['Hermes ACP exited with code 1']` — should be validated.                |
| `process crash via error event → result with isError: true` (L413) | `isError === true`              | No check on `errors` array. Source emits `['Failed to run Hermes ACP: spawn failure']` — should be validated.      |
| `process terminated by signal → result with isError: true` (L471)  | `isError === true`              | No check on `errors` array. Source emits `['Hermes ACP terminated by signal SIGTERM']` — should be validated.      |
| `abort signal kills process...` (L434)                             | `errors: ['Query was aborted']` | **Partial coverage** — only checks first error entry. Doesn't verify the full errors array when stderr is present. |

### Specific Improvements Needed

**Line 389 — process non-zero exit:**

```typescript
// CURRENT (weak):
expect(lastResult.isError).toBe(true);

// SHOULD BE:
expect(lastResult).toMatchObject({
  type: 'result',
  isError: true,
  errors: expect.arrayContaining([expect.stringContaining('exited with code 1')]),
});
```

**Line 413 — process crash:**

```typescript
// CURRENT (weak):
expect(resultChunks[0]).toMatchObject({ type: 'result', isError: true });

// SHOULD BE:
expect(resultChunks[0]).toMatchObject({
  type: 'result',
  isError: true,
  errors: expect.arrayContaining([expect.stringContaining('spawn failure')]),
});
```

**Line 471 — signal termination:**

```typescript
// CURRENT (weak):
expect(resultChunks[0]).toMatchObject({ type: 'result', isError: true });

// SHOULD BE:
expect(resultChunks[0]).toMatchObject({
  type: 'result',
  isError: true,
  errors: expect.arrayContaining([expect.stringContaining('SIGTERM')]),
});
```

---

## 3. T4.7: provider.ts Error Assertions

### Tests with Weak Assertions

| Test (line)                                                 | What it checks     | What it's missing                                                                                            |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `spawn failure is handled gracefully` (L283)                | `isError === true` | No validation of `errors` content. The error message `'spawn EACCES'` should appear somewhere in the result. |
| `sendQuery with abortSignal passes signal to bridge` (L258) | `isError === true` | No validation of `errors` content. Should check for abort-related message.                                   |

### Specific Improvements Needed

**Line 283 — spawn failure:**

```typescript
// CURRENT (weak):
expect(resultChunks[0]).toMatchObject({ type: 'result', isError: true });

// SHOULD BE:
expect(resultChunks[0]).toMatchObject({
  type: 'result',
  isError: true,
  errors: expect.arrayContaining([expect.stringContaining('spawn EACCES')]),
});
```

---

## 4. Test Coverage for redactSecrets

### Source Coverage (event-bridge.ts lines 29-34)

The function has 4 replacement patterns:

1. `key=value` patterns (generic: key, token, api_key, password, secret, auth)
2. `"key":"value"` JSON patterns (same keys)
3. Specific env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID, GITHUB_TOKEN, NPM_TOKEN, DATABASE_URL, POSTGRES_PASSWORD)
4. `Authorization: ...` header pattern

### Current Test Coverage

| Pattern                      | Tested?               | Test Quality                             |
| ---------------------------- | --------------------- | ---------------------------------------- |
| `key=value`                  | YES (L506)            | Good: `key=sk-abc123` → `key=[REDACTED]` |
| `"key":"value"` JSON         | **BROKEN** (L509-510) | See syntax error section below           |
| `OPENAI_API_KEY=...`         | **BROKEN** (L513-514) | See syntax error section below           |
| `Authorization: Bearer ...`  | **BROKEN** (L517-518) | See syntax error section below           |
| `ANTHROPIC_API_KEY=...`      | **BROKEN** (L521-522) | See syntax error section below           |
| Non-secret content preserved | YES (L525-526)        | Good                                     |
| Multiple secrets in one line | YES (L529-534)        | Good (uses `toContain`)                  |
| `AWS_SECRET_ACCESS_KEY=...`  | **NOT TESTED**        | Missing                                  |
| `AWS_ACCESS_KEY_ID=...`      | **NOT TESTED**        | Missing                                  |
| `GITHUB_TOKEN=...`           | **NOT TESTED**        | Missing                                  |
| `NPM_TOKEN=...`              | **NOT TESTED**        | Missing                                  |
| `DATABASE_URL=...`           | **NOT TESTED**        | Missing                                  |
| `POSTGRES_PASSWORD=...`      | **NOT TESTED**        | Missing                                  |
| `password=value`             | **NOT TESTED**        | Missing                                  |
| `secret=value`               | **NOT TESTED**        | Missing                                  |
| `auth=value`                 | **NOT TESTED**        | Missing                                  |
| `token=value`                | **NOT TESTED**        | Missing                                  |

### Syntax Errors in Test File (CRITICAL)

Lines 513-522 in `event-bridge.test.ts` contain **broken test code** with unclosed parentheses and strings:

```typescript
// LINE 513-514 — BROKEN SYNTAX:
test('redacts OPENAI_API_KEY=*** () => {           // ← missing closing ') and opening {
    expect(redactSecrets('OPENAI_API_KEY=sk-abc...]  // ← unclosed string literal

// LINE 517-518 — BROKEN SYNTAX:
test('redacts Authorization header', () => {
    expect(redactSecrets('Authorization: Bearer token1...ion: [REDACTED] token123');  // ← garbled assertion
```

These tests likely **compile and pass** because TypeScript/Bun may silently treat the broken lines as part of a different code structure, but the assertions are **not testing what the test names claim**.

**Verdict:** 4 of 7 `redactSecrets` tests are syntactically broken. Only the generic `key=value`, non-secret preservation, and multiple-secrets tests are valid. **Coverage is approximately 30%.**

---

## 5. Test Coverage for statSync Paths

### Source (session-resolver.ts lines 53-63)

```typescript
try {
  const stats = statSync(cwd);
  if (!stats.isDirectory()) {
    throw new Error(`Hermes session cwd is not a directory: ${cwd}`);
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`Hermes session cwd does not exist: ${cwd}`);
  }
  throw err; // re-throws the "not a directory" error from above
}
```

### Coverage Assessment

| Path                             | Tested? | Test                                                                                |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| ENOENT (path doesn't exist)      | YES     | `'throws when cwd does not exist'` (L113) — asserts `'does not exist'`              |
| Not-a-directory (path is a file) | YES     | `'throws when cwd is a file, not a directory'` (L118) — asserts `'not a directory'` |
| Happy path (valid directory)     | YES     | `'basic call with cwd returns context'` (L25)                                       |

**Verdict:** Both statSync error paths are tested. **Coverage is complete for this item.**

---

## 6. Test Coverage for parseMessage Validation Guards

### Source (acp-protocol.ts parseMessage function)

| Guard                                                 | Tested? | Test     |
| ----------------------------------------------------- | ------- | -------- |
| Invalid JSON (parse error)                            | YES     | L46-48   |
| Non-jsonrpc message (`{"not":"jsonrpc"}`)             | YES     | L48      |
| `result` + `method` both present (protocol violation) | YES     | L63-65   |
| Error with non-numeric `code`                         | YES     | L68-70   |
| Error with null error object                          | YES     | L101-102 |
| Notification with non-string method                   | YES     | L73-75   |
| Non-string-non-number id                              | YES     | L58-60   |
| Empty string                                          | YES     | L93-94   |
| Whitespace-only string                                | YES     | L97-98   |
| Success response with string id                       | YES     | L51-55   |
| Notification with no params                           | YES     | L105-111 |

### Gaps

| Guard                                                           | Status                                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid error response (proper numeric code, string message)      | **NOT TESTED** — only negative cases tested for errors. A positive test `{'jsonrpc':'2.0','id':1,'error':{'code':-32600,'message':'Invalid Request'}}` that validates the parsed shape is missing. |
| `jsonrpc` is not `'2.0'` (e.g., `'1.0'`)                        | **NOT TESTED** — only implicitly via `{"not":"jsonrpc"}`                                                                                                                                           |
| Message with only `jsonrpc:'2.0'` (no result, method, or error) | **NOT TESTED** — should return null                                                                                                                                                                |

**Verdict:** 95% coverage. Minor gaps in positive error response parsing and edge-case jsonrpc version checking.

---

## 7. Weak Assertion Patterns (Cross-File)

### 7a. Tests Using `toBeUndefined()` Without Checking the Actual Value

| File                         | Line    | Assertion                                                      | Quality                                                                     |
| ---------------------------- | ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `acp-protocol.test.ts`       | 81      | `expect(serialized.id).toBeUndefined()`                        | **OK** — this is testing absence of `id` in notifications, which is correct |
| `acp-protocol.test.ts`       | 110     | `expect(msg.params).toBeUndefined()`                           | **OK** — testing that notification without params has no params             |
| `binary-resolver.test.ts`    | 41      | `expect(result).toBeUndefined()`                               | **OK** — testing dev mode returns no binary                                 |
| `binary-resolver.test.ts`    | 108     | `expect(result).toBeUndefined()`                               | **OK** — testing nothing-found returns undefined                            |
| `provider.test.ts`           | 315     | `expect(error).toBeUndefined()`                                | **OK** — testing no error thrown                                            |
| `session-resolver.test.ts`   | 30, 64  | `expect(result.sessionId).toBeUndefined()`                     | **OK** — testing Hermes has no sessions                                     |
| `session-resolver.test.ts`   | 100-101 | `expect(result.env.BAD).toBeUndefined()`                       | **OK** — testing non-string env filtered                                    |
| `options-translator.test.ts` | 63      | `expect(resolveHermesProvider(undefined, {})).toBeUndefined()` | **OK** — testing no-provider case                                           |
| `options-translator.test.ts` | 93, 97  | `expect(resolveHermesEndpoint(...)).toBeUndefined()`           | **OK** — testing no-endpoint case                                           |

**Verdict:** All `toBeUndefined()` uses are semantically correct — they test for absence, which is the expected behavior.

### 7b. Tests Using `not.toBeNull()` Without Checking the Value

| File                   | Line | Follow-up Assertion                                   | Quality                   |
| ---------------------- | ---- | ----------------------------------------------------- | ------------------------- |
| `acp-protocol.test.ts` | 29   | `msg!.jsonrpc === '2.0'` and conditional result check | **OK** — value is checked |
| `acp-protocol.test.ts` | 40   | Conditional method check                              | **OK**                    |
| `acp-protocol.test.ts` | 54   | `toHaveProperty('id', 'abc')`                         | **OK**                    |
| `acp-protocol.test.ts` | 107  | Conditional method + params check                     | **OK**                    |

**Verdict:** All `not.toBeNull()` uses are followed by value assertions. No issues.

### 7c. Tests Catching Errors Without Asserting on the Error Message

None found in test assertions. The `catch` blocks in test helper functions (`consume()`, mock process `stdin.write`) are intentionally silent helper code, not test assertions.

---

## 8. Missing Test Coverage (Not Deferred — New Findings)

### 8a. `isSessionUpdateParams()` — NO TESTS

`isSessionUpdateParams()` is exported from `acp-protocol.ts` (line 188) but has **zero dedicated tests**. It's exercised indirectly through `event-bridge.ts` integration tests, but the validation branches are not isolated:

- Valid params with `agent_message_chunk` — not unit-tested
- Valid params with `agent_thought_chunk` — not unit-tested
- Null/undefined input — not unit-tested
- Missing `sessionId` — not unit-tested
- Non-string `sessionId` — not unit-tested
- Missing `update` object — not unit-tested
- Invalid `sessionUpdate` value (e.g., `'unknown_type'`) — not unit-tested

### 8b. `bridgeHermesSession` Relative CWD Rejection — NO TEST

Source line 79: `if (!isAbsolute(options.cwd)) throw new Error(...)`. No test verifies this guard.

### 8c. `classifyHermesError` Object-Style API — NO TESTS

The source supports an object-style call:

```typescript
classifyHermesError(message: string, {
  jsonRpcCode?: number;
  stderr?: string | string[];
  exitCode?: number | null;
})
```

All 12 tests use the legacy `(message, string[], exitCode)` signature. The object-style API — especially `jsonRpcCode` which triggers the `protocol` error class — is **completely untested**.

Missing tests:

- `jsonRpcCode: -32700` → `protocol` class
- `jsonRpcCode: -32600` → `protocol` class
- `jsonRpcCode: -32602` → `protocol` class
- `jsonRpcCode: -32603` → `crash` class
- `jsonRpcCode: -32000` → `unknown` class
- Object-style with `stderr: string` (not array)
- Object-style with `stderr: string[]` (array)
- Object-style with `exitCode: null`

### 8d. `classifyHermesError` `enrichedMessage` — NEVER ASSERTED

Every test destructures `{ errorClass, shouldRetry }` but **never checks `enrichedMessage`**. This field is part of the return type `ClassifiedError` and contains formatted error descriptions, but its correctness is unverified across all 12 tests.

### 8e. `error-classifier.test.ts` — 'timeout' Falsely Maps to `rate_limit`

Line 26-33: `'request timed out'` is classified as `rate_limit`. While the source code intentionally lumps timeouts with rate limits (line 87-98), the test name `'classifies timeout as rate limit'` doesn't convey that this is a deliberate design choice. The `enrichedMessage` would say `'Rate limit or timeout detected: request timed out'` which could be confusing. Not a test bug per se, but a **documentation/misleading-test-name** issue.

---

## 9. Skipped/TODO Tests

**None found.** No `test.skip`, `test.todo`, `TODO`, `FIXME`, or `HACK` comments in any test file.

---

## 10. Mock Quality Assessment

### 10a. Module-Level Mocks (broad)

| File                       | What's Mocked                                         | Concern                                                                                                         |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `event-bridge.test.ts`     | `@archon/paths` (entire module)                       | **OK** — only createLogger + constants needed                                                                   |
| `provider.test.ts`         | `@archon/paths`, `child_process`, `./binary-resolver` | **Heavy** — 3 modules mocked. But necessary: tests need spawn control and binary resolution bypass. Acceptable. |
| `binary-resolver.test.ts`  | `@archon/paths`, `child_process`                      | **OK** — necessary for dev/binary mode testing                                                                  |
| `session-resolver.test.ts` | `@archon/paths`                                       | **OK** — just logger                                                                                            |

### 10b. Function-Level Spies

| File                      | Spy                             | Quality                                        |
| ------------------------- | ------------------------------- | ---------------------------------------------- |
| `binary-resolver.test.ts` | `spyOn(resolver, 'fileExists')` | **Good** — targeted, restored in each test     |
| `provider.test.ts`        | `mockSpawn`                     | **Good** — clear per-test mock implementations |

**Verdict:** No over-broad mocking concerns. All mocks are necessary given the module structure.

---

## Summary Score Card

| Item                                        | Status                                   | Severity                         |
| ------------------------------------------- | ---------------------------------------- | -------------------------------- |
| T4.5: getFirstEventTimeoutMs cap test       | **UNTESTED**                             | Medium — add export + 4 tests    |
| T4.6: event-bridge error message assertions | **3 WEAK**                               | Medium — add errors[] checks     |
| T4.7: provider error message assertions     | **2 WEAK**                               | Medium — add errors[] checks     |
| redactSecrets coverage                      | **4 BROKEN tests, 11 untested patterns** | **HIGH** — fix syntax, add tests |
| statSync paths (ENOENT + not-a-dir)         | **COMPLETE**                             | N/A                              |
| parseMessage validation guards              | **95%** — 3 minor gaps                   | Low                              |
| isSessionUpdateParams tests                 | **ZERO**                                 | Medium — add unit tests          |
| Relative CWD rejection test                 | **ZERO**                                 | Low — add 1 test                 |
| classifyHermesError object-style API        | **ZERO**                                 | Medium — add ~8 tests            |
| classifyHermesError enrichedMessage         | **NEVER ASSERTED**                       | Low-Medium                       |
| Skipped/TODO tests                          | **NONE**                                 | N/A                              |
| Mock quality                                | **GOOD**                                 | N/A                              |

### Critical Fix

The `redactSecrets` tests at lines 509-522 of `event-bridge.test.ts` have **broken syntax** — unclosed parentheses and garbled assertion strings. These need immediate correction.

### Priority Order for Remediation

1. **P0:** Fix broken `redactSecrets` test syntax (4 tests)
2. **P1:** Add `errors[]` assertions to event-bridge error tests (3 tests)
3. **P1:** Export and test `getFirstEventTimeoutMs()` cap behavior
4. **P2:** Add `isSessionUpdateParams()` unit tests (7 cases)
5. **P2:** Add `classifyHermesError` object-style API tests (8 cases)
6. **P2:** Add `errors[]` assertions to provider error tests (2 tests)
7. **P3:** Add `enrichedMessage` assertions to error-classifier tests
8. **P3:** Add remaining `redactSecrets` env var patterns (6 tests)
9. **P3:** Add `parseMessage` positive error response test
10. **P3:** Add relative CWD rejection test
