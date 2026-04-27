# Hermes Provider Silent Failures Audit

**Date**: 2026-04-27  
**Scope**: All source and test files in `packages/providers/src/hermes/` + `packages/providers/src/utils/`  
**Auditor**: Verifier A (automated)

---

## Summary

**10 findings** across 7 files. 3 HIGH, 3 MEDIUM, 4 LOW.

The most critical class of silent failure is **JSON-RPC error responses being swallowed** in the ACP bridge — when Hermes returns an error response to any of the three sequential requests (initialize, session/new, session/prompt), the error code and message are discarded and replaced with generic misleading messages.

---

### [SF-01] JSON-RPC error responses silently swallowed in all three ACP request phases

**File**: `event-bridge.ts:362-421`  
**Issue**: `sendRequest()` resolves with the raw `JsonRpcMessage`. All three callers check `'result' in resp` but never check `'error' in resp`. When Hermes returns a JSON-RPC error response, the error object is silently ignored.

Specific impacts per phase:

- **initialize** (line 362): If Hermes returns an error (e.g., unsupported protocol, method not found), `'result' in initResp` is false. The protocol version check is skipped entirely. The bridge continues to `session/new` as if initialization succeeded. The user gets a confusing downstream error instead of "initialization failed: {actual error}".

- **session/new** (line 384): If Hermes returns an error, `'result' in sessionResp` is false, so `sessionId` stays `undefined`. The bridge throws `"Hermes ACP did not return a valid sessionId"` — a misleading message that hides the actual server error (e.g., "session limit reached", "authentication required").

- **session/prompt** (line 413-421): If Hermes returns an error, `'result' in promptResp` is false, so `stopReason` is `undefined`. `emitTerminal` emits a result chunk with `type: 'result'` and NO `isError: true` flag. **The consumer sees a successful completion with no content and no error.** This is the worst case — a completely silent failure.

**Impact**: User sees either a confusing generic error, or (for prompt errors) a "successful" empty response with no indication that anything went wrong.  
**Fix**:

```typescript
// In sendRequest, after each await sendRequest(...):
// For initialize:
const initResp = await sendRequest(initReq);
if ('error' in initResp) {
  const err = initResp.error as { code: number; message: string };
  throw new Error(`Hermes ACP initialize failed (code ${err.code}): ${err.message}`);
}
// (keep existing result check)

// For session/new:
const sessionResp = await sendRequest(sessionReq);
if ('error' in sessionResp) {
  const err = sessionResp.error as { code: number; message: string };
  throw new Error(`Hermes ACP session/new failed (code ${err.code}): ${err.message}`);
}
// (keep existing result check)

// For session/prompt:
const promptResp = await sendRequest(promptReq);
if ('error' in promptResp) {
  const err = promptResp.error as { code: number; message: string };
  emitTerminal({
    type: 'result',
    isError: true,
    errors: [`Hermes ACP session/prompt failed (code ${err.code}): ${err.message}`],
  });
  queue.push({ kind: 'done' });
  // skip the normal terminal emit
} else {
  // existing stopReason + emitTerminal logic
}
```

---

### [SF-02] Stdin 'error' event doesn't reject the pending request — causes 30s hang

**File**: `event-bridge.ts:323-325`  
**Issue**: In `sendRequest()`, the stdin error handler only logs:

```typescript
childProcess.stdin.on('error', err => {
  getLog().debug({ err }, 'acp.stdin_error');
});
```

When stdin emits an error (e.g., EPIPE when the child process closes its stdin), the pending request is never rejected. The only resolution is the 30-second timeout (`REQUEST_TIMEOUT_MS`), which fires with a generic "timed out" message that hides the real cause.

**Impact**: On any stdin write error, the user waits 30 seconds before seeing a timeout error. The actual stdin error (EPIPE, ECONNRESET, etc.) is only at debug level and invisible to the user.  
**Fix**:

```typescript
childProcess.stdin.on('error', err => {
  getLog().warn({ err }, 'acp.stdin_error');
  // Reject the pending request so it doesn't hang for 30s
  if (requestReject) {
    requestReject(new Error(`Hermes ACP stdin error: ${err.message}`));
    requestReject = undefined;
    requestResolve = undefined;
    pendingRequestId = undefined;
  }
});
```

---

### [SF-03] Line buffer truncation discards existing buffered data silently

**File**: `event-bridge.ts:109-119`  
**Issue**: When the incoming data would overflow `MAX_LINE_BUFFER_LENGTH`, the code takes the **last N bytes** of the incoming data and discards the beginning:

