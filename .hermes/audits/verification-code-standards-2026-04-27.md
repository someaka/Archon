# Code Standards Audit — Hermes Provider Remediation

**Auditor**: Verifier 1 (Code Standards Quality)
**Date**: 2026-04-27
**Scope**: 10 modified files in `packages/providers/src/hermes/`
**Baseline**: CLAUDE.md engineering principles, type safety rules, error handling patterns, lint requirements

---

## Files Audited

| #   | File                       | Lines | Status       |
| --- | -------------------------- | ----- | ------------ |
| 1   | `acp-protocol.ts`          | 198   | PASS         |
| 2   | `acp-protocol.test.ts`     | 77    | PASS         |
| 3   | `binary-resolver.ts`       | 81    | PASS         |
| 4   | `binary-resolver.test.ts`  | 150   | **FINDINGS** |
| 5   | `event-bridge.ts`          | 437   | **FINDINGS** |
| 6   | `event-bridge.test.ts`     | 505   | **FINDINGS** |
| 7   | `provider.ts`              | 156   | PASS         |
| 8   | `provider.test.ts`         | 351   | **FINDINGS** |
| 9   | `session-resolver.ts`      | 85    | PASS         |
| 10  | `session-resolver.test.ts` | 112   | PASS         |

---

## Findings

### IMPORTANT-1: `any` usage without justification in binary-resolver.test.ts

**Severity**: IMPORTANT
**Rule**: CLAUDE.md "No `any` types without explicit justification" + "Disabling `no-explicit-any` without justification — Never acceptable"
**File**: `packages/providers/src/hermes/binary-resolver.test.ts`

**Lines 113**:

```typescript
async function importResolverWithExecFile(mockExecFile: (...args: any[]) => any) {
```

**Lines 123, 132, 141** (three occurrences):

```typescript
const mockExecFile = mock((file: string, args: string[], options: any, callback: any) => {
```

**Line 143**:

```typescript
(err as any).killed = true;
```

**Impact**: 6 `any` usages in a single test file. Would trigger `@typescript-eslint/no-explicit-any` warnings, failing CI's `--max-warnings 0` policy.

**Suggested fix**:

```typescript
// Line 113 — use unknown[] and unknown
async function importResolverWithExecFile(
  mockExecFile: (...args: unknown[]) => unknown
) {

// Lines 123/132/141 — use proper Node.js callback types
import type { ExecFileOptions } from 'child_process';
const mockExecFile = mock(
  (file: string, args: string[], options: ExecFileOptions | null | undefined,
   callback: (error: Error | null, stdout: string, stderr: string) => void) => {
```

For line 143, define a typed error interface:

```typescript
const err = new Error('ETIMEOUT') as Error & { killed?: boolean };
err.killed = true;
```

---

### IMPORTANT-2: Unused variable `sig` — would fail `--max-warnings 0`

**Severity**: IMPORTANT
**Rule**: CLAUDE.md "CI enforces `--max-warnings 0`. No warnings allowed."
**Files**:

- `packages/providers/src/hermes/event-bridge.test.ts` line 165
- `packages/providers/src/hermes/provider.test.ts` line 129

**Code** (identical in both files):

```typescript
fauxProcess.kill = (signal?: NodeJS.Signals | number): boolean => {
    const sig = typeof signal === 'number' ? String(signal) : (signal ?? 'SIGTERM');
    fauxProcess.killed = true;
    // ... uses `signal` (the parameter), NOT `sig`
```

**Impact**: `sig` is computed but never referenced. The code uses the raw `signal` parameter directly in the if/else chain below. This triggers `@typescript-eslint/no-unused-vars`, which fails CI.

**Suggested fix**: Remove the unused variable:

```typescript
fauxProcess.kill = (signal?: NodeJS.Signals | number): boolean => {
    fauxProcess.killed = true;
    if (typeof signal === 'string') {
```

---

### IMPORTANT-3: Unchecked `as string` cast before validation in event-bridge.ts

**Severity**: IMPORTANT
**Rule**: CLAUDE.md "No unchecked `as` casts"
**File**: `packages/providers/src/hermes/event-bridge.ts` line 367

