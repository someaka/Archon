# Hermes Provider Security & Robustness Audit

**Date:** 2026-04-27  
**Scope:** `packages/providers/src/hermes/*.ts` (acp-protocol, event-bridge, provider, binary-resolver, error-classifier, timeout-utils)  
**Auditor:** CLI Security Sub-Agent

---

## Summary

| Severity | Count | Key Themes                                                                                                                |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| Critical | 0     | —                                                                                                                         |
| High     | 2     | Resource cleanup on generator abandonment; unhandled exception in abort handler                                           |
| Medium   | 5     | Unbounded stderr memory; unbounded timeout env; TOCTOU on binary path; stderr secret leakage; missing path/dir validation |
| Low      | 4     | Large line buffer growth; loose JSON-RPC shape validation; ID overflow; missing write backpressure                        |

---

## Findings

### [HIGH-1] `withFirstEventTimeout` leaks resources when consumer abandons generator

- **File:** `packages/providers/src/hermes/timeout-utils.ts`
- **Line:** 1–27
- **Description:** The wrapper manually iterates `gen.next()` but does **not** forward `.return()` to the inner generator when the consumer stops iterating (e.g., `break` in a `for await` loop, or parent generator teardown). Because `provider.ts` delegates via `yield*`, any caller abandonment bypasses the `finally` block inside `bridgeHermesSession`, leaving:
  - the child process alive and unreferenced,
  - Node.js event listeners attached (`stdout`, `stderr`, `exit`, `error`, `abort`),
  - the `AsyncQueue` unclosed.
- **Recommended Fix:** Override the async generator’s `return` path to explicitly call `await gen.return()` (or `gen.throw()` if timed out) before the wrapper yields its final value:
  ```ts
  const iterator = gen[Symbol.asyncIterator]();
  try {
    while (true) {
      /* ... yield ... */
    }
  } finally {
    await iterator.return?.();
  }
  ```

### [HIGH-2] Unhandled exception from `stdin.write` in abort handler

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Line:** 238–244
- **Description:** Inside `onAbort()`, `childProcess.stdin?.write(...)` will throw `ERR_STREAM_DESTROYED` if the stdin stream has already been closed or the process has died, because optional chaining only guards `null`/`undefined`, not a destroyed stream. Since `onAbort` is called synchronously from an `abort` event listener, the thrown exception becomes an unhandled error that can crash the bridge or leak as an unhandled rejection.
- **Recommended Fix:** Wrap the write in a `try/catch`:
  ```ts
  try {
    childProcess.stdin?.write(...);
  } catch {
    // stdin already closed — safe to ignore
  }
  ```

### [MEDIUM-1] `stderrLines` array grows unbounded — memory exhaustion DoS

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Line:** 82, 150–156
- **Description:** Every non-empty chunk from `childProcess.stderr` is pushed into `stderrLines`. The array is never truncated. A malicious or buggy child process that writes gigabytes to stderr will cause the Node.js parent process to exhaust heap memory. Only the last element is ever consumed, so the entire history is unnecessary.
- **Recommended Fix:** Replace the array with a bounded ring buffer (e.g., keep last 5 lines) or simply store the last line in a string variable:
  ```ts
  let lastStderrLine = '';
  // ...on('data', ...)...
  lastStderrLine = text.slice(0, 500);
  ```

### [MEDIUM-2] Environment timeout variable has no upper bound

- **File:** `packages/providers/src/hermes/provider.ts`
- **Line:** 20–27
- **Description:** `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` is parsed with `Number(raw)` and accepted if finite and > 0. An attacker or misconfiguration can set it to `Number.MAX_SAFE_INTEGER`, effectively disabling the timeout and permitting indefinite hangs.
- **Recommended Fix:** Add a reasonable maximum cap (e.g., 5 minutes):
  ```ts
  const MAX_TIMEOUT_MS = 300_000;
  if (parsed > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  ```

### [MEDIUM-3] TOCTOU race condition in binary resolution

- **File:** `packages/providers/src/utils/binary-resolver.ts` (shared)  
  Impacted caller: `packages/providers/src/hermes/binary-resolver.ts` / `provider.ts`