```typescript
if (lineBuffer.length + incoming.length > MAX_LINE_BUFFER_LENGTH) {
  const remaining = Math.max(0, MAX_LINE_BUFFER_LENGTH - lineBuffer.length);
  if (remaining > 0) {
    lineBuffer += incoming.slice(-remaining); // appends end of incoming, loses beginning
  } else {
    lineBuffer = incoming.slice(-MAX_LINE_BUFFER_LENGTH); // REPLACES entire buffer
  }
}
```

When `remaining === 0` (buffer already full), the entire `lineBuffer` is replaced with the last 1 MiB of the new incoming data. Any incomplete JSON line from the previous buffer is silently lost. Even when `remaining > 0`, the beginning of `incoming` that would have connected the existing partial line with the rest is discarded, breaking the JSON across the boundary.

**Impact**: Under high throughput (e.g., massive tool output), valid session/update notifications are silently lost. The user gets a partial response with no indication that data was dropped.  
**Fix**: Process existing buffered lines before truncating, or emit an explicit error chunk when truncation occurs:

```typescript
if (lineBuffer.length + incoming.length > MAX_LINE_BUFFER_LENGTH) {
  // Process any complete lines we already have before discarding
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseMessage(trimmed);
    if (msg) {
      /* route msg as usual */
    }
  }
  // Then truncate incoming to fit
  const remaining = Math.max(0, MAX_LINE_BUFFER_LENGTH - lineBuffer.length);
  lineBuffer += incoming.slice(0, remaining);
  getLog().warn('acp.line_buffer_truncated');
}
```

---

### [SF-04] First-event timeout abandons child process — potential zombie

**File**: `timeout-utils.ts:1-29`, `provider.ts:136-149`  
**Issue**: When `withFirstEventTimeout` fires (the child process produces no output within the timeout), it throws. This propagates out of `provider.ts sendQuery()` via the `catch` block. However, the `bridgeHermesSession` async generator is **never explicitly closed** (no `.return()` call). Its `finally` block — which sends SIGKILL to the child process — relies on the JavaScript runtime calling `.return()` during garbage collection. In V8/Bun, this is non-deterministic and may never happen.

The event handlers on the child process (exit, error) keep references to the queue and local variables, preventing GC of the generator's closure. But without the `finally` block running, `childProcess.kill('SIGKILL')` never executes.

**Impact**: On first-event timeout, the child `hermes acp` process may continue running as a zombie, consuming CPU and memory. The user sees a timeout error but has no indication that the subprocess is still alive.  
**Fix**: In `provider.ts sendQuery()`, ensure the bridge generator is closed on error:

```typescript
const bridge = bridgeHermesSession(child, { prompt, cwd: session.cwd, ... }, options?.abortSignal);
try {
  yield* withFirstEventTimeout(bridge, getFirstEventTimeoutMs(), `hermes acp cwd=${session.cwd}`);
  getLog().debug('hermes.query_completed');
} catch (err) {
  // Explicitly close the bridge generator to trigger its finally block
  await bridge.return(undefined);
  getLog().error({ err }, 'hermes.query_failed');
  throw err;
}
```

---

### [SF-05] Malformed endpoint URL silently dropped with no logging

**File**: `config.ts:29-36`  
**Issue**: When the user configures a malformed endpoint URL, the `new URL()` validation catches the error and silently drops the endpoint:

```typescript
try {
  new URL(raw.endpoint);
  result.endpoint = raw.endpoint;
} catch {
  // Malformed URL — drop silently, don't throw.
}
```

No logging, no warning. The user configures `endpoint: "htp://typo:11434"` and gets no feedback that their config was ignored.

**Impact**: User configures an endpoint, it's silently ignored, Hermes falls back to its default endpoint. The user thinks they're hitting their configured server but they're not.  
**Fix**:

```typescript
try {
  new URL(raw.endpoint);
  result.endpoint = raw.endpoint;
} catch {
  getLog().warn({ endpoint: raw.endpoint }, 'hermes.config.malformed_endpoint_dropped');
}
```

(Requires adding a lazy logger to config.ts.)

---

### [SF-06] sendRequest accumulates stdin error listeners (minor leak)

**File**: `event-bridge.ts:323-325`  
**Issue**: Each call to `sendRequest()` adds a new `stdin.on('error', ...)` listener that is never removed. With 3 sequential calls (initialize, session/new, session/prompt), 3 listeners accumulate. While below Node's default 10-listener warning threshold, this is a pattern that would become a problem if the protocol added more requests.

**Impact**: Minor memory leak. With the current 3-request protocol, no user-visible impact. Would become a Node MaxListeners warning if the protocol is extended.  
**Fix**: Register the stdin error listener once (before the request loop) or use `once`:

