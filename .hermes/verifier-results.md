# VERIFIER RESULTS — 2026-04-30

All 3 providers ran sequentially. Hermes reviewed Pi code. Pi reviewed Hermes code. Claude smoke tested.

---

## 1. Hermes Provider Review of Pi Code

**Workflow:** `hermes-local-review` | **Duration:** ~60s | **Status:** ✅ SUCCESS

### Bugs / Correctness

1. **`process.env` mutation is permanent and process-wide** (provider.ts:171-182) — Runtime API keys injected into `process.env` are never cleaned up. In long-lived processes, stale keys persist across workflow runs.
2. **Duplicate step numbering** (provider.ts) — Comments use `0, 1, 2, 3, 4, 4a, 4b, 4c, 4d, 4e, 4f, 5, 6`.
3. **`custom<T>()` returns `undefined as unknown as T`** (ui-context-stub.ts:123-125) — Silent no-op for unsupported dialog types.
4. **`AsyncQueue.iterate()` uses `next !== undefined` guard** (async-queue.ts:60) — If `next()` resolves to `undefined`, the consumer exits early even if the queue isn't closed.
5. **`options-translator.ts` has static Pi SDK imports at module scope** — Violates the lazy-loading contract documented in provider.ts header.

### Security

6. **`ensurePiPackageDirShim` writes to deterministic tmpdir** (provider.ts:49-66) — Uses `/tmp/archon-pi-shim/package.json`, predictable path. Should use `mkdtemp`.
7. **Extension trust boundary is correct** — `enableExtensions` defaults to `false`. When enabled, runs attacker-controlled code from cloned repos. Well-documented.

### Style

8. `buildResultChunk` allocates a copy via `[...messages].reverse()` — could iterate backward.
9. `tryParseStructuredOutput` Tier 2 greedy parse — sound heuristic.
10. `noExtensions` vs `enableExtensions` naming flip — easy to misread.

---

## 2. Pi Provider Review of Hermes Code

**Workflow:** `pi-hermes-code-review` | **Duration:** ~24min | **Status:** ✅ SUCCESS

### event-bridge.ts

- **stdin error listener leak** — `stdinErrorHandler` declared but never assigned, so anonymous `stdin.once('error', …)` listeners on pooled sessions produce `MaxListenersExceededWarning`.
- **stdin drain listener leak** — `stdin.once('drain', …)` never removed by cleanup.
- **Unhandled rejection from fire-and-forget `executePrompt`** — `void executePrompt()` not protected; if abortSignal fires, `queue.close()` causes `emitTerminal` + `queue.push` to throw.
- **`activeTimers` leak on process death** — `rejectPending()` doesn't clear timeout timers; stale closures keep `activeTimers` Map alive.

### provider.ts

- **Lock held across retries and exponential backoff** — `this.lock.acquire()` wraps entire `sendQuery` including backoff sleeps. A retrying query holds the semaphore for 2+4+8=14s, starving other queries.
- **Unawaited generator cleanup races with pool hand-off** — `void clientInit.return(undefined)` fire-and-forget; bridge's `finally` may still be running when pool releases the session.

### concurrency-lock.ts

- **No bugs found.** Correct FIFO semaphore.

### session-pool.ts

- **`acquire()` hands out dead sessions** — Checks `inUse` but never `client.isAlive()`.
- **`release()` resurrects zombies** — Sets `inUse = false` unconditionally on dead sessions.
- **`get()` skews idle-timeout accounting** — Updates `lastUsed` without acquiring.

### acp-client.ts

- **Unhandled spawn errors** — `spawn()` in constructor attaches zero listeners. ENOENT before `init()` crashes Node.js.
- **No mutual exclusion between `init()` and `prompt()`** — Concurrent calls create overlapping generators on same stdio streams.
- **Missing `unref()` in constructor** — Discarded client keeps parent alive.
- **Dispose does not await bridge cleanup** — `void this._activeBridge.return(undefined)` fire-and-forget; `SIGKILL` races with cleanup.

---

## 3. Claude Smoke Test

**Workflow:** `e2e-claude-smoke` | **Duration:** 18.6s | **Status:** ✅ SUCCESS

- Binary resolved: `/home/d/.local/bin/claude` via autodetect
- Model: `deepseek-v4-pro:cloud` via Ollama gateway at `127.0.0.1:11434`
- Response: `4` (correct answer to "What is 2+2?")
- Assert: PASS
- No errors or warnings

---

## Summary

| Provider | Workflow                | Duration | Status | Bugs Found                  |
| -------- | ----------------------- | -------- | ------ | --------------------------- |
| Hermes   | `hermes-local-review`   | 60s      | ✅     | 7 bugs, 2 security, 3 style |
| Pi       | `pi-hermes-code-review` | 24min    | ✅     | 10 bugs, 5 architectural    |
| Claude   | `e2e-claude-smoke`      | 18.6s    | ✅     | 0 (smoke test only)         |
