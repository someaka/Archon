# Hermes Provider — Master Polish Plan (MERGED)

> Merged from three independent planners + editorial polish.
> Execution: 3 parallel batches → gate → done.

---

## Execution Map

```
┌─────────────────────────────────────────────────────────────────────┐
│ BATCH P1: SOURCE FIXES (3 parallel executors)                       │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ Exec P1.1    │  │ Exec P1.2    │  │ Exec P1.3    │             │
│  │ provider.ts  │  │ event-bridge │  │ session-pool │             │
│  │ session-res  │  │ acp-protocol │  │ session-res  │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
│         └──────────────────┼──────────────────┘                     │
│                            ▼                                        │
│                    ┌──────────────┐                                 │
│                    │  GATE P1     │  ← BLOCKING                    │
│                    └──────┬───────┘                                 │
│                           ▼                                         │
├─────────────────────────────────────────────────────────────────────┤
│ BATCH P2: TEST IMPROVEMENTS (3 parallel executors)                  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ Exec P2.1    │  │ Exec P2.2    │  │ Exec P2.3    │             │
│  │ provider     │  │ event-bridge │  │ pool+proto   │             │
│  │ tests        │  │ tests        │  │ tests        │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
│         └──────────────────┼──────────────────┘                     │
│                            ▼                                        │
│                    ┌──────────────┐                                 │
│                    │  GATE P2     │  ← BLOCKING                    │
│                    └──────┬───────┘                                 │
│                           ▼                                         │
├─────────────────────────────────────────────────────────────────────┤
│ FINAL GATE — full validation                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## BATCH P1: Source Fixes

### Exec P1.1 — provider.ts + session-resolver.ts

**Files:** provider.ts, session-resolver.ts
**Parallel:** YES (touches only these files)

**Changes:**

1. **C1: YAML injection fix** (provider.ts:206-211)
   - Replace manual string escaping with `Bun.YAML.stringify({ model: options.model })`
   - Already used in config-loader.ts and api.ts — zero new deps

2. **C2: Make session pool injectable** (provider.ts:26-39, 86)
   - Rename `sessionPool` → `defaultSessionPool`
   - Add guard against duplicate signal handler registration
   - Add constructor: `constructor(pool?: HermesSessionPool)` with `this.pool = pool ?? defaultSessionPool`
   - Replace all `sessionPool.X()` → `this.pool.X()` (lines 143, 176, 189, 327)

3. **I3: Extract trySymlink helper** (provider.ts:213-239)
   - Add `function trySymlink(source: string, dest: string): void`
   - Replace 3 identical existsSync+symlinkSync blocks with 3 one-liner calls

4. **I4: Extract cleanupTempDir helper** (provider.ts:247-253, 337-343, 352-358)
   - Add `function cleanupTempDir(dir?: string): void`
   - Replace 3 identical rmSync blocks

5. **I5: Update stale comments** (session-resolver.ts:1-8, 14-17, 22-23, 36-42, 80-82)
   - Module docstring: remove "stateless per invocation", mention session pool
   - Interface docstring: remove "single invocation"
   - sessionId docstring: remove "always undefined"
   - Function docstring: remove "Hermes ACP is stateless by design"
   - Line 80-82: update comment, keep `void resumeSessionId`

6. **Wire error-classifier** (provider.ts)
   - Import `classifyHermesError` from `./error-classifier`
   - No changes to provider.ts for this — the bridge handles it (P1.2)

**Verification:**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -10
bun run type-check 2>&1 | tail -5
```

---

### Exec P1.2 — event-bridge.ts + acp-protocol.ts

**Files:** event-bridge.ts, acp-protocol.ts
**Parallel:** YES (touches only these files)

**Changes:**

1. **C3: Safe type guards** (event-bridge.ts, add after imports ~line 45)
   - Add `assertJsonRpcError(err: unknown): { code: number; message: string }`
     - Returns `{ code: -1, message: String(err) }` for malformed input
   - Add `assertObjectResult(result: unknown): Record<string, unknown> | undefined`
     - Returns undefined for null/undefined, throws for non-objects
   - Replace all 10 unsafe `as` casts:
     - Lines 428, 483, 521: `assertJsonRpcError()`
     - Lines 433, 435, 445, 487, 525-526: `assertObjectResult()`

2. **C4: Fix stdin listener leak** (event-bridge.ts:373-409)
   - Hoist `let stdinErrorHandler` to outer scope (alongside `pendingRequestId`)
   - Store handler reference when registering: `stdinErrorHandler = (err) => { ... }`
   - Remove in 3 places: stdout response routing, timeout handler, `rejectPending()`

