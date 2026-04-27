# Hermes Agent Full Integration — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Hermes Agent a first-class provider in Archon alongside Claude and Codex, addressing all requirements from upstream issue #1106.

**Architecture:** Hermes spawns `hermes acp` as a subprocess communicating via ACP JSON-RPC 2.0 over stdio. Unlike Claude/Codex (in-process SDKs), model selection must be communicated externally.

**Tech Stack:** TypeScript, Bun, ACP JSON-RPC 2.0, child_process.spawn

**Upstream Issue:** https://github.com/coleam00/Archon/issues/1106

**Hermes Docs:** https://hermes-agent.nousresearch.com/docs

**Prior Investigation:** .hermes/plans/2026-04-27-hermes-per-node-model.md

---

## Execution Strategy

```
Batch 0 (parallel)     → Gate 0 (serial)      → Batch 1 (parallel)     → Gate 1 (verifier)
  T0.1  T0.2  T0.3       T0.4 decision           T1.x  T2.1  T2.2        verification gate
  [3 investigators]       [synthesizes]            [3 executors]            [1 verifier]

→ Batch 2 (parallel)     → Gate 2 (verifier)   → Final Gate
   T3.1  T4.1  T5.1        verification gate      bun run validate
   [3 executors]            [1 verifier]           [1 verifier]
```

Legend: T = Task, Gate = verification checkpoint

---

## Prerequisites

```bash
cd /home/d/Desktop/Archon-canonical
bun install
bun run type-check                                        # baseline: exit 0
bun test packages/providers/src/hermes/                   # baseline: all pass
which hermes && hermes version                            # verify hermes installed
```

Hermes Agent source (for Phase 0):

```bash
python3 -c "import acp_adapter; print(acp_adapter.__file__)"
# or: find ~/.hermes -name "entry.py" -path "*/acp_adapter/*"
```

---

## Batch 0: Parallel Investigation (3 tasks)

> All three tasks run in parallel. Each reads different primary sources.
> Prior findings from 2026-04-27-hermes-per-node-model.md:
>
> - `hermes acp --help` shows only --accept-hooks and -h (NO --model, NO --provider)
> - ACP adapter does NOT read HERMES_MODEL (KNOWN, not speculative)
> - HERMES_INFERENCE_MODEL is NOT in official env vars reference
> - SessionManager stores `model` per session — how populated is undocumented

### Task 0.1: Verify HERMES_MODEL in ACP boot flow

**Objective:** Confirm whether `hermes acp` reads `HERMES_MODEL` from process env.

**Files to read (read-only):**

- `acp_adapter/entry.py` — boot flow, env loading
- `acp_adapter/session.py` — SessionManager model field population
- `hermes_cli/main.py` (lines 1040-1055) — HERMES_MODEL/HERMES_INFERENCE_MODEL usage

**Steps:**

1. Find Hermes source: `python3 -c "import acp_adapter; print(acp_adapter.__file__)"`
2. Read `entry.py` — does `main()` read `HERMES_MODEL` from `os.environ`? Does it pass model to `HermesACPAgent`?
3. Read `session.py` — how does `SessionManager.new_session()` populate the `model` field? From env? From ACP params? From config.yaml?
4. Read `hermes_cli/main.py:1040-1055` — is HERMES_MODEL set for the ACP path or only for `chat -m`?
5. Live test: `HERMES_MODEL=test-model hermes status 2>&1 | grep -i model`

**Deliverable:** Write findings to `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-27-hermes-phase0-findings.md`

- One of: "HERMES_MODEL WORKS in ACP" / "HERMES_MODEL DOES NOT WORK in ACP" / "INCONCLUSIVE"
- Evidence: exact file paths, line numbers, code snippets

---

### Task 0.2: Map ACP session/new params schema

**Objective:** Determine if `session/new` accepts a `model` param.

**Files to read (read-only):**

- `acp_adapter/server.py` — session/new handler
- `acp_adapter/session.py` — new_session() signature
- https://agentclientprotocol.com/protocol/schema — official ACP spec

**Steps:**

1. Read `server.py` — find the `session/new` JSON-RPC handler
2. Extract what params it reads from the request
3. Read ACP spec — does session/new schema include `model`?
4. Read `session.py` — does `new_session()` accept a model parameter?

**Deliverable:** Append to phase0-findings.md

