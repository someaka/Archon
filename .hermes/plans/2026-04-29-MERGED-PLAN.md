# MERGED EXECUTION PLAN — Error Propagation Classification Fix

> Merged from 3 planners (A, B, C) with overlapping responsibilities.
> Conflicts resolved. Ready for executor dispatch.

---

## The Fix (6 files, ~60 lines changed)

### File 1: `error-classifier.ts`

**1a. Add `HermesClassifiedError` class** (after line 14):

```typescript
export class HermesClassifiedError extends Error {
  public readonly classification: ClassifiedError;
  constructor(classification: ClassifiedError) {
    super(classification.enrichedMessage);
    this.name = 'HermesClassifiedError';
    this.classification = classification;
  }
}
```

**1b. Add catch-all for unrecognized JSON-RPC codes** (after line 85, before closing `}` of `if (jsonRpcCode !== undefined)`):

```typescript
// Unrecognized JSON-RPC code — treat as protocol error (non-retryable)
return {
  errorClass: 'protocol',
  shouldRetry: false,
  enrichedMessage: `Hermes protocol error (code ${code}): ${message}`,
};
```

### File 2: `event-bridge.ts`

**2a. Import** (line 22): Add `HermesClassifiedError`, `ClassifiedError`

**2b. Track classification** (after line 159):

```typescript
let terminalClassification: ClassifiedError | undefined;
```

**2c. Modify `emitTerminal`** (lines 316-323) to accept optional classification param and store it.

**2d. Modify `buildTerminalError`** (line 340) to return `classified` object alongside existing fields.

**2e. Update all 6 `buildTerminalError` call sites** to destructure `classified` and pass it to `emitTerminal`.

**2f. Thread `jsonRpcCode` through throws** — at lines 506, 562, 608, attach `__jsonRpcCode` to the Error. At catch blocks (645, 657), extract it and pass to `buildTerminalError`.

**2g. Change terminal throw** (lines 703-708) — **ONLY throw for retryable errors**:

```typescript
if (terminalErrorMessage && terminalClassification?.shouldRetry) {
  throw new HermesClassifiedError(terminalClassification);
}
```

### File 3: `provider.ts`

**3a. Import** `HermesClassifiedError` (line 22)

**3b. Retry loop** (line 203): Use `error.classification` when available:

```typescript
const classified =
  error instanceof HermesClassifiedError
    ? error.classification
    : classifyHermesError(error.message);
```

### File 4: `error-classifier.test.ts`

**4a. Update** unrecognized JSON-RPC test (line 155): expect `protocol/false` instead of `unknown/true`

**4b. Add** `HermesClassifiedError` unit tests

### File 5: `provider.test.ts`

**5a. Test 1417**: Add `, 30000` timeout. Add `HermesClassifiedError` assertions.

**5b. Test 1218**: Revert expectations — bridge no longer throws for non-retryable errors:

- `error2` should be undefined
- `promptCount === 2` (exactly)
- `pool.size === 1` (not evicted)

### File 6: `packages/providers/package.json`

**6a.** Add `--timeout 60000` to the hermes test batch in the `test` script.

---

## Test Impact Matrix

| Test            | Error        | Classification | shouldRetry | Bridge throws?              | Result                |
| --------------- | ------------ | -------------- | ----------- | --------------------------- | --------------------- |
| 861             | JSON-RPC -1  | protocol       | false       | NO                          | <1s ✅                |
| 1218            | JSON-RPC -1  | protocol       | false       | NO                          | <1s ✅                |
| 1417            | exit code 1  | crash          | true        | YES (HermesClassifiedError) | ~14s (30s timeout) ✅ |
| 1603            | panic        | crash          | true        | N/A (pre-bridge)            | ~14s (30s timeout) ✅ |
| 1636            | Unauthorized | auth           | false       | NO                          | instant ✅            |
| 68 bridge tests | various      | various        | various     | N/A                         | all pass ✅           |

---

## Verification

```
STEP 1: bun test src/hermes/error-classifier.test.ts --timeout 30000
STEP 2: bun test src/hermes/concurrency-lock.test.ts --timeout 30000
STEP 3: bun test src/hermes/event-bridge.test.ts --timeout 60000
STEP 4: bun test src/hermes/provider.test.ts --timeout 60000
STEP 5: Full hermes suite (--timeout 60000) → 318 pass
STEP 6: bun run validate → exit 0
STEP 7: Format + commit
```
