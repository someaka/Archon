# Verifier 6: Integration & Edge-Case Verification

**Date**: 2026-04-27
**Scope**: IAgentProvider contract, MessageChunk compliance, ACP protocol edge cases,
event-bridge edge cases, config edge cases, session-resolver edge cases,
timeout edge cases
**Verdict**: PASS with minor findings (no blocking issues)

---

## 1. IAgentProvider Contract Compliance

The `IAgentProvider` interface (types.ts:307-332) requires three members:

| Method                                               | HermesProvider                 | ClaudeProvider          | CodexProvider         | PiProvider         |
| ---------------------------------------------------- | ------------------------------ | ----------------------- | --------------------- | ------------------ |
| `sendQuery(prompt, cwd, resumeSessionId?, options?)` | ✅ line 92                     | ✅ line 908             | ✅ line 499           | ✅ line 151        |
| `getType(): string`                                  | ✅ returns `'hermes'` line 65  | ✅ `'claude'` line 1035 | ✅ `'codex'` line 621 | ✅ `'pi'` line 457 |
| `getCapabilities()`                                  | ✅ HERMES_CAPABILITIES line 73 | ✅ CLAUDE_CAPABILITIES  | ✅ CODEX_CAPABILITIES | ✅ PI_CAPABILITIES |

**Verdict**: HermesProvider correctly implements ALL required methods with correct
signatures. The `sendQuery` signature matches `(prompt: string, cwd: string,
resumeSessionId?: string, options?: SendQueryOptions): AsyncGenerator<MessageChunk>`
exactly.

**Differences from other providers** (intentional, not bugs):

- Hermes is stateless (no retry loop in provider.ts; Claude and Codex have built-in
  retry logic). Retry could be added later via the shared `withRetry` utility.
- Hermes does not use `resumeSessionId` (logged and ignored, line 82 of
  session-resolver.ts). This is consistent with `capabilities.sessionResume: false`.
- HermesProvider has no constructor (stateless), unlike ClaudeProvider (checks root UID)
  and CodexProvider (configurable retry delay). This is fine.

**Registration**: `registration.ts` correctly provides all required `ProviderRegistration`
fields: `id: 'hermes'`, `displayName`, `factory`, `capabilities`, `isModelCompatible`,
`builtIn: true`. The `isHermesModelCompatible` always returns `true` — Hermes resolves
models at runtime from its own config. This is documented and intentional.

---

## 2. MessageChunk Compliance

### Chunks produced by the event bridge (event-bridge.ts)

| Chunk type    | Produced?      | Source                               | Required fields                                                         |
| ------------- | -------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `assistant`   | ✅             | session/update → agent_message_chunk | `content: string` ✅                                                    |
| `thinking`    | ✅             | session/update → agent_thought_chunk | `content: string` ✅                                                    |
| `result`      | ✅             | Terminal (success + error paths)     | `type: 'result'` ✅, `sessionId?`, `stopReason?`, `isError?`, `errors?` |
| `system`      | ❌ not emitted | N/A                                  | —                                                                       |
| `tool`        | ❌ not emitted | N/A                                  | —                                                                       |
| `tool_result` | ❌ not emitted | N/A                                  | —                                                                       |
| `rate_limit`  | ❌ not emitted | N/A                                  | —                                                                       |

**Verdict**: All emitted chunks conform to the `MessageChunk` discriminated union
(types.ts:118-162). The required `type` discriminator is always present. Optional fields
(`sessionId`, `stopReason`, `isError`, `errors`) are correctly populated on `result`
chunks.

**Missing chunk types**: Hermes does not emit `system`, `tool`, `tool_result`, or
`rate_limit` chunks. This is acceptable for v1 — the capabilities are all false
(capabilities.ts). Claude and Codex emit these because they support MCP tools, hooks,
etc. When Hermes adds tool support, the bridge should be extended.

**Comparison with Claude/Codex result chunks**:

- Claude result: `{ type: 'result', sessionId?, tokens?, structuredOutput?, isError?, ... }`
- Codex result: `{ type: 'result', sessionId?, tokens?, structuredOutput? }`
- Hermes result: `{ type: 'result', sessionId?, stopReason?, isError?, errors? }`

Hermes does NOT populate `tokens` (TokenUsage) in the result chunk. This is consistent
with ACP not providing token counts in the current protocol version. The field is
optional per the type definition.

---

## 3. Edge Cases in ACP Protocol