**Code**:

```typescript
const sessionResp = await sendRequest(sessionReq);
if ('result' in sessionResp) {
  sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
}
if (!sessionId || typeof sessionId !== 'string' || sessionId.length === 0) {
  throw new Error('Hermes ACP did not return a valid sessionId');
}
```

**Issue**: The `as string` cast on line 367 asserts that `sessionId` is a `string`, but the runtime value may be `undefined` or a non-string. The validation on line 369 catches this, but the type system is lied to in between. TypeScript would not catch a mismatch if someone later accesses `sessionId` between these lines expecting it to truly be a `string`.

**Suggested fix**: Avoid the `as string` cast — let TypeScript infer the type correctly:

```typescript
if ('result' in sessionResp) {
  const result = sessionResp.result as Record<string, unknown>;
  if (typeof result.sessionId === 'string') {
    sessionId = result.sessionId;
  }
}
if (!sessionId) {
  throw new Error('Hermes ACP did not return a valid sessionId');
}
```

---

### MINOR-1: Empty `afterEach` block — dead code

**Severity**: MINOR
**Rule**: CLAUDE.md "KISS", "no dead code introduced"
**File**: `packages/providers/src/hermes/event-bridge.test.ts` line 299

**Code**:

```typescript
afterEach(() => {});
```

**Impact**: No-op `afterEach` is dead code. It adds visual noise without behavior.

**Suggested fix**: Remove the empty `afterEach(() => {});`.

---

### MINOR-2: Unchecked `as string` on `stopReason` in event-bridge.ts

**Severity**: MINOR
**Rule**: CLAUDE.md "No unchecked `as` casts"
**File**: `packages/providers/src/hermes/event-bridge.ts` lines 392-395

**Code**:

```typescript
const stopReason =
  'result' in promptResp
    ? ((promptResp.result as Record<string, unknown>).stopReason as string)
    : undefined;
```

