# Hermes Provider — Final Polish Plan (Silent Failures + Deferred + Polish)

> From 2-round verifier audit (6 reports). Items ordered by severity.

## Phase 1: Silent Failures (3 HIGH, source files)

### S1 — Handle JSON-RPC error responses in ACP request phases

**File**: event-bridge.ts
**Issue**: SF-01 confirmed. initialize, session/new, session/prompt all check `'result' in resp` but never `'error' in resp`. Prompt errors emit a "success" result chunk.
**Fix**: After each `await sendRequest(req)`, add error check:

```typescript
if ('error' in initResp) {
  const err = initResp.error as { code: number; message: string };
  throw new Error(`ACP initialize failed: ${err.message} (code ${err.code})`);
}
```

Repeat for session/new and session/prompt.

### S2 — Stdin error handler should reject pending request

**File**: event-bridge.ts (sendRequest)
**Issue**: SF-02 confirmed. `stdin.on('error')` logs at debug but never rejects. User waits 30s for timeout.
**Fix**: In sendRequest, the stdin error handler should reject:

```typescript
childProcess.stdin.on('error', err => {
  getLog().warn({ err }, 'acp.stdin_error');
  reject(new Error(`Hermes ACP stdin error: ${err.message}`));
});
```

### S3 — Prevent stdin error listener accumulation

**File**: event-bridge.ts (sendRequest)
**Issue**: SF-06. Each sendRequest call registers a new stdin.on('error') listener, never removed.
**Fix**: Use `{ once: true }` on the listener, or remove it after the request resolves.

### S4 — First-event timeout: close bridge generator on timeout

**File**: provider.ts / timeout-utils.ts
**Issue**: SF-04. On timeout, generator never explicitly closed. Child process relies on GC for cleanup.
**Fix**: In withFirstEventTimeout, call `gen.return()` in the catch/timeout path. Or in provider.ts, wrap the generator consumption in try/finally that calls `gen.return()`.

## Phase 2: Test Fixes (broken tests + critical gaps)

### T1 — Fix redactSecrets test assertions

**File**: event-bridge.test.ts
**Issue**: Verifier E confirmed tests are syntactically valid (Round 1 claim was wrong), but assertions may not match actual regex behavior. VERIFY each assertion against actual output.

### T2 — Add isSessionUpdateParams dedicated tests

**File**: acp-protocol.test.ts
**Issue**: Exported function has zero dedicated tests.
**Fix**: Add tests for: valid input, missing sessionId, non-string sessionId, missing update, unknown sessionUpdate value, null input.

### T3 — Add classifyHermesError object-style API tests

**File**: error-classifier.test.ts
**Issue**: Object-style context with jsonRpcCode is completely untested.
**Fix**: Add tests for each JSON-RPC error code (-32600, -32601, -32602, -32603, etc.)

### T4 — Strengthen event-bridge error assertions

**File**: event-bridge.test.ts
**Issue**: 3 tests only check isError:true without validating error messages.
**Fix**: Add assertions on errors[] array content for: non-zero exit, crash event, signal termination.

### T5 — Strengthen provider error assertions

**File**: provider.test.ts
**Issue**: Spawn failure test doesn't validate error message.
**Fix**: Assert error message contains expected text.

### T6 — Export and test getFirstEventTimeoutMs

**File**: provider.ts + provider.test.ts
**Issue**: Internal function with cap behavior untested.
**Fix**: Export the function. Add tests for: valid env var, cap at 300000, 0/negative/NaN rejection.

## Phase 3: Polish (imports, JSDoc, constants, comments)

### P1 — Add node: prefix to bare built-in imports (5 files)

**Files**: event-bridge.ts, binary-resolver.ts, session-resolver.ts, config.ts, utils/binary-resolver.ts
**Fix**: `'path'` → `'node:path'`, `'child_process'` → `'node:child_process'`, etc.

### P2 — Add JSDoc to exported symbols without docs

**Files**: multiple (14 symbols identified by Verifier F)
**Fix**: Add JSDoc to: withFirstEventTimeout, redactSecrets, verifyHermesBinary, HermesErrorClass, ClassifiedError, etc.

### P3 — Name magic numbers as constants

**Files**: binary-resolver.ts (5000ms timeout), event-bridge.ts (5000ms SIGKILL delay)
**Fix**: Extract to named constants.

### P4 — Add mcpServers comment

**File**: event-bridge.ts
**Issue**: Sends mcpServers:[] despite capability false. Needs comment explaining why.
**Fix**: Add comment: `// mcpServers: [] — required by ACP session/new schema even though mcp capability is false`

### P5 — Fix misleading "all false" JSDoc in provider.ts

**File**: provider.ts
**Issue**: Comment says "all false" but lists capabilities that may have changed.
**Fix**: Verify against capabilities.ts and update comment.

## Execution Rules

- Max 3 concurrent executors per batch
- ONE file per executor
- Verifier gate between Phase 1 and Phase 2
- Final gate: type-check + 150+ tests + lint 0 warnings
