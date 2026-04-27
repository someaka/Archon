# Hermes Provider Code Audit — 2026-04-27

> Audit of Hermes provider source against fix plan (2026-04-26), completion plan (2026-04-27), and polish audit (2026-04-27).
> Auditor role: read-only. No files were modified.

## 1. Test Status

```
bun test packages/providers/src/hermes/ → 126 pass / 0 fail / 221 expect() calls [157ms]
bun --filter @archon/providers type-check → clean (exit 0)
```

All 126 tests pass. No type errors in the @archon/providers package.

## 2. Git Status Summary

```
 M packages/providers/src/hermes/provider.test.ts
 D packages/providers/src/test/mocks/hermes-cli.mock.ts
?? packages/providers/src/hermes/error-classifier.test.ts
?? packages/providers/src/hermes/error-classifier.ts
?? packages/providers/src/hermes/timeout-utils.test.ts
?? packages/providers/src/hermes/timeout-utils.ts
```

- `provider.test.ts`: single-line change adding explicit `: ChildProcess` return type to `mockSpawn` (T1 fix, verified green).
- `hermes-cli.mock.ts`: deleted, but outside the hermes package dir. Not mentioned in the fix plan.
- Four new untracked files in `packages/providers/src/hermes/`: `error-classifier.ts`, `error-classifier.test.ts`, `timeout-utils.ts`, `timeout-utils.test.ts`. All are legitimate additions that should be tracked.
- **Dead code files still present and UNCHANGED:** `acp-bridge.ts` and `acp-bridge.test.ts` (E2 mandate was to delete them).

## 3. Fix Plan Element Compliance Table

| Element | Status      | Details                                                                                                                                                                                                                                                                         |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------- |
| **E1**  | **DONE**    | `capabilities.ts` has honest flags (`skills: false`, `fallbackModel: false`, etc.).                                                                                                                                                                                             |
| **E2**  | **MISSING** | `acp-bridge.ts` and `acp-bridge.test.ts` still exist. Fix plan mandates deletion. No other file imports them (confirmed by grep).                                                                                                                                               |
| **E3**  | **DONE**    | `session-resolver.ts` filters non-string `process.env` values with `typeof === 'string'`. Tests cover this.                                                                                                                                                                     |
| **E4**  | **MISSING** | `event-bridge.ts` `sendRequest()` has no Promise.race timeout. No env overrides for `REQUEST_TIMEOUT_MS` or `PROMPT_TIMEOUT_MS`.                                                                                                                                                |
| **E5**  | **MISSING** | `event-bridge.ts` line 210 still uses `createRequest('session/cancel', ...)` not `createNotification`.                                                                                                                                                                          |
| **E6**  | **MISSING** | `event-bridge.ts` exit handler (line 150) does not clear `sigkillTimeout`. Timer leak persists on normal exit.                                                                                                                                                                  |
| **E7**  | **MISSING** | No `isSessionUpdateParams()` type guard exists in `acp-protocol.ts`. Event bridge line 112 still casts with `as unknown as SessionUpdateParams`.                                                                                                                                |
| **E8**  | **MISSING** | `sessionId` validation in `event-bridge.ts` line 275 only checks `!sessionId`, not `typeof === 'string'                                                                                                                                                                         |     | length === 0`. |
| **E9**  | **MISSING** | Magic strings (`'initialize'`, `'session/new'`, `'session/prompt'`, `'session/update'`, etc.) are still used as raw literals in `event-bridge.ts`. No constants exported from `acp-protocol.ts`.                                                                                |
| **E10** | **MISSING** | `acp-protocol.ts` still uses mutable module-level `nextId` counter. No `AcpIdGenerator` interface or per-bridge counter.                                                                                                                                                        |
| **E11** | **PARTIAL** | `stderrLines` are captured and appended to non-zero exit error messages (line 158), but there is no reusable `buildErrorMessage` helper and stderr is not enriched in crash/abort error paths.                                                                                  |
| **E12** | **MISSING** | No `MAX_LINE_BUFFER_LENGTH` constant. `lineBuffer` in `event-bridge.ts` is unbounded.                                                                                                                                                                                           |
| **E13** | **PARTIAL** | `timeout-utils.ts` exists with `withFirstEventTimeout`, but **not wired into `provider.ts`**. The `sendQuery` method still directly yields `bridgeHermesSession` without any timeout wrapper. Also, the utility has an unhandled promise rejection bug (see Polish Audit SF-3). |
| **E14** | **DONE**    | `error-classifier.ts` created with full classification logic and tests. Covers rate_limit, auth, permission (EACCES/ENOENT/ENOTDIR), crash, unknown. 13 tests, all pass.                                                                                                        |
| **E15** | **MISSING** | No subprocess retry loop in `provider.ts`. No `MAX_SUBPROCESS_RETRIES`, no `classifyHermesError` usage, no exponential backoff.                                                                                                                                                 |
| **E16** | **MISSING** | No `verifyHermesBinary()` function in `binary-resolver.ts`. Provider.ts does not call any pre-flight check. No `execFile` import.                                                                                                                                               |
| **E17** | **MISSING** | No duplicate-exit-event test in `event-bridge.test.ts`. The `terminalEmitted` flag exists in source but is not explicitly tested for duplicate prevention.                                                                                                                      |

