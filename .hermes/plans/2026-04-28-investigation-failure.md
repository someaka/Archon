# Investigation Report — Hermes Workflow Hang (CORRECTED 2026-04-28)

> Status: VERIFIED by 3 independent verifiers
> Previous report was WRONG. This replaces it entirely.

---

## Root Cause

`run_conversation()` hangs INSIDE the Hermes agent's Python code when 3 parallel
hermes acp processes simultaneously access the state.db SQLite database.

**Evidence chain:**

1. Smoke test works: single hermes acp process, 7.8s completion.
2. PR verifier hangs: 3 parallel hermes acp processes spawned. All 3 create
   sessions, receive prompts, NONE produce output.
3. Debug instrumentation proves execution reaches `_run_agent BEFORE run_conversation`
   but `run_conversation ENTRY` NEVER appears for any of the 3 processes.
4. state.db is 552MB with 286MB WAL file.
5. SessionDB.\_execute_write uses `BEGIN IMMEDIATE` with 15 retries and 20-150ms jitter.
6. `_build_system_prompt()` reads from state.db via `self._session_db.get_session()`
   at the entry of run_conversation().
7. With 3 concurrent processes all accessing the 552MB database, WAL reads are
   extremely slow or `BEGIN IMMEDIATE` write lock acquisition blocks indefinitely.

## Timeout Chain (NOT the cause, but relevant)

1. First-event timeout (provider.ts:111): 60s — fires, kills processes with SIGKILL
2. Node retry (dag-executor.ts:195): maxRetries=2, delayMs=3000
3. Total apparent hang: 3 attempts × 60s = ~180s before final failure
4. With 3 parallel nodes all retrying: max(180, 180, 180) = ~3 minutes of apparent hang

## Additional Bugs Found

### Bug 1: Session Pool stdout Handler Leak (event-bridge.ts)

bridgeHermesSession() registers a stdout 'data' handler at line 178 but NEVER
removes it in the finally block (lines 666-686). Handlers accumulate on pooled
sessions. Old handlers have stale closures (closed queue, undefined pendingRequestId).
Not the hang cause, but a memory leak.

### Bug 2: Session Pool Protocol Collision (provider.ts + session-pool.ts)

If multiple sendQuery() calls find the same pooled session (same cwd+provider+model),
they all create bridges on the SAME child process. Each bridge starts its own
idGenerator from 1. Three bridges writing session/prompt id=1 to the same stdin
= protocol collision. The child processes one, all 3 bridges resolve with the
same response. Data corruption, not a hang.

### Bug 3: available_commands_update Protocol Mismatch

Hermes ACP adapter sends `available_commands_update` session/update notifications
which Archon's event-bridge.ts logs as `acp.invalid_session_update`. Minor protocol
gap — logged and ignored, not a hang cause.

### Bug 4: stale .pyc Cache

Python .pyc cache (cpython-311 from 14:28) was stale vs source modified at 15:54.
Debug patches to run_agent.py weren't picked up by the runtime. Not a code bug,
but a debugging obstacle.

## Verified Correct (Not Bugs)

- DAG executor parallel handling: correct. nodeOutputs shared Map is read-only
  during concurrent execution, written only after Promise.allSettled.
- $scope.output substitution: works correctly for bash→prompt dependencies.
- context: fresh on review nodes: redundant (parallel layers always fresh), no impact.
- executor.ts import fix: correct. model-validation.ts deleted upstream, replaced
  with isRegisteredProvider/getRegisteredProviders from @archon/providers.
- withIdleTimeout: works correctly, resets on each chunk.
- withFirstEventTimeout: works correctly, covers only first yield.

## Recommended Fixes

1. **Immediate**: Vacuum state.db (`VACUUM;`) to reduce from 552MB
2. **Immediate**: Add `busy_timeout` PRAGMA to SQLite connection in hermes_state.py
3. **Architecture**: Consider serializing parallel Hermes prompt nodes instead of
   true parallelism — state.db contention with 3 concurrent writers is the bottleneck
4. **Code fix**: Add stdout handler cleanup in event-bridge.ts finally block
5. **Code fix**: Add per-request unique id offset in bridgeHermesSession to prevent
   id collision on shared child processes
6. **Investigate**: Why is state.db 552MB? Session/message accumulation needs cleanup.

## Key Files

| File                                           | Role                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| packages/providers/src/hermes/event-bridge.ts  | ACP bridge — stdout handler leak, id collision |
| packages/providers/src/hermes/provider.ts      | Session pool reuse logic                       |
| packages/providers/src/hermes/session-pool.ts  | Pool key: cwd+provider+model                   |
| packages/workflows/src/dag-executor.ts         | Parallel node execution (verified correct)     |
| packages/workflows/src/utils/idle-timeout.ts   | 30 min idle timeout (verified correct)         |
| packages/providers/src/hermes/timeout-utils.ts | First-event timeout (verified correct)         |
| ~/.hermes/hermes-agent/acp_adapter/server.py   | ACP server — run_conversation hang point       |
| ~/.hermes/hermes-agent/run_agent.py            | Agent entry — state.db contention              |