- **Line:** `utils/binary-resolver.ts` 96–147; `hermes/binary-resolver.ts` 41–48, 57–77; `provider.ts` 98–122
- **Description:** `resolveBinaryPath` checks `fileExists(path)` and returns the path. The caller separately calls `verifyHermesBinary` (spawns `--version`), then later `spawn(...)` for real use. A local attacker with write access to the directory can swap the file (symlink replacement) between the existence check and the actual spawn, causing the parent to execute an attacker-controlled binary.
- **Recommended Fix:** Remove the pre-flight `fileExists` gate for the final spawn path. Spawn the binary directly and catch `ENOENT` / `EACCES` at spawn time. Keep `verifyHermesBinary` as a best-effort smoke test, but do not rely on it as a security gate.

### [MEDIUM-4] Sensitive data from subprocess stderr may leak into logs and user-facing errors

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Line:** 176–186, 209–228, 251–266
- **Description:** On error/abort/exit paths, the last stderr line (up to 200 chars) is appended to error messages and result chunks. If Hermes logs API keys, access tokens, or other secrets to stderr, those secrets propagate into Archon’s error messages, which may be logged by the framework or surfaced to the user.
- **Recommended Fix:** Redact known secret patterns from stderr before inclusion in errors, or log stderr separately at `debug` level rather than embedding it in higher-level error messages. At minimum, scan for patterns like `key=`, `token=`, `api_key`, `password`, and replace values with `[REDACTED]`.

### [MEDIUM-5] `cwd` path is not validated for existence, accessibility, or directory type

- **File:** `packages/providers/src/hermes/session-resolver.ts`
- **Line:** 47–50
- **Description:** `resolveHermesSession` accepts any non-empty string as `cwd` (falling back to `process.cwd()` only for empty strings). Although `event-bridge.ts` later validates `isAbsolute`, it does not confirm the path exists, is a directory, or is readable. Passing a file path or non-existent path to `spawn({ cwd })` will cause an opaque `ENOENT` or `ENOTDIR` failure inside the child process, producing poor diagnostics and a potential retry loop.
- **Recommended Fix:** After `isAbsolute` validation, add an `fs.statSync` (or async equivalent) check confirming `cwd` is a directory and readable. Throw early with a descriptive message if not.

### [LOW-1] `lineBuffer` can temporarily exceed `MAX_LINE_BUFFER_LENGTH`

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Line:** 96–103
- **Description:** The line-buffer length guard runs _after_ appending incoming data. If a single `data` event delivers a chunk larger than `MAX_LINE_BUFFER_LENGTH`, or if many small newline-less chunks arrive before any newline, the buffer can temporarily grow well past the 1 MiB intended limit.
- **Recommended Fix:** Check `lineBuffer.length + data.length` _before_ concatenation, and truncate aggressively if the combined length already exceeds the cap.

### [LOW-2] JSON-RPC parser uses loose structural validation

- **File:** `packages/providers/src/hermes/acp-protocol.ts`
- **Line:** 92–105
- **Description:** `parseMessage` only checks for the presence of `jsonrpc: '2.0'` and then downcasts based on the existence of `method`, `result`, or `error` keys. It does not validate that `id` is a number, that `error` has required properties, or that a message does not contain conflicting keys (e.g., both `method` and `result`). A malicious or buggy server could send malformed messages that pass this gate and confuse downstream routing logic.
- **Recommended Fix:** Add stricter guards:
  ```ts
  if ('id' in record && typeof record.id !== 'number') return null;
  if ('result' in record && ('method' in record || 'error' in record)) return null;
  if ('error' in record && (!record.error || typeof (record.error as any).code !== 'number'))
    return null;
  ```

### [LOW-3] ACP request ID overflows at `Number.MAX_SAFE_INTEGER`