### 3.1 Response arrives BEFORE any request is sent

**Scenario**: Hermes sends a JSON-RPC response with an `id` before Archon sends any
request.

**Analysis**: `pendingRequestId` is initialized to `undefined` (line 96). The routing
check at line 135 (`msg.id === pendingRequestId`) evaluates to `msg.id === undefined`,
which is `false` for any numeric id. The response falls through to the notification
check (line 149: `'method' in msg && !('id' in msg)`) — also false since responses have
`id`. The message is silently dropped.

**Verdict**: ✅ HANDLED — unsolicited responses are safely ignored.

### 3.2 Multiple responses for one request

**Scenario**: Hermes sends two responses with the same request id.

**Analysis**: After the first response resolves the pending request (line 135-146),
`requestResolve`, `requestReject`, and `pendingRequestId` are all set to `undefined`.
A second response with the same `id` fails the check `msg.id === pendingRequestId`
(undefined). It's silently dropped.

**Verdict**: ✅ HANDLED — duplicate responses are safely ignored.

### 3.3 session/update notification arrives before session/new response

**Scenario**: Hermes pushes `session/update` notifications before the `session/new`
request is answered.

**Analysis**: The notification handler (lines 149-170) does not check whether
`sessionId` (the local variable) is set. It processes any valid `session/update`
notification and pushes chunks to the queue. This means chunks can accumulate in the
queue before the `session/new` response arrives.

**Impact**: Low. The chunks will be consumed by the consumer loop after all ACP
requests complete. The `sessionId` local variable (for abort/cancel) will be set after
`session/new` completes. If abort fires before `session/new` completes, no
`session/cancel` is sent (line 250: `if (sessionId)` guard) — the process is SIGTERMed
instead.

**Verdict**: ✅ ACCEPTABLE — no crash, data loss, or hang. The ordering is
nondeterministic but correct.

### 3.4 Empty line or binary data on stdout

**Scenario**: Hermes writes an empty line or non-JSON binary data to stdout.

**Analysis**:

- Empty lines: Line 126 (`if (!trimmed) continue;`) skips them. ✅
- Binary / non-JSON: `parseMessage(trimmed)` returns `null` (line 128-132). The
  invalid data is logged at warn level and skipped. ✅
- Extremely long lines: Lines 107-123 enforce `MAX_LINE_BUFFER_LENGTH` (1 MiB). If a
  single line exceeds 1 MiB, the buffer is truncated from the beginning (keeps the
  most recent data). The truncated line likely won't parse as valid JSON and will be
  skipped with a warning.

**Verdict**: ✅ HANDLED — graceful degradation with logging.

### 3.5 Process exits before all requests are sent

**Scenario**: The Hermes process crashes during the ACP handshake (e.g., after
initialize but before session/new).

**Analysis**:

1. `exit` event fires → `rejectPending()` rejects the currently pending `sendRequest`
   promise → `emitTerminal()` emits a terminal result chunk → `queue.push({ kind: 'done' })`
2. The rejected `await sendRequest(...)` throws → catch block at line 402 fires
3. `emitTerminal()` is a no-op (guarded by `terminalEmitted` flag)
4. `queue.push({ kind: 'done' })` adds a second `done` (harmless — consumer exits on
   the first)
5. Consumer loop yields the terminal chunk, then sees `done`, returns.

**Verdict**: ✅ HANDLED — exactly one terminal chunk is emitted, consumer exits
cleanly.

### 3.6 Process exits with code 0 while request is pending

**Scenario**: Process exits cleanly (code 0) while `sendRequest` is still awaiting a
response.

**Analysis**: The exit handler (lines 204-227) does NOT call `rejectPending` or
`emitTerminal` for code 0 / signal null. It only pushes `{ kind: 'done' }`. The
pending `sendRequest` will time out after 30 seconds (`REQUEST_TIMEOUT_MS`). The catch
block then emits terminal + done. Consumer exits.

**Impact**: 30-second delay before the consumer sees the terminal chunk. This is a
degraded experience but not a hang.

**Verdict**: ⚠️ MINOR FINDING — could add `rejectPending` in the exit handler for
code 0 when there's still a pending request, to avoid the 30-second timeout delay.

---

## 4. Edge Cases in Event Bridge

### 4.1 abortSignal already aborted when bridgeHermesSession is called

**Scenario**: `options.abortSignal.aborted === true` at call time.

**Analysis** (lines 291-297):