- One of: "session/new ACCEPTS model" / "session/new DOES NOT accept model"
- If yes: exact param name, type, how it flows to SessionManager

---

### Task 0.3: Check config.yaml precedence and HERMES_HOME

**Objective:** Determine if programmatic config.yaml override is viable (Option E).

**Files to read (read-only):**

- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/reference/environment-variables
- `hermes_cli/runtime_provider.py` — config loading precedence

**Steps:**

1. Read Hermes config docs — does config.yaml override env vars or vice versa?
2. Search for `HERMES_HOME` in Hermes source — can it redirect config dir?
3. Evaluate: can we write a temp config.yaml with `model: X` and point HERMES_HOME at it?
4. Check if `hermes acp` loads config from HERMES_HOME or hardcoded ~/.hermes

**Deliverable:** Append to phase0-findings.md

- One of: "Option E VIABLE" / "Option E NOT VIABLE"
- If viable: exact mechanism (HERMES_HOME, XDG_CONFIG_HOME, etc.)

---

## Gate 0: Decision (serial — depends on Batch 0)

### Task 0.4: Synthesize findings and choose implementation path

**Objective:** Read all Phase 0 findings and write the decision.

**Steps:**

1. Read `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-27-hermes-phase0-findings.md`
2. Apply decision tree:

```
Does HERMES_MODEL work in ACP mode?
├── YES → Option A: Keep existing env var code, add tests only
├── NO → Does session/new accept model param?
│   ├── YES → Option B: Pass model in session/new params
│   └── NO → Can we use HERMES_HOME config override?
│       ├── YES → Option E: Write temp config.yaml with HERMES_HOME
│       └── NO → Option D: Pass --model CLI arg + upstream PR
├── HERMES_INFERENCE_MODEL works but HERMES_MODEL doesn't?
│   → Option C: Use HERMES_INFERENCE_MODEL env var
└── INCONCLUSIVE → Default to Option D (safest, most explicit)
```

3. Write decision to phase0-findings.md: `DECISION: Option [X]`
4. Note: if model works but provider resolves wrong, also test HERMES_INFERENCE_PROVIDER coupling

**Deliverable:** phase0-findings.md contains `DECISION: Option [A|B|C|D|E]` with justification.

---

## Batch 1: Core Fix + Config Audit (3 parallel tasks)

> Depends on: Gate 0 decision
> Tasks 1.x are MUTUALLY EXCLUSIVE — execute only the one matching the Gate 0 decision.
> Tasks 2.1 and 2.2 are independent of the model fix and can run in parallel.

### Task 1.A: Option A — Add model propagation test (if HERMES_MODEL works)

**Precondition:** Gate 0 chose Option A.

**Objective:** Add test proving HERMES_MODEL reaches the subprocess env.

**Files:**

- Read: `packages/providers/src/hermes/provider.ts:113-116` (existing code — no changes)
- Modify: `packages/providers/src/hermes/provider.test.ts`

**Step 1: Write failing test**

```typescript
// Add to provider.test.ts after existing sendQuery tests
test('sendQuery sets HERMES_MODEL in subprocess env when options.model provided', async () => {
  const spawnCalls: { env?: Record<string, string> }[] = [];
  // ... existing mock pattern from test file — intercept spawn to capture env

  const provider = new HermesProvider();
  const gen = provider.sendQuery('test', '/tmp', undefined, { model: 'kimi-k2.6' });
  // exhaust generator
  for await (const _ of gen) {
    /* drain */
  }

  expect(spawnCalls.length).toBeGreaterThan(0);
  expect(spawnCalls[0].env?.HERMES_MODEL).toBe('kimi-k2.6');
});

test('sendQuery omits HERMES_MODEL when options.model absent', async () => {
  const spawnCalls: { env?: Record<string, string> }[] = [];
  // ... same mock pattern

  const provider = new HermesProvider();
  const gen = provider.sendQuery('test', '/tmp');
  for await (const _ of gen) {
    /* drain */
  }

  expect(spawnCalls.length).toBeGreaterThan(0);
  expect(spawnCalls[0].env?.HERMES_MODEL).toBeUndefined();
});
```

**Step 2: Verify fail**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -20
```

Expected: 2 FAIL

**Step 3: No code change needed (already implemented)**

**Step 4: Verify pass**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -5
```

Expected: all PASS

**Step 5: Commit**

