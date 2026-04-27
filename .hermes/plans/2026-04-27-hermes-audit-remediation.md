# Hermes Provider — Audit Remediation Plan

> Address all findings from three quality audits.  
> Audit sources: structural, conventions, security.

## Already Fixed (critical batch)

| ID  | Finding                                         | File               | Fix                          |
| --- | ----------------------------------------------- | ------------------ | ---------------------------- |
| C1  | sendRequest timer not cleared when request wins | `event-bridge.ts`  | `activeTimers` Map           |
| C2  | Unhandled rejection in `withFirstEventTimeout`  | `timeout-utils.ts` | `clearTimeout(timerHandle)`  |
| C3  | Inner generator leak on timeout                 | `timeout-utils.ts` | `gen.return()` on error path |
| C4  | `stdin.write` EPIPE in abort handler            | `event-bridge.ts`  | try/catch wrapper            |
| C5  | `childProcess.kill` uncaught in abort handler   | `event-bridge.ts`  | try/catch wrapper            |

---

## Remaining Fixes

### Batch 1 (independent files, 3 parallel executors)

| ID  | Severity | File                 | Finding                                            | Fix                                                                                                           |
| --- | -------- | -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1  | MEDIUM   | `event-bridge.ts`    | `stderrLines` unbounded growth                     | Replace `string[]` with a bounded ring buffer (last 50 lines). On error paths, use the most recent line only. |
| R2  | MEDIUM   | `acp-protocol.ts`    | `parseMessage` silently discards JSON parse errors | Log the caught error at `debug` level before returning `null`. Include the raw line (truncated).              |
| R3  | MEDIUM   | `binary-resolver.ts` | `verifyHermesBinary` silently discards exec errors | Log the caught error at `debug` level before returning `false`. Include the binary path.                      |

### Batch 2 (event-bridge.ts + provider.ts, sequential on same files)

| ID  | Severity | File              | Finding                                                      | Fix                                                                                                                                                                                       |
| --- | -------- | ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4  | LOW      | `event-bridge.ts` | `lineBuffer` can temporarily exceed `MAX_LINE_BUFFER_LENGTH` | Check `lineBuffer.length + data.length` BEFORE concatenation. Truncate aggressively if over cap.                                                                                          |
| R5  | MEDIUM   | `event-bridge.ts` | Sensitive stderr data may leak into errors/logs              | Before embedding stderr in error messages or result chunks, redact known secret patterns: `key=`, `token=`, `api_key=`, `password=`, `secret=`. Replace matched values with `[REDACTED]`. |
| R6  | MEDIUM   | `provider.ts`     | `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` has no upper bound    | Cap at `MAX_TIMEOUT_MS = 300_000` (5 minutes). Log a warning if the env value exceeds the cap.                                                                                            |

### Batch 3 (acp-protocol.ts + session-resolver.ts, sequential)

| ID  | Severity | File                  | Finding                                            | Fix                                                                                                                                                                                    |
| --- | -------- | --------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R7  | LOW      | `acp-protocol.ts`     | ACP ID generator overflows at `MAX_SAFE_INTEGER`   | Add modulo wrap: `nextId = (nextId % Number.MAX_SAFE_INTEGER) + 1`                                                                                                                     |
| R8  | MEDIUM   | `acp-protocol.ts`     | Mutable shared `legacyId` module state             | Remove the `legacyId` fallback in `createRequest`. Make `idGenerator` required. Update all callers in `event-bridge.ts` to pass `idGen`. Mark `legacyId` as removed.                   |
| R9  | LOW      | `acp-protocol.ts`     | JSON-RPC parser uses loose structural validation   | Add stricter guards: `typeof record.id === 'number'`, reject messages with both `result` and `method`, validate `error.code` is a number.                                              |
| R10 | MEDIUM   | `session-resolver.ts` | `cwd` not validated as existing readable directory | After `isAbsolute` validation, add `fs.statSync` check. If not a directory or not readable, throw early with a clear message.                                                          |
| R11 | info     | `acp-protocol.ts`     | Sparse module-level JSDoc                          | Add a module header doc comment explaining ACP and linking to protocol docs.                                                                                                           |
| R12 | HIGH     | `event-bridge.ts`     | Hardcoded `version: '0.3.9'` in ACP initialize     | Import version dynamically from `@archon/paths` if available, or from root `package.json`. If dynamic import isn't viable in compiled builds, add a `TODO: sync with release` comment. |

### Batch 4 (event-bridge.ts, final cleanup)

| ID  | Severity | File              | Finding                                   | Fix                                                                                                                                                                                             |
| --- | -------- | ----------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13 | LOW      | `event-bridge.ts` | No backpressure handling on `stdin.write` | Check `writable.write()` return value. If `false`, wait for the `drain` event before sending the next message.                                                                                  |
| R14 | MEDIUM   | `event-bridge.ts` | `terminalEmitted` cross-handler race      | The flag is read/written by multiple event handlers. Synchronize by pushing terminal chunks through the `queue` with a dedup key, or add a synchronous cleanup function that all handlers call. |

---

## Execution Rules

1. Max 3 concurrent executors per batch
2. One file per executor within a batch (source changes only; test changes come after source verifier-green)
3. Every executor gets: exact file path, line number if known, expected change, verification gate
4. Verifiers are always fresh agents — never reuse executors as verifiers
5. If a verifier finds issues, redispatch a fresh executor with the issues as context

---

## Final Gate

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check   # exit 0
bun test packages/providers/src/hermes/      # 124+ pass, 0 fail
bun run lint --filter @archon/providers      # max-warnings 0
```