1. `onAbort()` is called synchronously.
2. `sessionId` is undefined → `session/cancel` is NOT sent.
3. `childProcess.kill('SIGTERM')` is called — process is terminated.
4. `rejectPending()` — no pending request, no-op.
5. `emitTerminal({ type: 'result', isError: true, errors: ['Query was aborted'] })`.
6. `queue.close()` — queue is closed.

Then the generator continues to the ACP request block (lines 332-410): 7. `sendRequest(initReq)` — attempts to write to stdin of a killed process. This may
fail (EPIPE/broken pipe). The `childProcess.stdin.write()` might emit an error on
the stdin stream. The request will eventually time out (30s) or reject.

**Impact**: The consumer sees the terminal chunk quickly (from step 5), then `done`
(from step 6 or from the catch block). However, there's a theoretical 30-second delay
if `sendRequest` hangs waiting for a response from the dead process.

**Verdict**: ⚠️ MINOR FINDING — after `queue.close()` in `onAbort()`, the ACP request
block still runs unnecessarily. The generator could check an `aborted` flag before
sending requests. In practice, the SIGTERM/SIGKILL ensures the process dies, and
stdin writes to a dead pipe fail quickly.

### 4.2 childProcess.stdin is null (pipe closed)

**Scenario**: stdin is null when `sendRequest` tries to write.

**Analysis** (line 307-309): `if (!childProcess.stdin) { reject(new Error('...')); return; }`.
This is checked inside the Promise constructor. The promise rejects immediately.

**Verdict**: ✅ HANDLED — clear error message.

### 4.3 stdout emits data after the process has exited

**Scenario**: Node.js delivers buffered stdout data after the `exit` event.

**Analysis**: The stdout `data` handler (line 105) processes any data it receives
regardless of process state. Parsed messages are queued normally. The exit handler
fires AFTER all buffered data is delivered (Node.js guarantees this for piped stdio
on normal exit). For SIGKILL, buffered data may be lost — but this is a platform
limitation, not a code issue.

**Verdict**: ✅ HANDLED — no special action needed.

### 4.4 Queue closed before all items are consumed

**Scenario**: `queue.close()` is called while items are still in the buffer.

**Analysis**: `AsyncQueue.close()` (async-queue.ts:38-45) sets `this.closed = true`
and drains pending waiters, but does NOT clear the buffer. The `iterate()` generator
(line 57-71) checks `this.closed` only when the buffer is empty. So buffered items are
still yielded to the consumer.

**Verdict**: ✅ HANDLED — close() is non-destructive to buffered items.

### 4.5 Stdin EPIPE error without handler

**Scenario**: Writing to stdin fails with EPIPE after the child process dies.

**Analysis**: `childProcess.stdin.write(data)` does not throw synchronously on EPIPE.
It emits an `error` event on the stdin stream. The event bridge does NOT register an
error handler on stdin. If no handler is registered, Node.js throws an unhandled
error, potentially crashing the parent process.

However, in practice:

1. The exit handler fires first (child is dead), which rejects the pending request
   and emits terminal.
2. The `finally` block kills the process with SIGKILL.
3. The stdin error might fire after the generator has returned.

**Verdict**: ⚠️ LOW-SEVERITY FINDING — adding `childProcess.stdin?.on('error', () => {})`
would prevent potential unhandled error crashes. The risk is low because the exit
handler handles the situation first, and SIGKILL in `finally` prevents further I/O.

---

## 5. Config Edge Cases

### 5.1 parseHermesConfig receives non-object input

**Scenario**: `parseHermesConfig` is called with null, undefined, or a primitive.

**Analysis**: The function signature requires `Record<string, unknown>`. The caller
(provider.ts:99) always passes `options?.assistantConfig ?? {}`, which is always an
object. TypeScript enforces the type at compile time. At runtime, if a non-object were
passed, accessing `raw.model` etc. would throw a TypeError.

**Verdict**: ✅ SAFE — caller guarantees object input. TypeScript provides compile-time
safety.

### 5.2 resolveHermesModel returns null — does provider.ts handle it?

**Scenario**: No model is configured and no modelRef is provided.

**Analysis**: `resolveHermesModel` (options-translator.ts:19-41) returns `null` when
no model is resolvable. However, `provider.ts` does NOT call `resolveHermesModel` at
all. The spawn command is `spawn(hermesBinary, ['acp'], ...)` — no model is passed.
Hermes CLI resolves the model from its own config (`~/.hermes/config.yaml`). The
`resolveHermesModel` function is used by options-translator for model compatibility
checking, not by the provider for CLI invocation.