```bash
git add packages/providers/src/hermes/provider.test.ts
git commit -m "test(hermes): verify HERMES_MODEL propagation in sendQuery"
```

---

### Task 1.B: Option B — Pass model via ACP session/new params

**Precondition:** Gate 0 chose Option B.

**Objective:** Thread model through BridgeOptions → session/new ACP request.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts` (BridgeOptions interface + session/new params)
- Modify: `packages/providers/src/hermes/provider.ts` (pass model to bridge)
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Step 1: Write failing test in event-bridge.test.ts**

```typescript
test('bridgeHermesSession includes model in session/new params', async () => {
  const stdinWrites: string[] = [];
  const mockChild = createMockChildProcess(stdinWrites);
  // ... existing mock pattern from event-bridge.test.ts

  const gen = bridgeHermesSession(mockChild, {
    prompt: 'test',
    cwd: '/tmp',
    model: 'kimi-k2.6',
  });
  for await (const _ of gen) {
    /* drain */
  }

  const sessionNewLine = stdinWrites.find(w => w.includes('"session/new"'));
  expect(sessionNewLine).toBeDefined();
  const parsed = JSON.parse(sessionNewLine!);
  expect(parsed.params.model).toBe('kimi-k2.6');
});
```

**Step 2: Verify fail**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -20
```

Expected: FAIL — model not in session/new params

**Step 3: Implement — three edits:**

Edit 1 — `event-bridge.ts:42-46` — add model to BridgeOptions:

```typescript
export interface BridgeOptions {
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  model?: string; // NEW
}
```

Edit 2 — `event-bridge.ts:386-393` — pass model in session/new:

```typescript
const sessionReq = createRequest(
  ACP_METHODS.sessionNew,
  {
    cwd: options.cwd,
    model: options.model, // NEW
    mcpServers: [],
  },
  idGen
);
```

Edit 3 — `provider.ts:143-151` — thread model to bridge:

```typescript
const bridge = bridgeHermesSession(
  child,
  {
    prompt,
    cwd: session.cwd,
    systemPrompt: options?.systemPrompt,
    model: options?.model, // NEW
  },
  options?.abortSignal
);
```

**Step 4: Verify pass**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -5
```

Expected: all PASS

**Step 5: Commit**

```bash
git add packages/providers/src/hermes/event-bridge.ts packages/providers/src/hermes/provider.ts packages/providers/src/hermes/event-bridge.test.ts
git commit -m "feat(hermes): pass per-node model via ACP session/new params"
```

---

### Task 1.D: Option D — Pass --model as CLI arg

**Precondition:** Gate 0 chose Option D.

**Objective:** Add `--model` CLI arg to `hermes acp` spawn.

**Files:**

- Modify: `packages/providers/src/hermes/provider.ts:136`
- Modify: `packages/providers/src/hermes/provider.test.ts`

**Step 1: Write failing test**

```typescript
test('sendQuery passes --model CLI arg when options.model provided', async () => {
  const spawnCalls: { args?: string[] }[] = [];
  // ... intercept spawn to capture args

  const provider = new HermesProvider();
  const gen = provider.sendQuery('test', '/tmp', undefined, { model: 'kimi-k2.6' });
  for await (const _ of gen) {
    /* drain */
  }

  expect(spawnCalls.length).toBeGreaterThan(0);
  expect(spawnCalls[0].args).toContain('--model');
  const modelIdx = spawnCalls[0].args!.indexOf('--model');
  expect(spawnCalls[0].args![modelIdx + 1]).toBe('kimi-k2.6');
});
```

**Step 2: Verify fail**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -20
```

Expected: FAIL

**Step 3: Implement**

```typescript
// provider.ts:136 — replace spawn call
const args = ['acp'];
if (options?.model) {
  args.push('--model', options.model);
}
const child = spawn(hermesBinary, args, {
  cwd: session.cwd,
  env: { ...session.env, ...modelEnv },
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**Step 4: Verify pass**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -5
```

Expected: all PASS

**Step 5: Commit**

```bash
git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/provider.test.ts
git commit -m "feat(hermes): pass --model CLI arg to hermes acp subprocess"
```

**Note:** Requires upstream PR to Hermes Agent. Until merged, keep HERMES_MODEL env var as fallback.

---

### Task 1.E: Option E — Config.yaml override via HERMES_HOME

**Precondition:** Gate 0 chose Option E.