3. **C5: Wire error-classifier + deduplicate errors** (event-bridge.ts)
   - Import `classifyHermesError` from `./error-classifier`
   - Add `buildTerminalError(baseMessage, context?)` helper:
     - Builds errors array with stderr suffix
     - Calls `classifyHermesError()` to get `errorClass`
     - Returns `{ errors, errorSubtype }`
   - Replace exit handler (lines 276-283): use `buildTerminalError`
   - Replace error handler (lines 300-313): use `buildTerminalError`
   - Replace abort handler (lines 349-358): use `buildTerminalError`
   - Replace catch block (lines 555-562): use `buildTerminalError`
   - Add `errorSubtype` to all terminal result emissions

4. **I6: Fix double-cast** (event-bridge.ts:232-234)
   - Replace `(update as unknown as Record<string, unknown>).sessionUpdate`
   - With: `(update as { sessionUpdate?: string }).sessionUpdate`

5. **I10/I11: Document magic numbers** (event-bridge.ts:49-51)
   - Add timeout hierarchy doc comment block before constants
   - Document REQUEST_TIMEOUT_MS (30s), PROMPT_TIMEOUT_MS (5min), SIGKILL fallback (5s)
   - Document MAX_LINE_BUFFER_LENGTH (1 MiB)

6. **I14: Add TODO comment** (acp-protocol.ts:239)
   - `// TODO(#acp-usage-update): Add UsageUpdate to SessionUpdateUnion when ACP spec stabilizes`

7. **I15: Document backpressure** (event-bridge.ts:391-396)
   - Add comment explaining why we don't reject on `write() === false`

**Verification:**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10
bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -5
bun run type-check 2>&1 | tail -5
```

---

### Exec P1.3 — session-pool.ts fix

**Files:** session-pool.ts
**Parallel:** YES (touches only this file)

**Changes:**

1. **Fix: set() kills old session on overwrite** (session-pool.ts:49-54)

   ```typescript
   set(cwd: string, model: string, session: PooledSession): void {
     const key = this.makeKey(cwd, model);
     const existing = this.sessions.get(key);
     if (existing) {
       this.killSession(existing);  // Kill old process to prevent zombie
     }
     session.childProcess.unref();
     this.sessions.set(key, session);
   }
   ```

2. **I9: Add debug log to killSession catch** (session-pool.ts:65-71)
   - `catch (err) { /* process may already be dead — EPERM possible */ }`

3. **I13: Comment null byte separator** (session-pool.ts:37)
   - `// Null byte separator — safe because neither cwd nor model can contain null bytes.`

**Verification:**

```bash
bun test packages/providers/src/hermes/session-pool.test.ts 2>&1 | tail -5
bun run type-check 2>&1 | tail -5
```

---

### Gate P1 — Verifier

**Blocking:** YES

```
STEP 0: pwd — verify /home/d/Desktop/Archon-canonical
STEP 1: bun run type-check 2>&1 | tail -5
STEP 2: bun test packages/providers/src/hermes/ 2>&1 | tail -10
STEP 3: Read provider.ts — verify: Bun.YAML.stringify, constructor(pool?), trySymlink, cleanupTempDir
STEP 4: Read event-bridge.ts — verify: assertJsonRpcError, assertObjectResult, buildTerminalError, stdinErrorHandler hoisted
STEP 5: Read session-pool.ts — verify: set() kills old session, null byte comment
STEP 6: Read session-resolver.ts — verify: updated docstrings, no "stateless per invocation"
STEP 7: Read acp-protocol.ts — verify: TODO comment on SessionUpdateUnion
STEP 8: grep -n 'errorSubtype' event-bridge.ts — verify present in all error paths
STEP 9: grep -n 'assertJsonRpcError\|assertObjectResult' event-bridge.ts — verify replaces all `as` casts
STEP 10: git log --oneline -5 — verify commits

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## BATCH P2: Test Improvements

### Exec P2.1 — provider.test.ts additions

**File:** provider.test.ts
**Parallel:** YES (touches only this file)

**New tests:**

1. **Multi-turn reuse** — `sendQuery reuses pooled session on second call`
   - Track session/new count (should be 1)
   - Track mockSpawn calls (should be 1)
   - Both calls return valid chunks

2. **Temp cleanup on failure** — `cleans up temp HERMES_HOME when query fails`
   - Mock session/prompt to return JSON-RPC error
   - Verify no orphaned hermes-archon-\* dirs

3. **YAML injection** — `sendQuery escapes model with quotes and newlines`
   - Model: `test"model\ninjection`
   - Verify query completes without YAML parse error

4. **Usage tracking through provider** — `sendQuery returns token usage in result chunk`
   - Mock ACP returns PromptResponse with usage data
   - Verify result chunk has `tokens` field

5. **MCP passthrough** — `sendQuery passes MCP servers to session/new`
   - Mock readHermesMcpConfig to return non-empty array
   - Intercept stdin to verify session/new includes mcpServers

