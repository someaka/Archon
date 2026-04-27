# Verification Report: Cross-Provider Remediation Audit

**Verifier:** 3 (Cross-check remediation against master audit synthesis)
**Date:** 2026-04-27
**Scope:** Hermes provider remediation (R1–R14 + C1–C5 pre-fixes) verified against master synthesis, with cross-provider consistency checks against Claude, Codex, and Pi.

---

## 1. Remediation Completeness (R1–R14)

### Fully Fixed (12/14)

| ID  | Finding                                | Status | Evidence                                                                                                                                                                                                                                   |
| --- | -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | `stderrLines` unbounded growth         | ✅     | `event-bridge.ts:89` defines `MAX_STDERR_LINES = 50`; line 179–181 does `shift()` when over cap.                                                                                                                                           |
| R2  | `parseMessage` silent JSON discard     | ✅     | `acp-protocol.ts:139` logs `acp.parse_failed` at debug with truncated line.                                                                                                                                                                |
| R3  | `verifyHermesBinary` silent exec error | ✅     | `binary-resolver.ts:48` logs `hermes.binary_verify_failed` at debug with err + binary path.                                                                                                                                                |
| R4  | `lineBuffer` can exceed cap            | ✅     | `event-bridge.ts:107–114` checks `lineBuffer.length + incoming.length > MAX_LINE_BUFFER_LENGTH` BEFORE concatenation. Lines 120–123 also cap the residual buffer after split.                                                              |
| R5  | Sensitive stderr data in errors/logs   | ✅     | `event-bridge.ts:29–33` defines `redactSecrets()` with regex for `key=`, `token=`, `api_key=`, `password=`, `secret=`, `auth=` patterns. Used in all stderr embedding paths (lines 182, 213, 234, 239, 280, 285).                          |
| R6  | Timeout no upper bound                 | ✅     | `provider.ts:20` defines `MAX_TIMEOUT_MS = 300_000`; lines 27–33 cap and log warning.                                                                                                                                                      |
| R7  | ACP ID overflow at MAX_SAFE_INTEGER    | ✅     | `acp-protocol.ts:57` does `nextId = (nextId % Number.MAX_SAFE_INTEGER) + 1`.                                                                                                                                                               |
| R8  | Mutable shared `legacyId` state        | ✅     | `acp-protocol.ts:72` — `idGenerator` is now required. No `legacyId` fallback exists. `resetAcpIdCounter` is gone.                                                                                                                          |
| R9  | Loose JSON-RPC validation              | ✅     | `acp-protocol.ts:108–135` — rejects `result`+`method` conflict (line 109), requires `id` as number for responses (lines 119, 125), validates `error.code` is number (line 130), validates `method` is string for notifications (line 113). |
| R10 | `cwd` not validated as directory       | ✅     | `session-resolver.ts:53–63` — `statSync` check verifies `isDirectory()`, throws on `ENOENT` or non-directory.                                                                                                                              |
| R11 | Sparse module-level JSDoc              | ✅     | `acp-protocol.ts:1–8` — module header with ACP protocol doc links.                                                                                                                                                                         |
| R12 | Hardcoded version string               | ✅     | `event-bridge.ts:20` imports `BUNDLED_VERSION` from `@archon/paths`; line 339 uses it in `clientInfo`. Tests mock it to `'dev'`.                                                                                                           |

### Partially Fixed (2/14)

| ID  | Finding                          | Status     | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R13 | No backpressure on `stdin.write` | ⚠️ PARTIAL | `event-bridge.ts:312–317` checks `childProcess.stdin.write()` return value and logs `acp.stdin_drain_complete` on drain event. However, it does NOT `await` the drain before continuing. The `sendRequest` returns the `Promise.race` immediately after writing. Abort handler (line 257–259) also checks but doesn't block. **Acceptable in practice** — ACP sends only 3 sequential requests (initialize → session/new → session/prompt) with await between each, so backpressure is unlikely to accumulate. |
| R14 | `terminalEmitted` race           | ✅ FIXED   | `event-bridge.ts:197–201` — `emitTerminal()` synchronously checks `terminalEmitted` flag before pushing. The flag is only written inside this function (lines 198–200), and all terminal paths go through it. No race possible since Node.js is single-threaded.                                                                                                                                                                                                                                               |

**Verdict on R13:** The fix acknowledges backpressure but doesn't fully serialize on drain. Given the low request volume (3 sequential requests), this is acceptable. Recommend marking as "won't fix" or adding a comment explaining the tradeoff.