**Objective:** Write temp config.yaml with model override, point HERMES_HOME at it.

**Files:**

- Modify: `packages/providers/src/hermes/provider.ts`
- Modify: `packages/providers/src/hermes/provider.test.ts`

**Step 1: Write failing test**

```typescript
test('sendQuery creates temp config with model override via HERMES_HOME', async () => {
  const spawnCalls: { env?: Record<string, string> }[] = [];
  // ... intercept spawn

  const provider = new HermesProvider();
  const gen = provider.sendQuery('test', '/tmp', undefined, { model: 'kimi-k2.6' });
  for await (const _ of gen) {
    /* drain */
  }

  expect(spawnCalls[0].env?.HERMES_HOME).toBeDefined();
  // Verify temp dir has config.yaml with model
  const configPath = join(spawnCalls[0].env!.HERMES_HOME, 'config.yaml');
  const config = readFileSync(configPath, 'utf-8');
  expect(config).toContain('model: kimi-k2.6');
});
```

**Step 2: Verify fail**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -20
```

Expected: FAIL

**Step 3: Implement**

```typescript
// provider.ts — after modelEnv block (line ~116)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (options?.model) {
  const tempDir = mkdtempSync(join(tmpdir(), 'hermes-archon-'));
  writeFileSync(join(tempDir, 'config.yaml'), `model: ${options.model}\n`);
  modelEnv.HERMES_HOME = tempDir;
}
```

Add cleanup in the `finally` block:

```typescript
finally {
  if (modelEnv.HERMES_HOME) {
    try { rmSync(modelEnv.HERMES_HOME, { recursive: true }); } catch { /* ignore */ }
  }
}
```

**Step 4: Verify pass**

```bash
bun test packages/providers/src/hermes/provider.test.ts 2>&1 | tail -5
```

Expected: all PASS

**Step 5: Commit**

```bash
git add packages/providers/src/hermes/provider.ts packages/providers/src/hermes/provider.test.ts
git commit -m "feat(hermes): override model via temp config.yaml with HERMES_HOME"
```

---

### Task 2.1: Audit HERMES_CAPABILITIES flags

**Objective:** Verify capability flags match actual wired behavior.

**Files:**

- Read: `packages/providers/src/hermes/capabilities.ts`
- Read: `packages/providers/src/hermes/event-bridge.ts` (ACP features wired)

**Steps:**

1. Read capabilities.ts — current flags
2. Read event-bridge.ts — which ACP features are actually wired:
   - session/fork → sessionResume
   - mcpServers in session/new → mcp
   - session/update agent_thought_chunk → thinkingControl
3. If any flag is wrong, update it
4. Run: `bun test packages/providers/src/hermes/ 2>&1 | tail -5`
5. If changed: `git commit -m "fix(hermes): correct capability flags to match wired behavior"`

**Expected:** All flags are already correct (verified in prior audit). No changes needed.

---

### Task 2.2: Verify DEFAULT_AI_ASSISTANT=hermes support

**Objective:** Confirm the env var accepts 'hermes' as a value.

**Files:**

- Search: `packages/core/src/config/` for `DEFAULT_AI_ASSISTANT`
- Read: relevant config file where this is parsed

**Steps:**

1. `grep -r "DEFAULT_AI_ASSISTANT" packages/core/src/`
2. Read the file that parses this env var
3. Verify 'hermes' is accepted (either as explicit value or as passthrough)
4. If not supported, add 'hermes' to the accepted values
5. Run: `bun test packages/core/src/ 2>&1 | tail -5`
6. If changed: `git commit -m "feat(core): accept hermes in DEFAULT_AI_ASSISTANT env var"`

---

## Gate 1: Verification Gate (verifier)

> Dispatch a FRESH verifier subagent (not any prior executor) with this context:

**Verifier prompt:**

```
You are a verifier. You did NOT implement any of these tasks.
Your job is to objectively check the filesystem state and report PASS/FAIL.

Working directory: /home/d/Desktop/Archon-canonical

STEP 0: Verify location
  Run: pwd
  Expected: /home/d/Desktop/Archon-canonical

STEP 1: Check git status for unauthorized changes
  Run: git diff --name-only
  Expected: only files from the plan (provider.ts, provider.test.ts, event-bridge.ts, etc.)
  Flag any unrelated file changes.

STEP 2: Run type check
  Run: bun --filter @archon/providers run type-check
  Expected: exit 0