## 4. Polish Audit Consistency

| Polish Issue                                                    | Status            | Notes                                                                                                                                                                    |
| --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SF-1** PiProvider failures                                    | N/A               | Outside Hermes scope.                                                                                                                                                    |
| **SF-2** mock.module() re-mock cache pollution                  | **STILL PRESENT** | `provider.test.ts` re-mocks `./binary-resolver` mid-test. `?t=` only busts target module cache, not dependencies. Currently passes by accident.                          |
| **SF-3** Unhandled promise rejection in `withFirstEventTimeout` | **STILL PRESENT** | `timeout-utils.ts` line 6: timer Promise is never cleaned up when generator wins race. Latent bug.                                                                       |
| **SF-4** All unknown errors retried                             | **STILL PRESENT** | `error-classifier.ts` line 82 returns `shouldRetry: true` for `'unknown'`. This will retry permission/fs errors that slip through (e.g., EPERM, EISDIR). Production bug. |
| **SF-5** verifyHermesBinary swallows errors                     | N/A               | Function does not exist yet.                                                                                                                                             |
| **BM-1** mockSpawn inferred as never                            | **FIXED**         | T1: explicit `: ChildProcess` return type added.                                                                                                                         |
| **BM-2** event-bridge.test.ts import order                      | **APPEARS OK**    | Mock is established before `bridgeHermesSession` import (lines 9-15).                                                                                                    |
| **BM-3** spyOn on re-imported module                            | **STILL PRESENT** | `binary-resolver.test.ts` line 46 uses `spyOn(resolver, 'fileExists')`. Fragile pattern.                                                                                 |
| **BM-4** Mock stdin silently ignores invalid JSON               | **STILL PRESENT** | `event-bridge.test.ts` line 151 silently swallows invalid JSON in catch block.                                                                                           |
| **TDF-1** verifyHermesBinary success path not tested            | N/A               | Function doesn't exist.                                                                                                                                                  |
| **TDF-2** Coverage misaligned                                   | N/A               | Coverage targets are reasonable for current state.                                                                                                                       |
| **TDF-3** Retry env var leak                                    | N/A               | Retry loop not implemented.                                                                                                                                              |
| **TDF-4** Abort signal tests don't verify cleanup               | **STILL PRESENT** | No assertions on `mock.kill` call count, signal arguments, or `sigkillTimeout` clearing.                                                                                 |
| **TDF-5** Verifier tasks weak                                   | N/A               | Process issue, not code issue.                                                                                                                                           |
| **Lint OOM**                                                    | CONFIRMED         | `bun run lint` OOMs on full repo. `bun x eslint packages/providers/` works. Documented in Polish Audit.                                                                  |

## 5. Code Quality Observations

### 5.1 Dead Code Still Present

`acp-bridge.ts` and `acp-bridge.test.ts` are not imported by any other hermes module. They duplicate logic already inlined into `event-bridge.ts`. Per fix plan E2 they must be deleted. Their continued presence:

- Confuses new developers (two bridge modules)
- Causes the test suite to run duplicate coverage
- Adds maintenance burden

### 5.2 Timeout Utils Not Wired In