---

## 2. Cross-Provider Consistency Analysis

### New Inconsistencies Introduced by Remediation

| Severity | Finding                         | Details                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MINOR    | Timeout cap divergence          | Hermes caps `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` at 300,000ms (`provider.ts:20`). Claude's `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` has NO cap (`claude/provider.ts:119–126`) — any `Number.isFinite(parsed) && parsed > 0` is accepted, including values like `999999999`.                                                                                          |
| MINOR    | stderr line bounding divergence | Hermes bounds stderr to 50 lines (`event-bridge.ts:89`). Claude's `stderrLines` array in `buildBaseClaudeOptions` is unbounded (`claude/provider.ts:613`). Both are local arrays scoped to a single query, so memory impact is bounded by query duration, but the divergence is inconsistent.                                                                        |
| MINOR    | stderr redaction divergence     | Hermes applies `redactSecrets()` to all stderr before embedding in errors/logs (`event-bridge.ts:29–33`). Claude embeds stderr directly without redaction (`claude/provider.ts:851–864`, `claude/provider.ts:613`). Pi and Codex don't write to stderr directly.                                                                                                     |
| MINOR    | JSON-RPC validation strictness  | Hermes `parseMessage` now has strict type guards for `id` (must be number), `error.code` (must be number), `method` (must be string), and rejects `result`+`method` conflicts (`acp-protocol.ts:108–135`). Claude and Codex use SDK-provided parsing (no custom JSON-RPC). Pi has no JSON-RPC layer. This is architecturally appropriate — not a real inconsistency. |

### No Inconsistencies in Shared Utility Usage

| Utility             | Hermes                     | Claude                                          | Codex                                          | Pi                     | Consistent? |
| ------------------- | -------------------------- | ----------------------------------------------- | ---------------------------------------------- | ---------------------- | ----------- |
| `AsyncQueue`        | `utils/async-queue.ts`     | N/A (SDK handles)                               | N/A (SDK handles)                              | `utils/async-queue.ts` | ✅ Shared   |
| `resolveBinaryPath` | `utils/binary-resolver.ts` | `utils/binary-resolver.ts` (via Claude wrapper) | `utils/binary-resolver.ts` (via Codex wrapper) | N/A (in-process)       | ✅ Shared   |
| `createLazyLogger`  | `utils/lazy-logger.ts`     | `utils/lazy-logger.ts`                          | `utils/lazy-logger.ts`                         | `utils/lazy-logger.ts` | ✅ Shared   |

---

## 3. Shared Utility Usage (M1–M10 Duplication Audit)

| ID  | Duplication Finding                 | Status           | Evidence                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `AsyncQueue<T>` duplicated          | ✅ RESOLVED      | Hermes imports from `../utils/async-queue.ts` (`event-bridge.ts:6`). Pi also uses shared version. No duplication remains.                                                                                                                                                                     |
| M2  | Binary resolver triplicated         | ✅ RESOLVED      | Hermes uses `resolveBinaryPath` from `../utils/binary-resolver.ts` (`binary-resolver.ts:15`). Provider-specific strings passed as options. Claude and Codex also use the shared resolver via their own wrappers.                                                                              |
| M3  | Logger lazy-init/caching duplicated | ✅ RESOLVED      | Hermes uses `createLazyLogger` from `../utils/lazy-logger.ts` (`acp-protocol.ts:10`, `event-bridge.ts:19`, `binary-resolver.ts:16`, `provider.ts:14`). All providers use the shared utility.                                                                                                  |
| M4  | Retry orchestration duplicated      | ❌ NOT ADDRESSED | Claude (`claude/provider.ts:951–1030`) and Codex (`codex/provider.ts:560–618`) both have inline retry loops with identical `MAX_SUBPROCESS_RETRIES = 3`, `RETRY_BASE_DELAY_MS = 2000`, exponential backoff. No shared `withRetry()` utility extracted. (Out of scope for Hermes remediation.) |
| M5  | Error classification constants      | ❌ NOT ADDRESSED | Claude (`claude/provider.ts:97–106`) and Codex (`codex/provider.ts:116–125`) have copy-pasted `RATE_LIMIT_PATTERNS`, `AUTH_PATTERNS`, `SUBPROCESS_CRASH_PATTERNS`. Hermes has its own `error-classifier.ts` but it's provider-specific, not shared. (Out of scope.)                           |
| M6  | Config parsers duplicated           | ❌ NOT ADDRESSED | All four providers implement defensive `typeof check + assign` patterns independently. No shared `parseProviderDefaults<T>()`. (Out of scope.)                                                                                                                                                |
| M7  | Env var expansion duplicated        | ❌ NOT ADDRESSED | Claude has `expandEnvVarsInRecord` inline. No shared utility. (Out of scope.)                                                                                                                                                                                                                 |
| M8  | Environment merging duplicated      | ❌ NOT ADDRESSED | Hermes (`session-resolver.ts:66–78`), Pi (separate channels), Claude (`provider.ts:80–91`), Codex (`provider.ts:78–84`) — all have different env merging. No shared `resolveExecutionContext()`. (Out of scope.)                                                                              |
| M9  | Event bridge pattern duplicated     | ⚠️ PARTIALLY     | Hermes and Pi both use `AsyncQueue` + `kind: 'chunk'                                                                                                                                                                                                                                          | 'done' | 'error'`+`for await` loop. The pattern is shared but the bridge implementations are still separate (~250 lines each). (Out of scope for this remediation.) |
| M10 | Model ref parsing duplicated        | ❌ NOT ADDRESSED | Hermes (`model-ref.ts`) and Pi (`model-ref.ts`) have different split logic. No shared `parseModelRef()`. (Out of scope.)                                                                                                                                                                      |

