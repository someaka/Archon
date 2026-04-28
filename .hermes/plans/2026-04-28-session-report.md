# Session Report — Hermes Provider Test Suite Work

> Date: 2026-04-28
> For: Context compression + verifier dispatch

---

## What Was Done

### Phase 1: Post-Review Fixes (from 3 general reviewers)

- Fixed CI test script: added 4 missing test files to Hermes batch in package.json
- Added registration.test.ts (5 tests for registerHermesProvider)
- Added protocol version mismatch test to event-bridge.test.ts
- Fixed stale registry.test.ts assertions (sessionResume/mcp were false, should be true)
- Wired globalAuth config to HERMES_USE_GLOBAL_AUTH env var in provider.ts
- Extended model-ref.ts doc comment for isHermesModelCompatible
- Result: 240 pass, 2 skip, 0 fail

### Phase 2: Pi Provider Fixes

- Fixed ui-context-stub theme proxy test (passthrough, not throw)
- Fixed config.ts enableExtensions default (removed unconditional false)
- Result: all Pi tests pass

### Phase 3: Provider Routing Fix (critical architectural change)

- **Root cause:** provider.ts temp HERMES_HOME only wrote `model` as flat string, dropping `provider` and `endpoint` from assistantConfig
- **Fix:** provider.ts now writes structured config (model.default, model.provider, model.base_url) when provider/endpoint available
- **Fix:** Pool key changed from `cwd\0model` to `cwd\0provider\0model` to prevent cross-provider session collisions
- **Fix:** session-pool.ts updated with optional provider parameter in makeKey/get/set/delete
- Result: provider routing works end-to-end

### Phase 4: Live Integration Tests

- Rewrote live-integration.test.ts with .env loading, cloud models, free models
- Ollama Cloud: `gemma4:31b-cloud` via `https://ollama.com/v1` with OLLAMA_API_KEY
- OpenRouter Free: `openrouter/free` with OPENROUTER_API_KEY
- Synced OpenRouter API key from bashrc to ~/.hermes/.env
- Added content verification (response text length > 0)
- Result: both live tests pass

### Phase 5: Test Gap Fixes (from cross-provider verifier)

- Added error classification + retry behavior tests (5 tests)
- Added resume failure fallback tests (2 tests)
- Added env override priority tests (3 tests)
- Added timeout error preservation test (1 test)
- Added stderr in error messages tests (2 tests)
- Added ACP isError propagation — CODE FIX in event-bridge.ts (2 tests)
- Added skipInit resume options verification test (1 test)
- Result: 257 unit tests pass, 2 live tests pass (with --timeout 300000)

---

## Current State

### Test Counts

```
provider.test.ts:        ~40 tests (was ~27)
event-bridge.test.ts:    ~63 tests (was ~54)
session-pool.test.ts:    11 tests
acp-protocol.test.ts:    ~26 tests
config.test.ts:          16 tests
model-ref.test.ts:       ~18 tests
options-translator.test.ts: ~15 tests
session-resolver.test.ts: 11 tests
error-classifier.test.ts: ~22 tests
hermes-mcp-reader.test.ts: ~13 tests
binary-resolver.test.ts: 10 tests
timeout-utils.test.ts:   3 tests
registration.test.ts:    5 tests
live-integration.test.ts: 2 tests
─────────────────────────────────
TOTAL:                   ~259 tests
```

### Files Modified (this session)

```
packages/providers/package.json                    — CI test batch
packages/providers/src/registry.test.ts            — stale assertions fixed
packages/providers/src/hermes/provider.ts          — structured config + pool key + globalAuth
packages/providers/src/hermes/session-pool.ts      — provider parameter in pool methods
packages/providers/src/hermes/event-bridge.ts      — isError propagation fix
packages/providers/src/hermes/model-ref.ts         — doc comment extended
packages/providers/src/hermes/provider.test.ts     — +13 tests
packages/providers/src/hermes/event-bridge.test.ts — +6 tests
packages/providers/src/hermes/live-integration.test.ts — full rewrite + content verification
packages/providers/src/hermes/registration.test.ts — new file, 5 tests
packages/providers/src/community/pi/config.ts      — enableExtensions default removed
packages/providers/src/community/pi/config.test.ts — expectations updated
packages/providers/src/community/pi/ui-context-stub.test.ts — theme proxy test fixed
```

### Known Issue: Live Test Timeout in Batch Run

- Live tests PASS standalone: 18s total (7s + 11s)
- Live tests FAIL in full batch (`bun test src/hermes/`): timeout at exactly 60s each
- Unit tests pass fine in batch (257 pass)
- The `{ timeout: 300_000 }` per-test option seems ignored in batch mode
- `--timeout 300000` CLI flag works as workaround
- **For verifier:** Check if bun:test has a known issue with per-test timeout in batch mode. Check if the describe.skip conditional affects timeout inheritance. Check if there's a cumulative test suite timeout.

### Code Fix: isError Propagation

- event-bridge.ts was silently dropping the ACP server's `isError` field from prompt responses
- Now correctly propagates `isError: true` to the result chunk when the ACP server reports it
- This is a real bug fix, not just a test addition

---

## Gaps Still Open (from cross-provider verifier)

| Gap                          | Status | Priority |
| ---------------------------- | ------ | -------- |
| Error classification + retry | CLOSED | —        |
| Timeout error preservation   | CLOSED | —        |
| Resume failure fallback      | CLOSED | —        |
| stderr in error messages     | CLOSED | —        |
| ACP is_error propagation     | CLOSED | —        |
| Warning dedup across retries | OPEN   | LOW      |
| Env override priority        | CLOSED | —        |
| Resume options verification  | CLOSED | —        |
| Tool edge cases              | OPEN   | LOW      |
| Model error guidance         | OPEN   | LOW      |
| Exit code in tool output     | OPEN   | LOW      |

4 LOW priority gaps remain. All CRITICAL/HIGH gaps are closed.

---

## Issue #1106 Closure Status

| Work Stream                                | Status                           |
| ------------------------------------------ | -------------------------------- |
| Provider implementation                    | DONE                             |
| Provider routing (model+provider+endpoint) | DONE                             |
| CI test coverage                           | DONE                             |
| Live integration tests                     | DONE                             |
| Test gap coverage                          | DONE (all critical/high)         |
| CLI setup wizard                           | NOT STARTED (packages/cli/)      |
| Documentation                              | NOT STARTED (packages/docs-web/) |
| Cross-package integration tests            | NOT STARTED                      |
| Nice-to-haves (Web UI, benchmarks)         | NOT STARTED                      |

---

## For Verifiers to Check

1. **Live test timeout issue** — Why do tests fail at 60s default when actual execution is 28s/9s? Is bun:test ignoring the per-test `{ timeout: 300_000 }` option?

2. **isError propagation correctness** — Is the event-bridge.ts change correct? Does it match the ACP spec? Could it break existing behavior?

3. **Pool key change backward compatibility** — Does `cwd\0\0model` (empty provider) match the old `cwd\0model` behavior? Are there any callers that assume the old key format?

4. **Structured config YAML shape** — Does the Hermes CLI correctly parse `model: { default: ..., provider: ..., base_url: ... }` when written by Bun.YAML.stringify?

5. **Test isolation** — Do the new provider.test.ts tests properly clean up process.env overrides?
