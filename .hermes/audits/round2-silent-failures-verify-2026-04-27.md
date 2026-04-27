# Round 2: Silent Failure Verification Report

**Date**: 2026-04-27
**Verifier**: Verifier D
**Method**: Line-by-line source code verification against actual current source
**Files examined**:

- `packages/providers/src/hermes/event-bridge.ts` (458 lines)
- `packages/providers/src/hermes/provider.ts` (156 lines)
- `packages/providers/src/hermes/timeout-utils.ts` (29 lines)

---

## Verification Results

### SF-01: JSON-RPC error responses silently swallowed — CONFIRMED

**Claim**: All three ACP request phases check `'result' in resp` but never check `'error' in resp`.

**Evidence from event-bridge.ts**:

**Initialize (lines 361-372)**:

```typescript
const initResp = await sendRequest(initReq);
if (
  'result' in initResp &&
  typeof (initResp.result as Record<string, unknown>).protocolVersion === 'number'
) {
  // ... protocol version check
}
```

If `initResp` contains `{ error: { code: -32600, message: "..." } }`, the `'result' in initResp` check is false. The protocol version check is silently skipped. Execution continues to `session/new` as if initialization succeeded. **No error check exists.**

**session/new (lines 383-392)**:

```typescript
const sessionResp = await sendRequest(sessionReq);
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

If `sessionResp` contains an error, `sessionId` stays `undefined`. The code throws `'Hermes ACP did not return a valid sessionId'` — a generic message that hides the actual server error. **The real error is discarded.**

**session/prompt (lines 410-421)**:

```typescript
const promptResp = await sendRequest(promptReq);
const stopReason =
  'result' in promptResp
    ? ((promptResp.result as Record<string, unknown>).stopReason as string | undefined)
    : undefined;
emitTerminal({
  type: 'result',
  sessionId,
  stopReason,
});
queue.push({ kind: 'done' });
```

If `promptResp` contains an error, `stopReason` is `undefined`. `emitTerminal` is called with `{ type: 'result', sessionId, stopReason: undefined }` — **no `isError: true` flag**. The consumer sees a successful completion with no content and no error. **This is a completely silent failure.**

**Verdict**: CONFIRMED. All three phases silently swallow JSON-RPC errors. The prompt phase is the worst: it emits a "successful" result with no error indication.

**Fix**: Add `'error' in resp` checks after each `await sendRequest(...)` call:

```typescript
// After line 361 (initialize):
if ('error' in initResp) {
  const err = initResp.error as { code: number; message: string };
  throw new Error(`Hermes ACP initialize failed (code ${err.code}): ${err.message}`);
}

// After line 383 (session/new):
if ('error' in sessionResp) {
  const err = sessionResp.error as { code: number; message: string };
  throw new Error(`Hermes ACP session/new failed (code ${err.code}): ${err.message}`);
}

// After line 410 (session/prompt):
if ('error' in promptResp) {
  const err = promptResp.error as { code: number; message: string };
  emitTerminal({
    type: 'result',
    isError: true,
    errors: [`Hermes ACP session/prompt failed (code ${err.code}): ${err.message}`],
  });
  queue.push({ kind: 'done' });
} else {
  // existing stopReason + emitTerminal logic
}
```

---

### SF-02: Stdin 'error' handler doesn't reject pending request — CONFIRMED

**Claim**: In `sendRequest()`, the stdin error handler only logs and doesn't reject the pending request.

**Evidence from event-bridge.ts lines 323-325**:

```typescript
childProcess.stdin.on('error', err => {
  getLog().debug({ err }, 'acp.stdin_error');
});
```

The handler logs at `debug` level only. It does NOT call `requestReject(err)`. The pending request remains unresolved until the 30-second timeout (`REQUEST_TIMEOUT_MS`) fires with a generic "timed out" message.

**Verdict**: CONFIRMED. The stdin error is invisible to the user. The only resolution is the 30-second timeout, which hides the real cause.

**Fix**: Reject the pending request on stdin error:

```typescript
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

### SF-06: sendRequest accumulates stdin error listeners — CONFIRMED

**Claim**: Each call to `sendRequest()` adds a new `stdin.on('error', ...)` listener that is never removed.

**Evidence from event-bridge.ts**:

`sendRequest()` is defined at lines 313-345. Inside, at line 323:

```typescript
childProcess.stdin.on('error', err => {
  getLog().debug({ err }, 'acp.stdin_error');
});
```

`sendRequest()` is called 3 times:

- Line 361: `const initResp = await sendRequest(initReq);`
- Line 383: `const sessionResp = await sendRequest(sessionReq);`
- Line 410: `const promptResp = await sendRequest(promptReq);`

Each call registers a new listener. No listener removal occurs between calls. After all 3 calls, 3 identical `error` listeners are registered on `childProcess.stdin`.

**Verdict**: CONFIRMED. Listener leak. With 3 calls, 3 listeners accumulate. Below Node's default 10-listener warning threshold, but a pattern that would break if the protocol added more requests.