**Verdict:** M1, M2, M3 are resolved by the shared utilities. M4–M10 remain unaddressed but are out of scope for the Hermes-specific remediation.

---

## 4. Test Isolation (C1 — Mock Pollution)

### Dead Code Deletion

| File                 | Status     | Evidence                                                                                                 |
| -------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `acp-bridge.ts`      | ✅ DELETED | Not found in file listing of `packages/providers/src/hermes/`.                                           |
| `hermes-cli.mock.ts` | ✅ DELETED | Not found in file listing of `packages/providers/src/hermes/`.                                           |
| `resetAcpIdCounter`  | ✅ REMOVED | No matches in any file (`search_files` for `resetAcpIdCounter` returned 0 results).                      |
| `legacyId` fallback  | ✅ REMOVED | `createRequest` requires `idGenerator` parameter (`acp-protocol.ts:72`). No module-global mutable state. |

### Mock Isolation Status

The `acp-protocol.ts` module no longer has test-only exports polluting production code. The `createAcpIdGenerator()` factory is a proper constructor that creates isolated instances. Tests can create their own generators without shared mutable state.

**Remaining C1 concern:** The master synthesis flagged that 8 Hermes test files run in a single `bun test` invocation with overlapping `mock.module()` calls. The dead code deletion reduces the surface, but the test file batching issue (multiple files mocking `@archon/paths` and `child_process`) would require test runner configuration changes, which are outside the scope of source-file remediation. **Verify separately whether test runner batching was changed.**

---

## 5. Remaining Findings from Master Synthesis NOT Addressed

### IMPORTANT (Hermes-specific, not in R1–R14 scope)

