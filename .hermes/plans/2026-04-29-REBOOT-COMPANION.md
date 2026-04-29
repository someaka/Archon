# COMPANION FILE — Full Context for Error Propagation Fix

> This file contains the complete context for the error propagation fix.
> Read this alongside the handoff file.

---

## The Problem (3 bugs found by debuggers)

### Bug 1: Retry Mechanism Never Fires

- event-bridge.ts:638-644 catches 300s timeout, encodes as RESULT CHUNK (isError: true)
- Provider.ts retry loop (lines 196-210) only catches THROWN exceptions
- Error silently consumed as yielded chunk — retry never fires

### Bug 2: 'rate_limit' Misclassification

- error-classifier.ts grouped 'timed out' with 'rate limit'
- A local 300s subprocess timeout ≠ API 429 rate limit
- Fixed: now 'timeout' is a separate error class

### Bug 3: No Cross-Process Rate Limit Coordination

- 3 independent hermes acp processes hit same xiaomi API simultaneously
- No global rate limiter for xiaomi
- Endpoint silently queues/deprioritizes parallel requests

---

## The Fix (Proposal C + A fail-fast)

### What 6 engineers agreed on (3 planners + 3 reviewers)

1. Bridge pushes `{ kind: 'error' }` for retryable errors (uses existing async-queue infrastructure)
2. Bridge also throws after consumer loop for ALL terminal errors (fail-fast)
3. Error result chunk is still yielded to consumers (for display)
4. Provider retry loop catches thrown exceptions and retries
5. Error classifier separates 'timeout' from 'rate_limit'
6. ConcurrencyLock maxConcurrency stays at 3

### Implementation (already applied to working tree)

**event-bridge.ts:**

- Added `terminalErrorMessage` tracking variable (line 159)
- `emitTerminal` captures error message when isError (lines 318-320)
- `buildTerminalError` returns `shouldRetry` (line 327, 337)
- Consumer loop `return` → `break` (line 670)
- Throw after finally block if terminal error (lines 702-706)

**error-classifier.ts:**

- Added 'timeout' to HermesErrorClass type union (line 2)
- 'timed out'/'timeout' → errorClass='timeout', shouldRetry=true (lines 98-105)
- 'rate limit'/'429' → errorClass='rate_limit', shouldRetry=true (lines 107-117)
- 'no output within' → errorClass='crash', shouldRetry=false (lines 88-95)

**provider.test.ts:**

- Stale assertion fixed: timeout → 'timeout' not 'rate_limit' (line 1405)
- Pool test updated: error2 expected, pool.size=0 (lines 1263-1292)
- Crash test updated for retry behavior (line 1417+)

---

## The 3 Failing Tests

```
ConcurrencyLock > ignores invalid ARCHON_HERMES_MAX_CONCURRENCY env var and defaults to 3
ConcurrencyLock > active and pending getters work correctly
ConcurrencyLock > constructors with negative maxConcurrency falls back to env or default (3)
```

These are in concurrency-lock.test.ts. They were updated for default=3 earlier in the session but the changes may have been partially overwritten by the executor.

**To fix:** Read concurrency-lock.test.ts, find the 3 failing tests, update assertions to match default maxConcurrency=3 behavior.

---

## Verification Commands

```bash
# 1. ConcurrencyLock tests
cd packages/providers && bun test src/hermes/concurrency-lock.test.ts --timeout 30000

# 2. Event-bridge tests (should already pass: 68/68)
cd packages/providers && bun test src/hermes/event-bridge.test.ts --timeout 60000

# 3. Provider tests (should already pass: 49/49)
cd packages/providers && bun test src/hermes/provider.test.ts --timeout 60000

# 4. Full hermes suite
cd packages/providers && bun test src/hermes/config.test.ts src/hermes/concurrency-lock.test.ts src/hermes/error-classifier.test.ts src/hermes/options-translator.test.ts src/hermes/timeout-utils.test.ts src/hermes/model-ref.test.ts src/hermes/session-pool.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts src/hermes/acp-client.test.ts src/hermes/binary-resolver.test.ts src/hermes/registration.test.ts src/hermes/session-resolver.test.ts src/hermes/hermes-mcp-reader.test.ts --timeout 60000

# 5. Full validate
cd /home/d/Desktop/Archon-canonical && bun run validate

# 6. E2E smoke
bun run cli workflow run e2e-hermes-smoke --no-worktree

# 7. Full PR verifier
bun run cli workflow run hermes-pr-verifier --no-worktree
```

---

## Commits Today (2026-04-29)

| Commit     | Repo         | What                                              |
| ---------- | ------------ | ------------------------------------------------- |
| `2d54bdc8` | Archon       | Fix test timeouts + enable parallel execution     |
| `58ce0d48` | Archon       | Respect context:fresh by bypassing session pool   |
| `1f19c680` | Archon       | Address all 10 adversarial review findings        |
| `020c1728` | hermes-agent | Context probe tiers 256K→1M, fix token estimation |

### Config Changes (not in repo)

- ~/.hermes/config.yaml: compression provider `auto` → `provider: google`

---

## GitHub Issue #1106 Status

**Title:** Hermes Agent integration

**Definition of Done (key items):**

- [x] HermesClient implements IAgentProvider interface
- [x] Client can start Hermes sessions and stream responses
- [x] Per-node provider/model overrides work
- [x] Abort/interrupt signal handling works
- [x] Unit tests for message streaming (318 tests)
- [x] Integration test: simple workflow with Hermes (e2e-hermes-smoke)
- [ ] E2E test in CI with mocked Hermes responses (pending)
- [x] Error propagation and retry mechanism (current fix)

---

## Key Architecture Notes

### Error Flow (after fix)

```
Bridge error → emitTerminal(error result chunk) → consumer yields it (display)
  → if terminalEmitted → throw new Error(terminalErrorMessage)
    → provider retry loop catches → classifyHermesError → retry if shouldRetry
```

### AsyncQueue Error Items

- `BridgeQueueItem` already defines `{ kind: 'error'; error: Error }` (async-queue.ts:78)
- Consumer loop handles it: `if (item.kind === 'error') throw item.error` (line 667)
- Currently NO code path pushes error items — this is the gap the fix addresses

### ConcurrencyLock

- Default maxConcurrency=3 (changed from 1 earlier in session)
- Configurable via ARCHON_HERMES_MAX_CONCURRENCY env var
- Capped at 32 (F-009 fix)
- NOT changed in this PR — stays at 3