**Verdict**: ✅ NOT APPLICABLE — model resolution is Hermes CLI's responsibility, not
the provider's. If Hermes CLI has no model configured, it will error on its own.

### 5.3 HERMES_BINARY_PATH points to a non-executable file

**Scenario**: The env var points to a file that exists but isn't executable.

**Analysis**: `resolveHermesBinary` (binary-resolver.ts:60-81) calls the shared
`resolveBinaryPath`, which checks `fileExists()` (existence only, not executability).
The file would pass the existence check. Then `verifyHermesBinary` (line 43-51) runs
`execFileAsync(binary, ['--version'])`. If the file isn't executable, `execFile` fails
with EACCES. `verifyHermesBinary` returns `false`. Provider.ts:113-117 throws a clear
error with install instructions.

**Verdict**: ✅ HANDLED — the two-phase resolution (existence check + verification)
catches non-executable files.

---

## 6. Session Resolver Edge Cases

### 6.1 cwd is a symlink

**Scenario**: The `cwd` parameter is a symlink to a directory.

**Analysis**: `statSync(cwd)` (session-resolver.ts:54) follows symlinks by default
(`lstatSync` would not). So `stats.isDirectory()` checks the symlink target. If the
target is a directory, validation passes. If the target doesn't exist, ENOENT is thrown.

**Verdict**: ✅ CORRECT — symlinks to directories are valid working directories.

### 6.2 cwd permissions change between validation and use

**Scenario**: The directory is accessible during `statSync` but becomes inaccessible
before `spawn()`.

**Analysis**: This is a TOCTOU (time-of-check-time-of-use) race condition. The
`spawn()` call would fail with EACCES. The error would be caught by the `childProcess`
`error` event handler in event-bridge.ts (line 230), which emits a terminal error chunk.

**Verdict**: ✅ ACCEPTABLE — inherent to the design; error is caught downstream. All
providers face this race condition.

### 6.3 env contains keys with empty string values

**Scenario**: `options.env` has `{ FOO: '' }`.

**Analysis**: The session-resolver (lines 72-78) checks `typeof value === 'string'`.
`typeof '' === 'string'` is `true`, so empty string values are included in the merged
environment. This is correct — empty string env vars are valid in POSIX
(e.g., `FOO=""` is different from unsetting FOO).

**Verdict**: ✅ CORRECT — empty string values are preserved.

---

## 7. Timeout Edge Cases

### 7.1 First event arrives exactly at the timeout boundary

**Scenario**: The timer and the first queue item resolve in the same event loop tick.

**Analysis**: `withFirstEventTimeout` (timeout-utils.ts) uses `Promise.race` between
`gen.next()` and a setTimeout-based timer. When both resolve in the same tick, the
winner is determined by microtask/macrotask ordering. The timer is a macrotask
(setTimeout), and `gen.next()` resolution depends on the queue's waiter mechanism
(microtask via `resolve`). In practice, the microtask (gen.next()) wins because
Promise resolution is processed before setTimeout callbacks. This means the first
event is yielded even if it arrives "at" the timeout boundary.

**Verdict**: ✅ ACCEPTABLE — the microtask ordering means first events at the boundary
are not lost. This is consistent behavior, not a bug.

### 7.2 ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS set to 0

**Scenario**: `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '0'`.

**Analysis** (provider.ts:22-38): `Number('0')` = 0, `Number.isFinite(0)` = true,
`0 > 0` = false. The condition `parsed > 0` fails, so the function falls through to
`return 60_000`.

**Verdict**: ✅ HANDLED — value 0 is treated as invalid, falls back to 60s default.

### 7.3 ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS set to negative

**Scenario**: `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '-5000'`.

**Analysis**: `Number('-5000')` = -5000, `Number.isFinite(-5000)` = true, `-5000 > 0`
= false. Falls through to default 60s.

**Verdict**: ✅ HANDLED — negative values are rejected.

### 7.4 ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS set to NaN

**Scenario**: `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = 'abc'`.

**Analysis**: `Number('abc')` = NaN, `Number.isFinite(NaN)` = false. Falls through to
default 60s.

**Verdict**: ✅ HANDLED — non-numeric values are rejected.

### 7.5 ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS exceeds MAX_TIMEOUT_MS

**Scenario**: `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '999999'`.