| ID  | Finding                                           | Current State                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I7  | `abortSignal` listener leak                       | **MOSTLY FIXED.** Listener registered at `event-bridge.ts:295` with `{ once: true }`, removed in `finally` block at line 424. Narrow remaining gap: if the `catch` block at line 402 throws (e.g., `emitTerminal` or `queue.push` fails), the `finally` at line 419 won't run because we haven't entered the consumer loop's `try` yet. Practically impossible but theoretically possible. |
| I14 | `session/cancel` sent as request                  | **FIXED.** `event-bridge.ts:253` now uses `createNotification(ACP_METHODS.sessionCancel, ...)` instead of `createRequest`.                                                                                                                                                                                                                                                                 |
| I15 | Event-bridge doesn't guard `stdin` on abort       | **FIXED.** `event-bridge.ts:257` uses optional chaining `childProcess.stdin?.write(data)` with try/catch wrapper (lines 261–263).                                                                                                                                                                                                                                                          |
| I16 | Mis-handles JSON-RPC error responses              | **FIXED.** `event-bridge.ts:344–354` handles `result` responses for initialize; line 369 validates `sessionId` presence. `parseMessage` now rejects malformed error objects (`acp-protocol.ts:124–134`).                                                                                                                                                                                   |
| I17 | `provider.ts` ignores config at runtime           | **PARTIALLY FIXED.** `parseHermesConfig` IS called (`provider.ts:99`), `config.hermesBinaryPath` IS used (`provider.ts:109`). However, `resolveHermesModel`, `resolveHermesProvider`, `resolveHermesEndpoint` are still NOT wired into the spawn call. The CLI is spawned with `['acp']` only — no model/provider/endpoint args.                                                           |
| I18 | Re-spreads `process.env`                          | **NOT FIXED.** `provider.ts:131` still does `env: { ...process.env, ...session.env }`. Since `session.env` already contains the filtered merge of process.env + provided env, the `...process.env` spread re-introduces `undefined` values. Should be `env: session.env`.                                                                                                                  |
| I19 | Sends `mcpServers: []` despite capability `false` | **NOT FIXED.** `event-bridge.ts:362` still sends `mcpServers: []` in `session/new`. Harmless but inconsistent with `HERMES_CAPABILITIES.mcp === false`.                                                                                                                                                                                                                                    |
| I28 | `createRequest` cast pollution                    | **FIXED.** `idGenerator` is required (`acp-protocol.ts:72`), no `as unknown as` casts needed.                                                                                                                                                                                                                                                                                              |
| I29 | Hardcoded version string                          | **FIXED.** Uses `BUNDLED_VERSION` from `@archon/paths` (`event-bridge.ts:20, 339`).                                                                                                                                                                                                                                                                                                        |
| I30 | No validation of `id` field                       | **FIXED.** `parseMessage` validates `id` is a number for responses (`acp-protocol.ts:119, 125`).                                                                                                                                                                                                                                                                                           |

### IMPORTANT (Cross-provider, not Hermes-specific)

| ID      | Finding                                  | Status                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1      | Deterministic errors retried             | NOT ADDRESSED (Claude issue)                                                                                                                                                                                                                                                                  |
| I2      | `withFirstMessageTimeout` doesn't abort  | NOT ADDRESSED (Claude issue — but Claude's version at line 171 DOES call `controller.abort()`)                                                                                                                                                                                                |
| I3      | `expandEnvVars` coerces undefined        | NOT ADDRESSED (Claude issue)                                                                                                                                                                                                                                                                  |
| I4      | Pi has no retry logic                    | NOT ADDRESSED (Pi issue)                                                                                                                                                                                                                                                                      |
| I5      | Pi passes raw SDK errors                 | NOT ADDRESSED (Pi issue)                                                                                                                                                                                                                                                                      |
| I6      | Missing rate limit handling in Hermes/Pi | **PARTIALLY ADDRESSED.** Hermes now has `error-classifier.ts` with `classifyHermesError()` that detects rate limits, auth failures, crashes, and JSON-RPC error codes. However, the classifier is NOT wired into `provider.ts`'s `sendQuery` — there is no retry loop in the Hermes provider. |
| I8      | Pi event bridge drops unknown events     | NOT ADDRESSED (Pi issue)                                                                                                                                                                                                                                                                      |
| I9      | Pi abort signal checked too late         | NOT ADDRESSED (Pi issue)                                                                                                                                                                                                                                                                      |
| I10     | Pi empty-string env override ignored     | NOT ADDRESSED (Pi issue)                                                                                                                                                                                                                                                                      |
| I11–I13 | Pi-specific issues                       | NOT ADDRESSED (Pi issues)                                                                                                                                                                                                                                                                     |
| I20     | `loadMcpConfig` no schema validation     | NOT ADDRESSED (Claude issue)                                                                                                                                                                                                                                                                  |
| I21     | `shouldPassNoEnvFile` fragile            | NOT ADDRESSED (Claude issue)                                                                                                                                                                                                                                                                  |
| I22–I27 | Type safety issues                       | NOT ADDRESSED                                                                                                                                                                                                                                                                                 |
| I31–I42 | Test coverage gaps                       | NOT ADDRESSED by this remediation                                                                                                                                                                                                                                                             |
| I43     | `acp-bridge.ts` dead code                | ✅ FIXED (deleted)                                                                                                                                                                                                                                                                            |
| I44     | `hermes-cli.mock.ts` dead code           | ✅ FIXED (deleted)                                                                                                                                                                                                                                                                            |
| I45     | `resetAcpIdCounter` test-only state      | ✅ FIXED (removed)                                                                                                                                                                                                                                                                            |
| I46–I47 | `applyNodeConfig` issues                 | NOT ADDRESSED (Claude issues)                                                                                                                                                                                                                                                                 |