STEP 3: Run hermes tests
  Run: bun test packages/providers/src/hermes/ 2>&1 | tail -10
  Expected: all PASS, 0 fail

STEP 4: Verify the chosen option was implemented
  Read the phase0-findings.md to find DECISION: Option [X]
  Then verify the corresponding code change:
  - Option A: provider.test.ts has HERMES_MODEL propagation test
  - Option B: event-bridge.ts BridgeOptions has model field, session/new sends model
  - Option D: provider.ts spawn args include --model conditional
  - Option E: provider.ts creates temp config.yaml with HERMES_HOME

STEP 5: Check for temp files or debris
  Run: git status --short
  Expected: no untracked files except phase0-findings.md

REPORT:
  - STEP [N]: PASS/FAIL — [evidence]
  - OVERALL: GREEN / RED (list issues)
```

---

## Batch 2: Abort Handling + Provider Switching + Test Baseline (3 parallel tasks)

> Depends on: Gate 1 GREEN
> All three tasks are independent (touch different files).

### Task 3.1: Verify abort signal propagation

**Objective:** Confirm abort signal correctly terminates Hermes subprocess.

**Files:**

- Read: `packages/providers/src/hermes/event-bridge.ts:259-311`
- Read: `packages/providers/src/hermes/event-bridge.test.ts`

**Steps:**

1. Read event-bridge.ts abort handling (lines 259-311):
   - session/cancel notification ✓
   - SIGTERM to child ✓
   - SIGKILL fallback after 5s ✓
   - Terminal result with isError ✓
   - Queue close ✓
2. Read event-bridge.test.ts — find abort tests
3. Verify coverage: abort before session/new, during prompt, after prompt
4. If missing, add:

```typescript
test('abort signal sends SIGTERM and emits error result', async () => {
  const controller = new AbortController();
  const mockChild = createMockChildProcess([]);
  // ... existing mock pattern

  const gen = bridgeHermesSession(mockChild, { prompt: 'test', cwd: '/tmp' }, controller.signal);
  controller.abort();

  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }

  const result = chunks.find(c => c.type === 'result');
  expect(result).toBeDefined();
  expect((result as any).isError).toBe(true);
});
```

5. Run: `bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -5`
6. If changed: `git commit -m "test(hermes): add abort signal propagation coverage"`

---

### Task 4.1: Verify dag-executor cross-provider support

**Objective:** Confirm workflows can mix Claude and Hermes nodes.

**Files:**

- Read: `packages/workflows/src/dag-executor.ts:329-464`
- Read: `packages/workflows/src/dag-executor.test.ts`

**Steps:**

1. Read resolveNodeProviderAndModel — verify node.provider overrides workflow provider
2. Read dag-executor.test.ts — find cross-provider tests
3. If none exist, add:

```typescript
test('resolveNodeProviderAndModel uses node.provider over workflow provider', () => {
  // Create mock node with provider: 'hermes', model: 'qwen2.5-coder:32b'
  // Create mock workflow with provider: 'claude'
  // Call resolveNodeProviderAndModel
  // Assert provider is 'hermes', model is 'qwen2.5-coder:32b'
});
```

4. Run: `bun test packages/workflows/src/dag-executor.test.ts 2>&1 | tail -5`
5. If changed: `git commit -m "test(workflows): verify cross-provider node resolution"`

---

### Task 5.1: Verify test baseline count

**Objective:** Establish exact test count for hermes package.

**Steps:**

1. Run: `bun test packages/providers/src/hermes/ 2>&1 | grep -E "pass|fail|tests"`
2. Record count. If different from expected (~172), note the delta.
3. No code changes — this is a read-only audit task.

**Deliverable:** Report test count to parent session.

---

## Gate 2: Verification Gate (verifier)

> Dispatch a FRESH verifier subagent:

**Verifier prompt:**

```
You are a verifier. You did NOT implement any of these tasks.
Working directory: /home/d/Desktop/Archon-canonical

STEP 0: Verify location
  Run: pwd
  Expected: /home/d/Desktop/Archon-canonical

STEP 1: Run hermes test suite
  Run: bun test packages/providers/src/hermes/ 2>&1 | tail -10
  Expected: all PASS, 0 fail

STEP 2: Run workflow test suite
  Run: bun test packages/workflows/src/ 2>&1 | tail -10
  Expected: all PASS, 0 fail