**Issue**: `stopReason` may be `undefined` at runtime (if the Hermes response doesn't include it). The `as string` cast makes TypeScript believe the value is always `string` inside the ternary's truthy branch. The outer variable type is correctly inferred as `string | undefined` from the ternary, so practical impact is nil. But the inner cast is technically unchecked.

**Suggested fix**:

```typescript
const stopReason =
  'result' in promptResp
    ? ((promptResp.result as Record<string, unknown>).stopReason as string | undefined)
    : undefined;
```

---

### MINOR-3: Test helper duplication across event-bridge.test.ts and provider.test.ts

**Severity**: MINOR
**Rule**: CLAUDE.md "DRY + Rule of Three" — currently at 2 copies (extraction not yet required), but worth noting
**Files**:

- `packages/providers/src/hermes/event-bridge.test.ts` lines 22-33 (`consume`), lines 66-204 (`createAcpMock`)
- `packages/providers/src/hermes/provider.test.ts` lines 169-180 (`consume`), lines 55-165 (`createAcpMock`)

**Observation**: The `consume` helper is identical in both files. The `createAcpMock` base structure (EventEmitter + Readable + Writable + kill/unref/ref) is shared but parameterized differently (event-bridge version is more configurable). Per Rule of Three, extraction is not yet required at 2 copies.

**No action needed now** — revisit if a third test file needs these helpers.

---

## Checks Passed (No Findings)

### Type Safety ✅

- All 5 source files use no `any` types
- All exported functions have explicit return types
- `as` casts in source code are guarded by type narrowing (`typeof`, `in`, null checks)
- Discriminated union types used correctly (`MessageChunk`, `JsonRpcMessage`, `BridgeQueueItem`)
- Interface implementations match contracts (`IAgentProvider` → `HermesProvider`)

### Error Handling ✅

- `provider.ts` line 114: Fail-fast on invalid binary (`throw new Error(...)`)
- `event-bridge.ts`: Terminal result chunk always emitted (even on error/abort/crash paths)
- `session-resolver.ts` lines 53-63: Fail-fast on invalid cwd (throws on ENOENT, not-a-directory)
- `binary-resolver.ts` line 47: Binary verification failure logged at debug level, returns false (caller decides)
- No silent error swallowing detected
- Empty catch blocks in event-bridge.test.ts mock (lines 151, 115) are documented as "Ignore invalid JSON" — appropriate for test mocks

### Naming Conventions ✅

- All files use camelCase naming
- Class name matches file name: `HermesProvider` in `provider.ts`
- Interface names: PascalCase with descriptive suffixes (`HermesSessionContext`, `BridgeOptions`, `AcpIdGenerator`)
- Constants: UPPER_SNAKE_CASE (`ACP_METHODS`, `REQUEST_TIMEOUT_MS`, `HERMES_CAPABILITIES`)
- Type guards prefixed with `is` (`isSessionUpdateParams`, `isHermesModelCompatible`)

### Code Standards (KISS/YAGNI/SRP) ✅

- Each module has a single responsibility (protocol types, binary resolution, bridge, session, provider)
- No speculative abstractions added
- No feature flags or config keys without callers
- `capabilities.ts` honestly declares `false` for all unimplemented features (under-declaring)
- `void resumeSessionId` in session-resolver.ts is explicit about intentionally-ignored parameter

### Interface Compliance ✅

- `HermesProvider` implements all 3 `IAgentProvider` methods: `sendQuery`, `getType`, `getCapabilities`
- `sendQuery` signature matches exactly: `(prompt, cwd, resumeSessionId?, options?) → AsyncGenerator<MessageChunk>`
- `getCapabilities` returns `ProviderCapabilities` with all 13 required boolean fields
- `MessageChunk` variants emitted by bridge match the discriminated union in `types.ts`
- Registration (`registerHermesProvider`) uses `registerProvider` with all required `ProviderRegistration` fields

### Mock Isolation ✅

- Test script in `package.json` splits `binary-resolver.test.ts` into a separate `bun test` invocation (line 21: `&& bun test src/hermes/binary-resolver.test.ts`)
- This correctly isolates the `child_process` mock (for `execFile` tests) from the `provider.test.ts` `child_process` mock (for `spawn` tests)
- `@archon/paths` mock is identical across all test files (same factory values), so process-global replacement is consistent
- Dynamic imports with cache-busting (`?t=${importCounter++}`) in binary-resolver.test.ts correctly test both dev/binary modes

### Test Coverage ✅

- `acp-protocol.test.ts`: 9 tests covering create, serialize, parse (success/notification/invalid/edge cases), notification creation
- `binary-resolver.test.ts`: 9 tests covering dev mode, env var, config path, autodetect, missing paths, precedence, verify (success/fail/timeout)
- `event-bridge.test.ts`: 14 tests covering happy path (single/multiple/mixed chunks), result, empty stream, non-zero exit, crash, abort, stderr, signal, system prompt, plus 7 AsyncQueue tests
- `provider.test.ts`: 8 tests covering type, capabilities, spawn, system prompt, abort, spawn failure, resume, custom binary, capabilities reflection
- `session-resolver.test.ts`: 8 tests covering basic, env merge, override, resume, empty cwd, undefined cwd, shape validation, non-string env

### Lint Compliance ✅ (with IMPORTANT-1 and IMPORTANT-2 exceptions)

- No `eslint-disable` comments detected in any file
- No file-level `/* eslint-disable */` directives
- `_encoding` and `_command`/`_args`/`_options` parameters use underscore prefix (acceptable with `argsIgnorePattern: "^_"`)
- `_existsSync` alias uses underscore prefix convention
- `void resumeSessionId` expression suppresses `no-unused-vars` while being explicit about intent

---

## Summary

| Severity  | Count | Action Required  |
| --------- | ----- | ---------------- |
| CRITICAL  | 0     | —                |
| IMPORTANT | 3     | Fix before merge |
| MINOR     | 3     | Optional / track |

**Overall Assessment**: The Hermes provider remediation is well-engineered. Source files (`*.ts`) are clean — no `any` usage, proper error handling, explicit return types, and faithful interface compliance. The 3 IMPORTANT findings are all in test files (2 unused variables, 6 un-justified `any` casts) and one source-level unchecked cast pattern. These are fixable with targeted changes and should be resolved before merge to satisfy the `--max-warnings 0` CI gate.