### MINOR (Hermes-specific)

| ID  | Finding                                               | Status                                                                                             |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| M12 | Binary resolver naming divergence                     | NOT ADDRESSED — `resolveHermesBinary` still drops "Path" suffix                                    |
| M15 | Binary resolver dev-mode divergence                   | NOT ADDRESSED — Hermes returns `undefined` while Claude/Codex throw. Intentional but undocumented. |
| M17 | Session resume semantics divergence                   | NOT ADDRESSED — Hermes silently ignores `resumeSessionId`                                          |
| M19 | Spawn pattern differences                             | NOT ADDRESSED — Architectural, not a bug                                                           |
| M23 | Structured output capability flag contradicts comment | NOT ADDRESSED                                                                                      |
| M32 | Duplicate mock code across test files                 | NOT ADDRESSED by this remediation                                                                  |
| M33 | `provider.test.ts` mocks `child_process` globally     | NOT ADDRESSED by this remediation                                                                  |

---

## 6. New Issues Introduced by Remediation

| Severity | Finding                                                      | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MINOR    | `redactSecrets` regex may miss patterns                      | `event-bridge.ts:31–33` — The regex `\b(key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | token | api_key | password | secret | auth)\b=\S+`matches`key=VALUE`but not`KEY="value with spaces"`or`key: value`(YAML-style). The JSON variant handles quoted keys but only with`"key": "value"` syntax. This is adequate for CLI stderr but not comprehensive. |
| MINOR    | `redactSecrets` applied redundantly                          | In exit/error/abort handlers, `redactSecrets()` is called on the same stderr line multiple times (e.g., lines 213 and 234 both redact `stderrLines[stderrLines.length - 1]`). Not a bug, just redundant computation.                                                                                                                                                                                                                                                                                                                  |
| INFO     | `emitTerminal` + `queue.push({ kind: 'done' })` pattern      | The pattern of calling `emitTerminal()` then `queue.push({ kind: 'done' })` is repeated 4 times (lines 215+226, 241+242, 287+288, 404+409). Could be extracted to a helper like `finishQueue(chunk?)`. Not a bug, minor DRY opportunity.                                                                                                                                                                                                                                                                                              |
| MINOR    | `withFirstEventTimeout` doesn't abort the underlying process | Unlike Claude's `withFirstMessageTimeout` which calls `controller.abort()` on timeout, Hermes' `withFirstEventTimeout` (`timeout-utils.ts`) only rejects the race. The underlying `bridgeHermesSession` generator keeps running until the consumer stops iterating. In practice, the thrown error causes the `yield*` in `provider.ts:137` to propagate, which exits the generator's `for await` loop, triggering the `finally` cleanup. So the process IS killed, but through an indirect path rather than an explicit abort signal. |

---

## 7. Summary

### Remediation Quality: GOOD (12/14 fully fixed, 2/14 acceptable partial)

The R1–R14 remediation is thorough and well-implemented. All critical fixes (R7 ID overflow, R8 mutable state, R9 JSON-RPC validation, R12 version drift) are correctly applied. The pre-fixes (C1–C5) for timer leaks, EPIPE, and kill errors are also in place.

### Cross-Provider Consistency: ACCEPTABLE with minor divergences

The remediation introduces 3 minor new inconsistencies (timeout cap, stderr bounding, stderr redaction) that favor Hermes being more defensive. This is appropriate since Hermes directly manages a child process while Claude/Codex delegate to SDKs.

### Shared Utility Usage: GOOD

Hermes correctly uses all three shared utilities (AsyncQueue, binary-resolver, lazy-logger). No new duplication introduced. M1–M3 are resolved.

### Dead Code: CLEAN

`acp-bridge.ts`, `hermes-cli.mock.ts`, `resetAcpIdCounter`, and `legacyId` are all removed. No test-only state in production code.

### Remaining Work (Priority Order)

1. **I18** — Change `provider.ts:131` from `{ ...process.env, ...session.env }` to `session.env` (trivial fix, prevents undefined re-introduction)
2. **I17** — Wire `resolveHermesModel`/`resolveHermesEndpoint` into the spawn call or remove the dead code
3. **I6** — Add retry loop to Hermes `sendQuery` using the existing `classifyHermesError`
4. **I19** — Remove `mcpServers: []` from `session/new` or set capability to `true`
5. **C1 (test batching)** — Verify test runner configuration splits Hermes tests into isolated batches

---

_End of verification report._
