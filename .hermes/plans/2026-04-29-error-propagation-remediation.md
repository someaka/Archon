# Remediation Plan — Error Propagation Classification Fix

> Date: 2026-04-29
> Status: READY TO EXECUTE
> Blocks: `bun run validate` (3 tests hang), PR commit for error propagation fix

---

## Root Cause (Unanimous — All 3 Verifiers)

The bridge computes correct error classification with full context (`stderr`, `exitCode`,
`jsonRpcCode`) via `buildTerminalError()` → `classifyHermesError(msg, ctx)`. It stores
the result in the error chunk (`errorSubtype`, `shouldRetry`). Then it throws
`new Error(terminalErrorMessage)` — **discarding the classification**.

The provider retry loop at `provider.ts:203` re-classifies with only `error.message` — no
context. Messages like `"Hermes ACP exited with code 1"` and `"mock prompt failure"` fall
through to `unknown/shouldRetry: true`, causing 3 retries with 2s+4s+8s = 14s backoff.

**Two bugs compound:**

1. **Context loss at throw site** — bridge has full classification, throws plain `Error`
2. **JSON-RPC code loss in inner catch** — `executePrompt()` line 608 throws an Error with
   the code embedded in the message string, but the catch at line 645 calls
   `buildTerminalError(msg, stderrLines)` WITHOUT passing `{ jsonRpcCode }`. The code is
   in the message but the classifier reads the parameter, not the string.

---

## Fix Strategy: `HermesClassifiedError` + Inline JSON-RPC Handling

### Fix 1: `error-classifier.ts` — Add `HermesClassifiedError` class

Add after the `ClassifiedError` interface (line 14):

```typescript
export class HermesClassifiedError extends Error {
  constructor(
    message: string,
    public readonly classification: ClassifiedError,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'HermesClassifiedError';
  }
}
```

### Fix 2: `event-bridge.ts` — Store classification alongside terminalErrorMessage

At module scope (near line 159 where `terminalErrorMessage` is declared), add:

```typescript
let terminalClassification: ClassifiedError | undefined;
```

Modify `buildTerminalError` (line 326-341) to return `shouldRetry` in its return value
(it already does — `{ errors, errorSubtype, shouldRetry }`).

Modify `emitTerminal` (line 316-323) to store the classification when `isError`:

```typescript
function emitTerminal(chunk: Extract<BridgeQueueItem, { kind: 'chunk' }>['chunk']): void {
  if (terminalEmitted) return;
  terminalEmitted = true;
  if (chunk.type === 'result' && chunk.isError) {
    terminalErrorMessage = chunk.errors?.[0] ?? 'Hermes query failed';
    // Store classification for the throw at end of generator
    if (chunk.errorSubtype) {
      terminalClassification = {
        errorClass: chunk.errorSubtype as HermesErrorClass,
        shouldRetry: /* need to pass this through */,
        enrichedMessage: terminalErrorMessage,
      };
    }
  }
  queue.push({ kind: 'chunk', chunk });
}
```

**Problem**: `emitTerminal` receives the chunk but `shouldRetry` is only in the
`buildTerminalError` return value, not propagated to the chunk. Two options:

- **(A)** Add `shouldRetry` to the result chunk type (more invasive, changes wire format)
- **(B)** Store classification directly from `buildTerminalError` call sites (simpler)

**Chosen: Option B** — Store the `buildTerminalError` result in the module-scoped variable
at each call site where `emitTerminal` is called with `isError: true`.

### Fix 3: `event-bridge.ts` — Handle JSON-RPC errors inline in `executePrompt()`

Current code (lines 606-608):

```typescript
if ('error' in promptResp) {
  const err = assertJsonRpcError(promptResp.error);
  throw new Error(`ACP session/prompt failed: ${err.message} (code ${err.code})`);
}
```

This throw is caught at line 642-648 where `buildTerminalError` is called WITHOUT
`jsonRpcCode`. Change to inline handling:

```typescript
if ('error' in promptResp) {
  const err = assertJsonRpcError(promptResp.error);
  const { errors, errorSubtype, shouldRetry } = buildTerminalError(
    `ACP session/prompt failed: ${err.message} (code ${err.code})`,
    stderrLines,
    { jsonRpcCode: err.code }
  );
  terminalClassification = {
    errorClass: errorSubtype as HermesErrorClass,
    shouldRetry,
    enrichedMessage: errors[0],
  };
  emitTerminal({ type: 'result', isError: true, errors, errorSubtype });
  queue.push({ kind: 'done' });
  return;
}
```

### Fix 4: `event-bridge.ts` — Throw `HermesClassifiedError` at end of generator

Replace lines 703-708:

```typescript
// Before:
if (terminalErrorMessage) {
  throw new Error(terminalErrorMessage);
}

// After:
if (terminalErrorMessage) {
  throw new HermesClassifiedError(
    terminalErrorMessage,
    terminalClassification ?? {
      errorClass: 'unknown',
      shouldRetry: true,
      enrichedMessage: terminalErrorMessage,
    }
  );
}
```