**Analysis** (provider.ts:27-33): The value is capped at `MAX_TIMEOUT_MS` (300,000ms
= 5 minutes). A warning is logged with the requested and capped values.

**Verdict**: ✅ HANDLED — excessively large values are capped with a warning.

### 7.6 Timer leak in withFirstEventTimeout on gen.next() rejection

**Scenario**: The wrapped generator throws on its first `.next()` call (e.g., cwd
validation failure in bridgeHermesSession).

**Analysis**: In `withFirstEventTimeout` (timeout-utils.ts:15), `Promise.race([gen.next(), timer])`
rejects when `gen.next()` rejects. The `await` throws. The while loop exits. The
`clearTimeout(timerHandle)` at line 17-20 is AFTER the await, so it's never reached.
The setTimeout timer leaks — it will fire after `timeoutMs` and try to reject the
`timer` promise, but since `Promise.race` already settled, the rejection is a no-op.

**Verdict**: ⚠️ VERY LOW SEVERITY — the timer leaks for `timeoutMs` duration (default
60s) but has no functional impact. The leaked timer's rejection is silently ignored.
Fix: wrap the first `await` in try/finally to always clear the timer.

---

## 8. Additional Findings

### 8.1 Double `done` signals in queue

In the success path, `queue.push({ kind: 'done' })` is called at line 401 (after ACP
requests complete) and potentially again in the exit handler (line 226). The consumer
exits on the first `done` and never sees the second. The `finally` block closes the
queue, making subsequent pushes no-ops.

**Verdict**: ✅ HARMLESS — consumer exits cleanly on first `done`.

### 8.2 ACP ID generator wraparound

`createAcpIdGenerator` (acp-protocol.ts:52-61) increments IDs and wraps at
`Number.MAX_SAFE_INTEGER` (2^53 - 1). Each session uses ~3 IDs. A session would need
~3 quadrillion requests before wraparound. Not a practical concern.

**Verdict**: ✅ NOT A CONCERN.

### 8.3 Secret redaction in stderr

`redactSecrets` (event-bridge.ts:29-33) redacts common secret patterns in stderr
output before logging. The regex covers `key`, `token`, `api_key`, `password`,
`secret`, `auth` in both `key=value` and `"key": "value"` formats.

**Verdict**: ✅ GOOD PRACTICE — reasonable redaction for stderr logging.

### 8.4 No retry logic in HermesProvider

Unlike ClaudeProvider (3 retries with exponential backoff) and CodexProvider (3 retries),
HermesProvider has no retry logic. The shared `withRetry` utility (retry-loop.ts) is
available but not used. This is a v1 intentional gap, not a bug.

**Verdict**: ⚠️ DESIGN NOTE — retry logic should be added before production use.
The `classifyHermesError` function (error-classifier.ts) exists and provides
`shouldRetry` flags, ready for integration with `withRetry`.

### 8.5 HermesProvider errors are thrown, not yielded as chunks

When `verifyHermesBinary` fails (provider.ts:113-117), the error is thrown directly.
The consumer (dag-executor) must catch this. Claude and Codex providers also throw on
fatal errors, so this is consistent.

**Verdict**: ✅ CONSISTENT with other providers.

---

## Summary of Findings

| #   | Severity    | Finding                                                            | File             | Line(s)          |
| --- | ----------- | ------------------------------------------------------------------ | ---------------- | ---------------- |
| 1   | ⚠️ Minor    | Process exit with code 0 while request pending → 30s timeout delay | event-bridge.ts  | 204-227          |
| 2   | ⚠️ Low      | ACP requests run after abortSignal fires and queue is closed       | event-bridge.ts  | 291-297, 332-410 |
| 3   | ⚠️ Low      | No error handler on childProcess.stdin (EPIPE risk)                | event-bridge.ts  | 307-317          |
| 4   | ⚠️ Very Low | Timer leak in withFirstEventTimeout when gen.next() rejects        | timeout-utils.ts | 15-20            |
| 5   | ℹ️ Note     | No retry logic in HermesProvider (withRetry utility available)     | provider.ts      | —                |
| 6   | ℹ️ Note     | No token usage in result chunks (ACP limitation)                   | event-bridge.ts  | 396-400          |

**No blocking issues found.** The Hermes provider implementation is solid, with
correct IAgentProvider contract compliance, valid MessageChunk shapes, and robust
edge-case handling in the ACP protocol, event bridge, config parser, session resolver,
and timeout utilities. The minor findings are improvements, not correctness bugs.