- **File:** `packages/providers/src/hermes/acp-protocol.ts`
- **Line:** 40–43
- **Description:** `createAcpIdGenerator` uses `let nextId = start; return { next: () => nextId++ };`. In theory, after ~9 quadrillion requests the ID wraps and duplicates could appear. While not practically reachable today, long-running or repeatedly instantiated generators create a latent correctness issue.
- **Recommended Fix:** Reset or wrap the counter at a safe bound, or use a 53-bit counter with explicit modulo:
  ```ts
  nextId = (nextId % Number.MAX_SAFE_INTEGER) + 1;
  ```

### [LOW-4] No backpressure handling on `stdin.write`

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Line:** 290
- **Description:** `childProcess.stdin.write(serializeMessage(req))` does not check the return value or listen for the `drain` event. If the child process stops reading stdin (e.g., it crashed or is blocked), the internal Node.js stream buffer will grow indefinitely until the process dies or memory is exhausted.
- **Recommended Fix:** Use `writable.write()` return value to decide whether to wait for `drain`, or wrap writes in a Promise-based helper that respects backpressure.

---

## Checklist Walkthrough

| #   | Check                                                                 | Pass / Fail | Notes                                                                                                                                                        |
| --- | --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | User-provided strings validated (cwd, binary path, sessionId, prompt) | Partial     | `cwd` is absolute-checked; binary path is existence-checked; `prompt`, `sessionId` not sanitized but passed safely via JSON                                  |
| 2   | Shell injection via spawn args                                        | Pass        | `spawn()` uses array args, no `shell: true`; `execFile` also uses array args                                                                                 |
| 3   | Path traversal in file operations                                     | Partial     | `cwd` must be absolute; binary path can point anywhere if configured, but no shell injection vector                                                          |
| 4   | JSON parsing with try-catch                                           | Pass        | `parseMessage` catches `JSON.parse` errors and returns `null`                                                                                                |
| 5   | No infinite / unbounded loops                                         | Partial     | Bounded except `stderrLines` unbounded growth (MEDIUM-1) and temporary line buffer spike (LOW-1)                                                             |
| 6   | Process spawning bounded                                              | Pass        | One `spawn` per `sendQuery`; no loops or recursion                                                                                                           |
| 7   | Environment vars sanitized before spread                              | Partial     | Non-string values filtered, but keys and `process.env` pass-through unrestricted by design (capability: `envInjection: true`)                                |
| 8   | No secrets in errors / logs                                           | Fail        | Stderr embedded into error messages and logged (MEDIUM-4); prompt truncated but still logged (LOW)                                                           |
| 9   | Timeout values bounded and reasonable                                 | Partial     | Hardcoded timeouts OK; `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` has no upper cap (MEDIUM-2)                                                                    |
| 10  | Resource cleanup guaranteed                                           | Fail        | `withFirstEventTimeout` breaks cleanup chain (HIGH-1); abort `stdin.write` unguarded (HIGH-2)                                                                |
| 11  | No TOCTOU issues                                                      | Fail        | `fileExists` pre-check before spawn creates a race (MEDIUM-3)                                                                                                |
| 12  | Abort signal handling correct                                         | Partial     | Listener added/removed correctly, but `stdin.write` throws unhandled and SIGKILL fallback may fail if process already dead (defensively caught in `finally`) |

---

## Recommendations (Prioritized)

1. **(HIGH)** Fix `timeout-utils.ts` to forward `.return()` to the wrapped generator so `bridgeHermesSession`’s `finally` always runs.
2. **(HIGH)** Wrap `childProcess.stdin?.write(...)` inside `onAbort` in a `try/catch`.
3. **(MEDIUM)** Cap `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` to a reasonable maximum (e.g., 5 min).
4. **(MEDIUM)** Replace `stderrLines: string[]` with a bounded buffer or single string storing only the last stderr chunk.
5. **(MEDIUM)** Remove or supplement `fileExists` pre-check with spawn-time error handling to eliminate the TOCTOU window.
6. **(MEDIUM)** Sanitize or redact stderr before embedding it in error payloads.
7. **(MEDIUM)** Validate `cwd` is an existing readable directory before spawning.
8. **(LOW)** Harden `parseMessage` with stricter JSON-RPC shape validation.
9. **(LOW)** Guard `lineBuffer` length _before_ concatenation.
10. **(LOW)** Add modulo wrap to the ACP ID generator.