`timeout-utils.ts` is a complete standalone utility with its own tests (3 pass). But `provider.ts` does not import or use it. The completion plan explicitly requires wiring it into the bridge call. Without this, the 20-minute hang risk the plan is designed to fix remains unmitigated.

### 5.3 Error Classifier Not Integrated

`error-classifier.ts` is complete and well-tested (13 pass). But:

- `provider.ts` does not import it
- `event-bridge.ts` does not use it
- The retry loop (E15) that would consume it is not implemented

This means the classifier is "ready but idle" — it will not affect any runtime behavior until E15 (subprocess retry loop) is implemented.

### 5.4 Magic Strings Still Used

Examples from `event-bridge.ts`:

- `'initialize'` (line 259)
- `'session/new'` (line 267)
- `'session/prompt'` (line 287)
- `'session/cancel'` (line 210)
- `'session/update'` (line 111)
- `'agent_message_chunk'` (line 114)
- `'agent_thought_chunk'` (line 119)

No constants exported from `acp-protocol.ts` yet.

### 5.5 Mutable `nextId` Race Condition

`acp-protocol.ts` line 36:

```typescript
let nextId = 1;
```

Still module-level mutable. The fix plan E10 requires replacing with a per-bridge `AcpIdGenerator`. This is a real race condition if two `bridgeHermesSession` calls run concurrently.

### 5.6 `sigkillTimeout` Timer Leak

`event-bridge.ts` lines 220-223 set a SIGKILL fallback timer. The `finally` block (line 340) clears it, but the `exit` handler (line 150) does **not** clear it on normal process exit. If the process exits normally after an abort signal has been received but before the 5s fallback fires, the timer remains active in the event loop.

### 5.7 SessionId Weak Validation

`event-bridge.ts` line 275:

```typescript
if (!sessionId) {
  throw new Error('Hermes ACP did not return a sessionId');
}
```

This catches `undefined`, `null`, and `''`, but does not validate `typeof sessionId === 'string' || sessionId.length === 0` per E8. A numeric `sessionId` (e.g. `42`) would pass this check and cause downstream type errors.

### 5.8 Untracked Files That Should Be Tracked

The four new files should be `git add`ed:

1. `packages/providers/src/hermes/error-classifier.ts`
2. `packages/providers/src/hermes/error-classifier.test.ts`
3. `packages/providers/src/hermes/timeout-utils.ts`
4. `packages/providers/src/hermes/timeout-utils.test.ts`

## 6. Summary — What Is Done vs What Remains

### Done (4/17)

- **E1** — Honest capability flags
- **E3** — process.env type safety
- **E14** — Error classifier (source + tests)
- **T1** — mockSpawn explicit return type

### Partial (2/17)

- **E11** — stderr enrichment (partial: only in non-zero exit handler)
- **E13** — First-event timeout (utility exists but not wired into provider)

### Missing/Broken (11/17)

- **E2** — Delete dead `acp-bridge.ts` + test
- **E4** — ACP request timeout in `sendRequest`
- **E5** — `createNotification` for `session/cancel`
- **E6** — Clear `sigkillTimeout` on normal exit
- **E7** — Runtime `SessionUpdateParams` validation
- **E8** — `sessionId` strict validation
- **E9** — Extract ACP method constants
- **E10** — Replace mutable `nextId`
- **E12** — `MAX_LINE_BUFFER_LENGTH`
- **E15** — Subprocess retry loop
- **E16** — Spawn pre-flight `verifyHermesBinary`
- **E17** — Duplicate-exit-event test

## 7. Critical Issues Requiring Immediate Attention

1. **E2 — Delete dead code** (`acp-bridge.ts` + `acp-bridge.test.ts`): Low risk, immediate cleanup.
2. **E13 wiring + timer cleanup**: The `withFirstEventTimeout` utility exists but is not used. Additionally the timer leak (unhandled Promise rejection) should be fixed before production use.
3. **E15 + E16**: Without retry loop and pre-flight check, transient spawn failures (EPIPE, EACCES) will surface directly to users instead of being retried or enriched.
4. **SF-4 in error-classifier**: Unknown errors default to `shouldRetry: true`. This should be `false` by default, with explicit opt-in for retryable patterns only.

---

_Audit completed 2026-04-27. All findings based on direct inspection of source, test execution, and git status._
