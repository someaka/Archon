# Hermes Agent Full Integration — Phase 3 Master Plan (EXECUTION-READY)

> **For Hermes:** Load `archon-hermes-methodology` skill. This plan follows that methodology exactly.

**Goal:** Lift all three remaining capability limitations — usage tracking, MCP server passthrough, and multi-turn session persistence.

**Merge order:** 3A → 3B → 3C (all three planners agree — no conflicts if executed in this order).

---

## Execution Map (visual)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3A: USAGE TRACKING                                                                    │
│                                                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                                                  │
│  │ Exec 3A.1│  │ Exec 3A.2│  │ Exec 3A.3│   ← PARALLEL (different files)                   │
│  │ acp-proto│  │ evt-bridge│  │ tests    │                                                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                                                  │
│       │              │              │                                                        │
│       └──────────────┼──────────────┘                                                        │
│                      ▼                                                                       │
│              ┌──────────────┐                                                                │
│              │  GATE 3A     │  ← BLOCKING (must be GREEN before 3B starts)                  │
│              │  1 verifier  │                                                                │
│              └──────┬───────┘                                                                │
│                     ▼                                                                        │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 3B: MCP PASSTHROUGH                                                                   │
│                                                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                                                  │
│  │ Exec 3B.1│  │ Exec 3B.2│  │ Exec 3B.3│   ← PARALLEL (different files)                   │
│  │ evt-bridge│  │ new file │  │ provider │                                                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                                                  │
│       │              │              │                                                        │
│       └──────────────┼──────────────┘                                                        │
│                      ▼                                                                       │
│              ┌──────────────┐                                                                │
│              │  GATE 3B     │  ← BLOCKING (must be GREEN before 3C starts)                  │
│              │  1 verifier  │                                                                │
│              └──────┬───────┘                                                                │
│                     ▼                                                                        │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 3C: MULTI-TURN SESSIONS                                                               │
│                                                                                              │
│  ┌──────────┐             ┌──────────┐                                                      │
│  │ Exec 3C.1│             │ Exec 3C.3│                                                      │
│  │ new file │             │ provider │   ← BLOCKING: 3C.3 waits for 3C.1                   │
│  │ pool.ts  │             │ integrate│     (provider.ts imports SessionPool)                │
│  └────┬─────┘             └────┬─────┘                                                      │
│       │    ┌──────────┐        │                                                            │
│       │    │ Exec 3C.2│        │        ← PARALLEL with 3C.1 (different file)              │
│       │    │ evt-bridge│       │                                                            │
│       │    └────┬─────┘        │                                                            │
│       │         │              │                                                            │
│       └─────────┼──────────────┘                                                            │
│                 ▼                                                                            │
│         ┌──────────────┐                                                                    │
│         │  GATE 3C     │  ← BLOCKING                                                      │
│         │  1 verifier  │                                                                    │
│         └──────┬───────┘                                                                    │
│                ▼                                                                             │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ FINAL GATE                                                                                  │
│  1 verifier — full validation (type-check, all tests, all commits, capabilities check)     │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Task Specifications

### PHASE 3A: Usage Tracking

---

#### Task 3A.1 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — touches only `acp-protocol.ts`

**Blocks:** Nothing (can run alongside 3A.2, 3A.3)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- File: `packages/providers/src/hermes/acp-protocol.ts`
- Read the file first. Find the `UsageUpdate` interface (around line 222).
- After it, add `PromptResponseUsage` interface (see Phase 3A Task 3A.1 in research deliverable)
- Do NOT add it to `SessionUpdateUnion`
- Run: `bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -10`
- Run: `bun run type-check 2>&1 | tail -5`
- Commit: `feat(hermes): add PromptResponseUsage type for per-turn token tracking`

**Verification gate step:** Gate 3A checks `PromptResponseUsage` exists in acp-protocol.ts

---

#### Task 3A.2 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — touches only `event-bridge.ts`

**Blocks:** Nothing (can run alongside 3A.1, 3A.3)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- File: `packages/providers/src/hermes/event-bridge.ts`
- Read the file. Find the PromptResponse handler (around lines 490-499).
- Add `normalizeAcpUsage()` exported function (see research deliverable /tmp/research-usage.md)
- Import `PromptResponseUsage` from `./acp-protocol`
- Extract `usage` from `parsed.result` and spread into terminal result chunk
- Update `emitTerminal` to accept optional tokens parameter
- Run: `bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10`
- Commit: `feat(hermes): extract token usage from ACP PromptResponse`

**Dependency note:** If 3A.1 hasn't committed `PromptResponseUsage` yet, this executor will fail on import. Safe to run in parallel — Bun resolves types at test time, not compile time. If it fails, re-dispatch after 3A.1 completes.

---

#### Task 3A.3 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — touches only `event-bridge.test.ts`