### Fix 5: `provider.ts` — Use pre-classified error in retry loop

Replace line 203:

```typescript
// Before:
const classified = classifyHermesError(error.message);

// After:
const classified =
  error instanceof HermesClassifiedError
    ? error.classification
    : classifyHermesError(error.message);
```

### Fix 6: `packages/providers/package.json` — Add `--timeout 60000` to hermes test batch

Test 1417 (`enriched error includes errorSubtype on process crash`) legitimately tests
retry-with-backoff for crash errors (`shouldRetry: true`). Even with correct classification,
it needs >14s. Add `--timeout 60000` to the hermes test batch in the test script.

---

## Test Impact Analysis

### With correct classification:

| Test                           | Error                          | Classification | shouldRetry | Behavior                                          |
| ------------------------------ | ------------------------------ | -------------- | ----------- | ------------------------------------------------- |
| 861 (temp HERMES_HOME cleanup) | JSON-RPC code -1               | `protocol`     | **false**   | No retry, immediate throw. <1s                    |
| 1218 (resume failure)          | JSON-RPC code -1 on 2nd prompt | `protocol`     | **false**   | No retry on 2nd call. <1s                         |
| 1417 (process crash)           | Exit code 1                    | `crash`        | **true**    | Retries happen (2+4+8=14s). Needs --timeout 60000 |

### Tests that already pass (no change needed):

- 413 (spawn EACCES) → `permission/shouldRetry:false` — already correct from message string
- 691 (first-event timeout) → `crash/shouldRetry:false` — already correct
- 1294/1326 (prompt timeout) → throws from provider, not bridge
- 1453 (pre-aborted) → checked before attempt
- 1603 (panic retry) → pre-bridge error, correct classification from message
- 1636 (auth error) → `auth/shouldRetry:false` — already correct

### Event-bridge tests (68 tests):

All pass — they use `consume()` which catches thrown errors. The error result chunks
are still yielded before the throw. No behavioral change for these tests.

---

## Files to Modify

| File                  | Change                                                               | Lines affected          |
| --------------------- | -------------------------------------------------------------------- | ----------------------- |
| `error-classifier.ts` | Add `HermesClassifiedError` class                                    | +10 lines after line 14 |
| `event-bridge.ts`     | Store classification, handle JSON-RPC inline, throw classified error | ~30 lines changed       |
| `provider.ts`         | Use `HermesClassifiedError` in retry loop                            | 3 lines at line 203     |
| `package.json`        | Add `--timeout 60000` to hermes test batch                           | 1 line                  |

---

## Verification Steps

```
STEP [1]: cd packages/providers && bun test src/hermes/error-classifier.test.ts --timeout 30000
  Expected: all pass (includes new HermesClassifiedError tests)

STEP [2]: cd packages/providers && bun test src/hermes/concurrency-lock.test.ts --timeout 30000
  Expected: 9 pass (already fixed)

STEP [3]: cd packages/providers && bun test src/hermes/event-bridge.test.ts --timeout 60000
  Expected: 68 pass

STEP [4]: cd packages/providers && bun test src/hermes/provider.test.ts --timeout 60000
  Expected: 49 pass (tests 861, 1218 now complete in <1s; test 1417 in ~14s)

STEP [5]: Full hermes suite
  cd packages/providers && bun test src/hermes/config.test.ts src/hermes/concurrency-lock.test.ts src/hermes/error-classifier.test.ts src/hermes/options-translator.test.ts src/hermes/timeout-utils.test.ts src/hermes/model-ref.test.ts src/hermes/session-pool.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts src/hermes/acp-client.test.ts src/hermes/binary-resolver.test.ts src/hermes/registration.test.ts src/hermes/session-resolver.test.ts src/hermes/hermes-mcp-reader.test.ts --timeout 60000
  Expected: 318 pass

STEP [6]: bun run validate
  Expected: exit 0

STEP [7]: Format and commit
  bun x prettier --write packages/providers/src/hermes/error-classifier.ts packages/providers/src/hermes/event-bridge.ts packages/providers/src/hermes/provider.ts
  git add -A && git commit -m "fix(hermes): propagate error classification from bridge to retry loop"
```

---

## Design Decisions

1. **`HermesClassifiedError` over message encoding** — Type-safe, explicit, no fragile string parsing
2. **Store classification at call sites (Option B)** — Simpler than adding `shouldRetry` to chunk type
3. **Inline JSON-RPC handling** — Eliminates throw-then-catch that loses `jsonRpcCode` context
4. **`--timeout 60000` for test 1417** — Legitimate retry test, not a workaround
5. **Fallback to message-only classification** — Non-bridge errors (verifyHermesBinary panics) still work