**Fix**: Register the stdin error listener once, before the request loop (outside `sendRequest`):

```typescript
// Register once, before the try block at line 347:
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

### SF-04: First-event timeout zombie processes — CONFIRMED (mitigated by unref)

**Claim**: When `withFirstEventTimeout` fires, the `bridgeHermesSession` generator is never explicitly closed, so its `finally` block (which sends SIGKILL) may never run.

**Evidence from timeout-utils.ts lines 1-29**:

```typescript
export async function* withFirstEventTimeout<T>(
  gen: AsyncGenerator<T>,
  timeoutMs: number,
  context: string
): AsyncGenerator<T> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new Error(`Hermes subprocess produced no output within ${timeoutMs}ms (${context})`));
    }, timeoutMs);
  });

  let first = true;
  while (true) {
    let result;
    try {
      result = first ? await Promise.race([gen.next(), timer]) : await gen.next();
    } finally {
      if (first && timerHandle !== undefined) {
        clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    }

    if (result.done) return;
    first = false;
    yield result.value;
  }
}
```

When the timer fires (line 8-9), it rejects. The `Promise.race` at line 17 resolves with this rejection. The error propagates out of `withFirstEventTimeout`. The `gen` parameter (which is `bridgeHermesSession`) is never closed with `.return()`.

**Evidence from provider.ts lines 136-154**:

```typescript
try {
  yield* withFirstEventTimeout(
    bridgeHermesSession(child, {...}, options?.abortSignal),
    getFirstEventTimeoutMs(),
    `hermes acp cwd=${session.cwd}`
  );
  getLog().debug('hermes.query_completed');
} catch (err) {
  getLog().error({ err }, 'hermes.query_failed');
  throw err;
}
```

When `withFirstEventTimeout` throws, the catch block logs and rethrows. The `bridgeHermesSession` generator is never explicitly closed.

**Evidence from event-bridge.ts lines 440-457** (finally block):

```typescript
} finally {
  queue.close();
  if (abortSignal) {
    abortSignal.removeEventListener('abort', onAbort);
  }
  if (sigkillTimeout) {
    clearTimeout(sigkillTimeout);
  }
  try {
    childProcess.kill('SIGKILL');
  } catch {
    // Process may already be gone — this is defensive.
  }
}
```

This `finally` block only runs when the generator is garbage collected or explicitly closed. Without an explicit `.return()` call, the child process may linger.

**Mitigating factor**: `childProcess.unref()` is called at line 84 of event-bridge.ts, which prevents the child process from keeping the Node.js process alive. So the zombie won't prevent Node from exiting, but the child process will linger until GC triggers the finally block.

**Verdict**: CONFIRMED. The child process is abandoned on timeout. Mitigated by `unref()` (won't keep Node alive), but the child process will linger until GC. In long-running server scenarios, this could accumulate zombie processes.

**Fix**: In provider.ts, explicitly close the bridge generator on error:

```typescript
const bridge = bridgeHermesSession(
  child,
  {
    prompt,
    cwd: session.cwd,
    systemPrompt: options?.systemPrompt,
  },
  options?.abortSignal
);
try {
  yield * withFirstEventTimeout(bridge, getFirstEventTimeoutMs(), `hermes acp cwd=${session.cwd}`);
  getLog().debug('hermes.query_completed');
} catch (err) {
  await bridge.return(undefined); // Explicitly close to trigger finally block
  getLog().error({ err }, 'hermes.query_failed');
  throw err;
}
```

---

## Summary

| Claim                              | Verdict               | Severity | Lines                                      |
| ---------------------------------- | --------------------- | -------- | ------------------------------------------ |
| SF-01: JSON-RPC errors swallowed   | CONFIRMED             | HIGH     | event-bridge.ts:361-421                    |
| SF-02: Stdin error doesn't reject  | CONFIRMED             | HIGH     | event-bridge.ts:323-325                    |
| SF-06: Stdin listener accumulation | CONFIRMED             | LOW      | event-bridge.ts:323 (x3 calls)             |
| SF-04: Timeout zombie processes    | CONFIRMED (mitigated) | MEDIUM   | timeout-utils.ts:1-29, provider.ts:136-154 |

**All 4 claims verified as accurate against the current source code.**

The most critical finding is SF-01: the session/prompt phase silently emits a "successful" result when the server returns an error. This is a production-bug-class silent failure that would cause users to see empty responses with no error indication.

---

## Files Referenced

- `/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/event-bridge.ts` (458 lines)
- `/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/provider.ts` (156 lines)
- `/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/timeout-utils.ts` (29 lines)
- `/home/d/Desktop/Archon-canonical/.hermes/audits/round1-silent-failures-2026-04-27.md` (Round 1 report)

## Files Created

- `/home/d/Desktop/Archon-canonical/.hermes/audits/round2-silent-failures-verify-2026-04-27.md` (this report)