**Blocks:** Nothing (can run alongside 3A.1, 3A.2)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- File: `packages/providers/src/hermes/event-bridge.test.ts`
- Read the file. Find `createAcpMock` function.
- Add `usage` option to mock PromptResponse
- Add tests: normalizeAcpUsage (3 unit), PromptResponse with usage (2 integration)
- Run: `bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10`
- Commit: `test(hermes): add usage extraction tests`

---

#### Gate 3A — VERIFIER

**Verifier:** `delegate_task` with `toolsets: ['terminal', 'file']`

**Blocking:** YES — must be GREEN before Phase 3B starts

**Parallel:** NO — single verifier

**Context to provide:**

```
You are a verifier. Working directory: /home/d/Desktop/Archon-canonical
You did NOT implement any of these tasks.

STEP 0: pwd — verify /home/d/Desktop/Archon-canonical
STEP 1: bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -5
STEP 2: bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10
STEP 3: bun run type-check 2>&1 | tail -5
STEP 4: Read acp-protocol.ts — verify PromptResponseUsage interface exists with inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens
STEP 5: Read event-bridge.ts — verify normalizeAcpUsage is exported, usage extracted from PromptResponse.result.usage, spread into terminal result chunk
STEP 6: grep -n "normalizeAcpUsage\|PromptResponseUsage\|result.usage" packages/providers/src/hermes/event-bridge.ts

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

### PHASE 3B: MCP Server Passthrough

---

#### Task 3B.1 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — touches only `event-bridge.ts` (different section than 3A.2)

**Blocks:** Nothing within Phase 3B

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- File: `packages/providers/src/hermes/event-bridge.ts`
- Read the file. Find `BridgeOptions` interface.
- Add `AcpMcpServer` interface near top (after imports)
- Add `mcpServers?: AcpMcpServer[]` to BridgeOptions
- Change hardcoded `mcpServers: []` in session/new to `mcpServers: options.mcpServers ?? []`
- Commit: `feat(hermes): add mcpServers to BridgeOptions for session/new passthrough`

---

#### Task 3B.2 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — creates NEW file `hermes-mcp-reader.ts` + test file

**Blocks:** Task 3B.3 (provider.ts imports from this file)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- Create: `packages/providers/src/hermes/hermes-mcp-reader.ts` (see research deliverable /tmp/research-mcp.md)
- Create: `packages/providers/src/hermes/hermes-mcp-reader.test.ts`
- Use `Bun.YAML.parse()` (Bun built-in, no new dependency needed)
- Read `~/.hermes/config.yaml` → extract `mcp_servers` → convert to ACP format
- Handle: disabled servers (skip), HTTP servers (skip + warn), env object→array conversion
- Run: `bun test packages/providers/src/hermes/hermes-mcp-reader.test.ts 2>&1 | tail -10`
- Commit: `feat(hermes): add MCP config reader for Hermes config.yaml`

---

#### Task 3B.3 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** NO — BLOCKS on 3B.2 (imports `readHermesMcpConfig` from new file)

**Blocks:** Gate 3B

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- Files: `packages/providers/src/hermes/provider.ts`, `packages/providers/src/hermes/capabilities.ts`
- In provider.ts: import `readHermesMcpConfig`, call it with `tempHermesHome`, pass result to bridge options
- In capabilities.ts: change `mcp: false` to `mcp: true`
- Run: `bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -5`
- Run: `bun run type-check 2>&1 | tail -5`
- Commit: `feat(hermes): wire MCP config into provider and enable capability`

---

#### Gate 3B — VERIFIER

**Verifier:** `delegate_task` with `toolsets: ['terminal', 'file']`

**Blocking:** YES — must be GREEN before Phase 3C starts

**Context to provide:**

```
You are a verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location
STEP 1: bun test packages/providers/src/hermes/hermes-mcp-reader.test.ts 2>&1 | tail -10
STEP 2: bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -5
STEP 3: bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -5
STEP 4: bun run type-check 2>&1 | tail -5
STEP 5: Read capabilities.ts — verify mcp: true
STEP 6: Read event-bridge.ts — verify mcpServers in BridgeOptions and passed to session/new
STEP 7: Read hermes-mcp-reader.ts — verify reads config.yaml mcp_servers, skips disabled/HTTP

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

### PHASE 3C: Multi-Turn Session Persistence

---

#### Task 3C.1 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — creates NEW file `session-pool.ts` + test file

**Blocks:** Task 3C.3 (provider.ts imports SessionPool)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- Create: `packages/providers/src/hermes/session-pool.ts` (see research deliverable /tmp/research-multiturn.md)
- Create: `packages/providers/src/hermes/session-pool.test.ts`
- SessionPool class: Map keyed by `cwd\0model`, idle timeout 5min, max age 30min, process exit detection, destroy() for cleanup, unref() on timer and child processes
- Tests: get/set, idle cleanup, process exit detection, destroy
- Run: `bun test packages/providers/src/hermes/session-pool.test.ts 2>&1 | tail -10`
- Commit: `feat(hermes): add SessionPool for multi-turn session persistence`

---