**Verification:**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -10
```

---

### Exec P2.2 — event-bridge.test.ts additions

**File:** event-bridge.test.ts
**Parallel:** YES (touches only this file)

**New tests:**

1. **skipInit mode** — `skipInit sends only session/prompt, not initialize or session/new`
   - Track stdin writes
   - Verify methods contain 'session/prompt' but NOT 'initialize' or 'session/new'

2. **skipInit with missing sessionId** — `skipInit without existingSessionId throws`
   - Verify error message

3. **skipInit no close/SIGKILL** — `skipInit mode does not send session/close or kill process`
   - Verify no session/close in writes
   - Verify process not killed

4. **redactSecrets edge case** — `redacts secret at end of line with no trailing content`

5. **errorSubtype on crash** — `error result chunk includes errorSubtype for non-zero exit`
   - Mock process exits with code 1
   - Verify result chunk has errorSubtype: 'crash'

6. **errorSubtype on abort** — `error result chunk includes errorSubtype for abort`
   - Abort the query
   - Verify errorSubtype: 'abort'

**Verification:**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10
```

---

### Exec P2.3 — session-pool.test.ts + acp-protocol.test.ts + hermes-mcp-reader.test.ts

**Files:** session-pool.test.ts, acp-protocol.test.ts, hermes-mcp-reader.test.ts
**Parallel:** YES (touches only these files)

**Changes:**

1. **Convert session-pool.test.ts from vitest to bun:test**
   - `import { vi } from 'vitest'` → `import { mock } from 'bun:test'`
   - `vi.fn()` → `mock(() => value)`

2. **New test: delete non-existent key** (session-pool.test.ts)
   - `expect(() => pool.delete('/nonexistent', 'model')).not.toThrow()`

3. **New test: set overwrites and kills old** (session-pool.test.ts)
   - Set same key twice, verify old process killed

4. **New test: cleanup timer kills only idle** (session-pool.test.ts)
   - Two sessions, keep one active via get()
   - Wait for idle timeout + cleanup cycle
   - Verify only idle one killed

5. **New test: parseMessage complex payload** (acp-protocol.test.ts)
   - Deeply nested result with capabilities, authMethods
   - 100KB string payload

6. **New test: env values with '='** (hermes-mcp-reader.test.ts)
   - `KEY: "value=with=equals"` → verify `KEY=value=with=equals` in output

**Verification:**

```bash
bun test packages/providers/src/hermes/session-pool.test.ts 2>&1 | tail -5
bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -5
bun test packages/providers/src/hermes/hermes-mcp-reader.test.ts 2>&1 | tail -5
```

---

### Gate P2 — Verifier

**Blocking:** YES

```
STEP 0: pwd — verify /home/d/Desktop/Archon-canonical
STEP 1: bun test packages/providers/src/hermes/ 2>&1 | tail -15
STEP 2: bun run type-check 2>&1 | tail -5
STEP 3: bun run lint 2>&1 | tail -5
STEP 4: grep -c 'test(' packages/providers/src/hermes/provider.test.ts — verify new tests
STEP 5: grep -c 'test(' packages/providers/src/hermes/event-bridge.test.ts — verify new tests
STEP 6: grep -c 'test(' packages/providers/src/hermes/session-pool.test.ts — verify new tests
STEP 7: Read session-pool.test.ts — verify bun:test imports (not vitest)
STEP 8: git log --oneline -15 — verify all commits
STEP 9: git status — clean

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Final Gate — Verifier

```
STEP 0: pwd — verify /home/d/Desktop/Archon-canonical
STEP 1: bun run type-check 2>&1 | tail -5
STEP 2: bun test packages/providers/src/hermes/ 2>&1 | tail -15
STEP 3: bun run lint 2>&1 | tail -5
STEP 4: Read capabilities.ts — verify sessionResume: true, mcp: true
STEP 5: Read provider.ts — verify: constructor(pool?), trySymlink, cleanupTempDir, Bun.YAML.stringify
STEP 6: Read event-bridge.ts — verify: assertJsonRpcError, assertObjectResult, buildTerminalError, errorSubtype
STEP 7: Read session-pool.ts — verify: set() kills old session
STEP 8: Read session-resolver.ts — verify: updated docstrings
STEP 9: grep -c 'errorSubtype' event-bridge.ts — verify >= 4
STEP 10: git log --oneline -20
STEP 11: git status — clean

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Summary

| Category               | Count  | Status        |
| ---------------------- | ------ | ------------- |
| Critical fixes (C1-C5) | 5      | All addressed |
| Polish items (I1-I15)  | 15     | All addressed |
| Test gaps (T1-T12)     | 12     | All addressed |
| Integration gaps (1-8) | 8      | All addressed |
| **Total changes**      | **40** |               |

**Source changes:** ~80 lines added (guards + helpers), ~50 lines removed (dedup)
**Test changes:** ~15 new tests, 1 framework conversion
**Net test count:** ~90 → ~105 tests