```typescript
// Register once before the try block:
childProcess.stdin.on('error', err => {
  getLog().warn({ err }, 'acp.stdin_error');
  if (requestReject) {
    requestReject(new Error(`Hermes ACP stdin error: ${err.message}`));
    requestReject = undefined;
    requestResolve = undefined;
    pendingRequestId = undefined;
  }
});
```

---

### [SF-07] redactSecrets test asserts NO redaction for JSON api_key

**File**: `event-bridge.test.ts:509-511`  
**Issue**: The test asserts that `redactSecrets('{"api_key": "***"}')` equals `'{"api_key": "***"}'` — i.e., the api_key is NOT redacted. But the function's regex `/"(key|token|api_key|...)"\s*:\s*"[^"]*/gi` SHOULD match and redact it. Either:

- The test documents a known bug (JSON values aren't redacted)
- The test expectations are wrong

Additionally, lines 513-518 appear to have syntax errors (unclosed string literals), which may cause the entire `redactSecrets` describe block to fail to parse.

**Impact**: If the regex doesn't work for JSON format, API keys in JSON-formatted log lines are exposed in stderr captures.  
**Fix**: Verify the regex matches JSON format. Update test expectations to reflect correct redaction behavior. Fix syntax errors at lines 513-518.

---

### [SF-08] getFirstEventTimeoutMs() not directly tested — MAX_TIMEOUT_MS cap untested

**File**: `provider.ts:22-38`  
**Issue**: `getFirstEventTimeoutMs()` is not exported and has no direct unit tests. The following paths are untested:

- `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` set to a value > 300000 (cap behavior)
- `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` set to a negative number
- `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` set to `NaN`, `Infinity`, `"abc"`
- The warning log when capping

**Impact**: The capping logic at line 27-33 could silently break without detection.  
**Fix**: Export `getFirstEventTimeoutMs` for testing, or test it indirectly by setting `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` in provider tests and verifying behavior.

---

### [SF-09] Spawn failure test doesn't validate error message content

**File**: `provider.test.ts:283-304`  
**Issue**: The spawn failure test only checks `isError: true` on the result chunk:

```typescript
expect(resultChunks[0]).toMatchObject({ type: 'result', isError: true });
```

It does not validate the `errors` array content. The actual error message (`"Failed to run Hermes ACP: spawn EACCES"`) is never asserted.

**Impact**: A regression that changes the error message (e.g., to an empty string) would pass the test.  
**Fix**:

```typescript
expect(resultChunks[0]).toMatchObject({
  type: 'result',
  isError: true,
  errors: [expect.stringContaining('spawn EACCES')],
});
```

---

### [SF-10] error-classifier tests don't validate enrichedMessage content

**File**: `error-classifier.test.ts` (entire file)  
**Issue**: Every test in `error-classifier.test.ts` only checks `errorClass` and `shouldRetry`. No test validates `enrichedMessage`. The enriched message format (e.g., `"Rate limit or timeout detected: ..."`) is never asserted.

Additionally, the JSON-RPC error code classification paths (lines 61-83 in `error-classifier.ts`) are completely untested — no test passes `jsonRpcCode` in the context object.

**Impact**: A regression in enriched message formatting or JSON-RPC code classification would pass all tests.  
**Fix**: Add assertions for `enrichedMessage` and add tests for JSON-RPC error codes:

```typescript
test('classifies JSON-RPC parse error as protocol', () => {
  const result = classifyHermesError('Parse error', { jsonRpcCode: -32700 });
  expect(result.errorClass).toBe('protocol');
  expect(result.shouldRetry).toBe(false);
  expect(result.enrichedMessage).toContain('-32700');
});

test('classifies JSON-RPC internal error as crash', () => {
  const result = classifyHermesError('Internal error', { jsonRpcCode: -32603 });
  expect(result.errorClass).toBe('crash');
  expect(result.enrichedMessage).toContain('-32603');
});
```

---

## Cross-cutting observations

1. **Consistent pattern**: All `catch` blocks in production code either rethrow or log-and-rethrow (good). The only catch blocks that swallow errors are in `config.ts` (intentional by design comment), `binary-resolver.ts` verifyHermesBinary (returns boolean), and the SIGTERM/SIGKILL kill calls (expected).

2. **No validation of ACP responses for error field**: This is the single most impactful class of silent failure. The bridge constructs three sequential ACP requests and checks only for `'result' in resp`, never `'error' in resp`. This means any server-side error is silently ignored at the protocol level.

3. **Resource cleanup on timeout**: The async generator cleanup pattern is a known JavaScript footgun. The `withFirstEventTimeout` wrapper throws but doesn't close the inner generator. Explicit `.return()` calls are needed in catch blocks.

4. **Test gaps cluster around error messages**: Tests consistently check boolean flags (`isError: true`) but not the actual error message strings. This makes it possible for error messages to regress to empty or misleading strings without test failures.