STEP 3: Check abort test coverage
  Read: packages/providers/src/hermes/event-bridge.test.ts
  Verify: at least one test covers abort signal → SIGTERM → error result

STEP 4: Check cross-provider test
  Read: packages/workflows/src/dag-executor.test.ts
  Verify: at least one test covers node.provider override (hermes over claude)

STEP 5: Check for unauthorized changes
  Run: git diff --name-only
  Expected: only hermes/ and workflow test files

REPORT:
  - STEP [N]: PASS/FAIL — [evidence]
  - OVERALL: GREEN / RED
```

---

## Final Gate: Full Validation

> Dispatch a FRESH verifier subagent:

**Verifier prompt:**

```
You are a final integration verifier. You did NOT implement any tasks.
Working directory: /home/d/Desktop/Archon-canonical

STEP 0: Verify location
  Run: pwd
  Expected: /home/d/Desktop/Archon-canonical

STEP 1: Type check (all packages)
  Run: bun --filter @archon/providers run type-check
  Expected: exit 0

STEP 2: Lint
  Run: bun run lint --max-warnings 0
  Expected: exit 0

STEP 3: Format check
  Run: bun run format:check
  Expected: exit 0

STEP 4: Full test suite
  Run: bun run test 2>&1 | tail -20
  Expected: all packages pass, 0 fail

STEP 5: Validate
  Run: bun run validate 2>&1 | tail -20
  Expected: all checks pass

STEP 6: Review git log for commit quality
  Run: git log --oneline -10
  Verify: commits follow conventional format (feat/fix/test(scope): description)

STEP 7: Check for debris
  Run: git status --short
  Expected: clean or only phase0-findings.md untracked

REPORT:
  - STEP [N]: PASS/FAIL — [evidence]
  - OVERALL: GREEN / RED
  - If RED: specific failures with file paths and line numbers
```

---

## Scope Declaration

**Addresses from Issue #1106:**

| Requirement                                         | Status               | Task                   |
| --------------------------------------------------- | -------------------- | ---------------------- |
| Client starts Hermes sessions and streams responses | [x] already done     | —                      |
| Client maps Hermes events to MessageChunk           | [x] already done     | —                      |
| Client propagates cwd, model, systemPrompt          | [~] model fix needed | Task 1.x               |
| hermes in ProviderType union                        | [x] already done     | registration.ts        |
| assistant: hermes in config                         | [x] already done     | config.ts              |
| Hermes-specific config options                      | [x] already done     | HermesProviderDefaults |
| DEFAULT_AI_ASSISTANT=hermes                         | [~] verify           | Task 2.2               |
| Per-node provider: hermes works                     | [x] already done     | dag-executor           |
| Per-node model passes through                       | [~] core fix         | Task 1.x               |
| Abort/interrupt handling                            | [x] already done     | event-bridge.ts        |
| Tool execution in logs                              | [x] already done     | session/update bridge  |
| Provider switching mid-workflow                     | [~] verify           | Task 4.1               |
| Unit tests for streaming                            | [x] already done     | provider.test.ts       |
| Model propagation tests                             | [~] add              | Task 1.x               |
| Cross-provider tests                                | [~] add              | Task 4.1               |

**Not addressed (separate plans):**

- CLI setup wizard (archon init) — @archon/cli changes
- Web UI provider dropdown — @archon/web changes
- Documentation updates — docs site
- Live Ollama/OpenRouter integration tests — requires API keys

---

## Risks

1. **HERMES_MODEL is KNOWN not to work in ACP mode** (prior investigation). Phase 0 Task 0.1 verifies against source. If confirmed, need Option B/D/E.
2. **HERMES_INFERENCE_MODEL is NOT documented.** Do not rely on unless Phase 0 confirms in source.
3. **Config.yaml precedence** — Even if HERMES_MODEL is set, config.yaml may override it. Task 0.3 investigates.
4. **Model string format mismatch** — "qwen2.5-coder:32b" vs "anthropic/claude-sonnet-4". Verify model-ref.ts handles Hermes formats.
5. **Hermes binary version** — verifyHermesBinary() checks this, but ACP protocol v1 vs v2 could break.
6. **Subprocess resource exhaustion** — Each sendQuery spawns a new process. High concurrency = many processes.
7. **Bun mock.module pollution** — Tests must be in separate bun test invocations if they use conflicting mocks.