#### Task 3C.2 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** YES — touches `event-bridge.ts` (different section than 3A/3B)

**Blocks:** Task 3C.3 (provider.ts needs skipInit mode)

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- File: `packages/providers/src/hermes/event-bridge.ts`
- Add to BridgeOptions: `skipInit?: boolean`, `existingSessionId?: string`
- In bridge logic: when `skipInit` is true, skip initialize/session/new/session/close, use `existingSessionId` for session/prompt, don't SIGKILL the process
- Run: `bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10`
- Commit: `feat(hermes): add prompt-only mode to event-bridge for session reuse`

---

#### Task 3C.3 — EXECUTOR

**Executor:** `delegate_task` with `toolsets: ['file', 'terminal']`

**Parallel:** NO — BLOCKS on 3C.1 (imports SessionPool) and 3C.2 (needs skipInit mode)

**Blocks:** Gate 3C

**Context to provide:**

- Working directory: `/home/d/Desktop/Archon-canonical`
- Files: `provider.ts`, `capabilities.ts`, `acp-protocol.ts`
- Import SessionPool, create singleton pool
- In sendQuery(): check pool for existing session → if found, use prompt-only mode with skipInit → if not found, do full init and add to pool
- Don't SIGKILL pooled processes — let pool manage lifecycle
- Add process.on('exit') and process.on('SIGTERM') for pool.destroy()
- In capabilities.ts: `sessionResume: true`
- In acp-protocol.ts: add `sessionLoad: 'session/load'` to ACP_METHODS
- Run: `bun test packages/providers/src/hermes/ 2>&1 | tail -10`
- Run: `bun run type-check 2>&1 | tail -5`
- Commit: `feat(hermes): integrate session pool for multi-turn persistence`

---

#### Gate 3C — VERIFIER

**Verifier:** `delegate_task` with `toolsets: ['terminal', 'file']`

**Blocking:** YES — must be GREEN before Final Gate

**Context to provide:**

```
You are a verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location
STEP 1: bun test packages/providers/src/hermes/session-pool.test.ts 2>&1 | tail -10
STEP 2: bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -10
STEP 3: bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -10
STEP 4: bun run type-check 2>&1 | tail -5
STEP 5: Read capabilities.ts — verify sessionResume: true, mcp: true
STEP 6: Read provider.ts — verify SessionPool integration, no SIGKILL on pooled sessions
STEP 7: Read session-pool.ts — verify idle timeout, cleanup, destroy, unref
STEP 8: Read event-bridge.ts — verify skipInit mode exists, mcpServers in BridgeOptions
STEP 9: grep -n "SessionPool\|sessionPool\|skipInit\|normalizeAcpUsage\|mcpServers" provider.ts

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

### Final Gate — VERIFIER

**Verifier:** `delegate_task` with `toolsets: ['terminal', 'file']`

**Blocking:** YES — this is the last gate

**Context to provide:**

```
You are the final verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location
STEP 1: bun run type-check 2>&1 | tail -5
STEP 2: bun test packages/providers/src/hermes/ 2>&1 | tail -10
STEP 3: bun test packages/workflows/src/dag-executor.test.ts 2>&1 | tail -5
STEP 4: bun run lint 2>&1 | tail -5
STEP 5: git log --oneline -25 — verify all Phase 3 commits present
STEP 6: Read capabilities.ts — verify sessionResume: true, mcp: true
STEP 7: Verify usage tracking: grep "normalizeAcpUsage\|PromptResponseUsage" event-bridge.ts
STEP 8: Verify MCP: grep "mcpServers\|readHermesMcpConfig" provider.ts event-bridge.ts
STEP 9: Verify multi-turn: grep "SessionPool\|skipInit" provider.ts event-bridge.ts
STEP 10: git status — clean or plan files only

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Dependency Matrix

| Task       | Parallel With | Blocks      | Blocked By       |
| ---------- | ------------- | ----------- | ---------------- |
| 3A.1       | 3A.2, 3A.3    | 3A.2 (soft) | —                |
| 3A.2       | 3A.1, 3A.3    | Gate 3A     | 3A.1 (soft)      |
| 3A.3       | 3A.1, 3A.2    | Gate 3A     | —                |
| Gate 3A    | —             | 3B.1        | 3A.1, 3A.2, 3A.3 |
| 3B.1       | 3B.2          | Gate 3B     | Gate 3A          |
| 3B.2       | 3B.1          | 3B.3        | Gate 3A          |
| 3B.3       | —             | Gate 3B     | 3B.2             |
| Gate 3B    | —             | 3C.1        | 3B.1, 3B.2, 3B.3 |
| 3C.1       | 3C.2          | 3C.3        | Gate 3B          |
| 3C.2       | 3C.1          | 3C.3        | Gate 3B          |
| 3C.3       | —             | Gate 3C     | 3C.1, 3C.2       |
| Gate 3C    | —             | Final Gate  | 3C.3             |
| Final Gate | —             | —           | Gate 3C          |
