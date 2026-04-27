# Hermes Agent Full Integration — Phase 2 Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Close every remaining gap from Issue #1106 — tool event mapping, full documentation, live integration tests, and capability upgrades. No mocks. No documenting limitations. Exceed the issue requirements.

**Architecture:** Hermes spawns `hermes acp` as a subprocess communicating via ACP JSON-RPC 2.0 over stdio. Phase 1 (completed) implemented per-node model override via HERMES_HOME temp config. This phase wires up tool events, writes full documentation, and tests against live endpoints.

**Tech Stack:** TypeScript, Bun, ACP JSON-RPC 2.0, child_process.spawn, Astro/Starlight docs

**Upstream Issue:** https://github.com/coleam00/Archon/issues/1106

**Hermes Docs:** https://hermes-agent.nousresearch.com/docs

**Prior work:**

- Phase 1 commit 53599500: HERMES_HOME temp config (provider.ts)
- Phase 1 commit e6b4b6ea: abort signal tests (event-bridge.test.ts)
- Phase 1 commit 83b494cb: cross-provider tests (dag-executor.test.ts)
- Phase 0 findings: .hermes/plans/2026-04-27-hermes-phase0-findings.md

---

## Execution Strategy

```
Batch 0 (parallel)         → Gate 0 (verifier)     → Batch 1 (parallel)
  T0.1  T0.2  T0.3  T0.4     verification gate        T1.1  T1.2  T1.3
  [4 executors]               [1 verifier]              [3 executors]

→ Gate 1 (verifier)         → Batch 2 (parallel)    → Gate 2 (verifier)    → Final Gate
   verification gate           T2.1  T2.2  T2.3        verification gate      bun run validate
   [1 verifier]                [3 executors]            [1 verifier]           [1 verifier]
```

---

## Prerequisites

```bash
cd /home/d/Desktop/Archon-canonical
bun install
bun run type-check                                        # baseline: exit 0
bun test packages/providers/src/hermes/                   # baseline: 170 pass, 6 fail (pre-existing)
```

API keys needed for live tests (user will provide when tasks reach that point):

- Ollama: running locally at http://localhost:11434
- OpenRouter: OPENROUTER_API_KEY in ~/.hermes/.env

---

## Batch 0: Tool Event Mapping + Usage Update + Config Docs (4 parallel tasks)

### Task 0.1: Add tool_call_update and tool_call event types to ACP protocol

**Objective:** Define TypeScript interfaces for ACP tool events so the bridge can parse them.

**Files:**

- Modify: `packages/providers/src/hermes/acp-protocol.ts`

**Context:** The ACP protocol (acp/schema.py) defines these session/update types that Hermes sends:

- `tool_call_update` — sent when a tool starts (ToolCallStart) or completes (ToolCallProgress)
- `tool_call` — alias for tool call events

Hermes builds these via `acp_adapter/tools.py:build_tool_start()` and `build_tool_complete()`.

The wire format for a tool start event looks like:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "tc-abc123",
      "kind": "execute",
      "title": "terminal: ls -la",
      "status": "started",
      "content": [{ "type": "text", "text": "$ ls -la" }],
      "rawInput": { "command": "ls -la" }
    }
  }
}
```

The wire format for a tool complete event:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "tc-abc123",
      "kind": "execute",
      "status": "completed",
      "content": [{ "type": "text", "text": "file1.txt\nfile2.txt" }],
      "rawOutput": "file1.txt\nfile2.txt"
    }
  }
}
```

**Step 1: Add types to acp-protocol.ts**

After the existing `AgentThoughtChunkUpdate` interface (line ~170), add:

```typescript
/** A tool call update (start or complete) pushed via session/update. */
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  kind: string; // 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'
  title: string; // human-readable, e.g. "terminal: ls -la"
  status: string; // 'started' | 'completed' | 'failed'
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  rawInput?: Record<string, unknown>;
  rawOutput?: string;
  locations?: Array<{ path: string; line?: number }>;
}
```

Update `SessionUpdateUnion` to include it:

```typescript
export type SessionUpdateUnion = AgentMessageChunkUpdate | AgentThoughtChunkUpdate | ToolCallUpdate;
```

Update `isSessionUpdateParams` to accept `tool_call_update`:

```typescript
export function isSessionUpdateParams(obj: unknown): obj is SessionUpdateParams {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  if (typeof record.sessionId !== 'string') return false;
  if (!record.update || typeof record.update !== 'object') return false;
  const update = record.update as Record<string, unknown>;
  if (typeof update.sessionUpdate !== 'string') return false;
  return (
    update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk' ||
    update.sessionUpdate === 'tool_call_update'
  );
}
```

**Step 2: Add helper to check tool update type:**

```typescript
export function isToolCallUpdate(update: SessionUpdateUnion): update is ToolCallUpdate {
  return update.sessionUpdate === 'tool_call_update';
}
```

**Step 3: Run tests:**

```bash
bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -10
```

**Step 4: Commit:**

```bash
git add packages/providers/src/hermes/acp-protocol.ts
git commit -m "feat(hermes): add tool_call_update event types to ACP protocol"
```

---

### Task 0.2: Wire tool events in event-bridge.ts

**Objective:** Map ACP tool_call_update events to Archon MessageChunk type 'tool' and 'tool_result'.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Context:** The event-bridge currently handles only `agent_message_chunk` and `agent_thought_chunk`. Tool events hit the `else` branch and are silently logged at debug level.

The bridge needs to:

1. Parse tool_call_update events
2. When status='started': emit MessageChunk type 'tool' with toolName and toolInput
3. When status='completed': emit MessageChunk type 'tool_result' with toolName and toolOutput
4. When status='failed': emit MessageChunk type 'tool_result' with toolName and toolOutput (error)

**Step 1: Write failing test in event-bridge.test.ts:**

```typescript
test('tool_call_update started emits tool chunk', async () => {
  const mockChild = createMockChildProcess([]);
  // ... configure mock to send a tool_call_update started notification

  const chunks: MessageChunk[] = [];
  for await (const chunk of bridgeHermesSession(mockChild, { prompt: 'test', cwd: '/tmp' })) {
    chunks.push(chunk);
  }

  const toolChunk = chunks.find(c => c.type === 'tool');
  expect(toolChunk).toBeDefined();
  expect((toolChunk as any).toolName).toBe('terminal');
  expect((toolChunk as any).toolInput).toEqual({ command: 'ls -la' });
});

test('tool_call_update completed emits tool_result chunk', async () => {
  const mockChild = createMockChildProcess([]);
  // ... configure mock to send tool_call_update completed notification

  const chunks: MessageChunk[] = [];
  for await (const chunk of bridgeHermesSession(mockChild, { prompt: 'test', cwd: '/tmp' })) {
    chunks.push(chunk);
  }

  const resultChunk = chunks.find(c => c.type === 'tool_result');
  expect(resultChunk).toBeDefined();
  expect((resultChunk as any).toolName).toBe('terminal');
  expect((resultChunk as any).toolOutput).toContain('file1.txt');
});

test('tool_call_update with unknown kind still emits tool chunk', async () => {
  // ... send tool_call_update with kind='other'
  // Verify it doesn't crash and emits a generic tool chunk
});
```

**Step 2: Verify fail:**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -20
```

**Step 3: Implement in event-bridge.ts:**

In the notification handler (around line 163), add tool_call_update handling:

```typescript
import { isToolCallUpdate, type ToolCallUpdate } from './acp-protocol';

// ... inside the notification handler, after the agent_thought_chunk branch:
} else if (update.sessionUpdate === 'tool_call_update') {
  const toolUpdate = update as ToolCallUpdate;
  if (toolUpdate.status === 'started') {
    queue.push({
      kind: 'chunk',
      chunk: {
        type: 'tool',
        toolName: toolUpdate.title || 'unknown',
        toolInput: toolUpdate.rawInput as Record<string, unknown> | undefined,
        toolCallId: toolUpdate.toolCallId,
      },
    });
  } else if (toolUpdate.status === 'completed' || toolUpdate.status === 'failed') {
    queue.push({
      kind: 'chunk',
      chunk: {
        type: 'tool_result',
        toolName: toolUpdate.title || 'unknown',
        toolOutput: toolUpdate.rawOutput || JSON.stringify(toolUpdate.content || ''),
        toolCallId: toolUpdate.toolCallId,
      },
    });
  }
}
```

**Step 4: Verify pass:**

```bash
bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -5
```

**Step 5: Commit:**

```bash
git add packages/providers/src/hermes/event-bridge.ts packages/providers/src/hermes/event-bridge.test.ts
git commit -m "feat(hermes): map ACP tool_call_update to MessageChunk tool/tool_result"
```

---

### Task 0.3: Wire usage_update events for token tracking

**Objective:** Map ACP usage_update events to MessageChunk type 'result' with tokens.

**Files:**

- Modify: `packages/providers/src/hermes/acp-protocol.ts` (add usage_update type)
- Modify: `packages/providers/src/hermes/event-bridge.ts` (map to result chunk tokens)
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Context:** ACP defines `usage_update` session/update type. The wire format:

```json
{
  "sessionUpdate": "usage_update",
  "inputTokens": 1500,
  "outputTokens": 300,
  "totalTokens": 1800
}
```

**Step 1: Add type to acp-protocol.ts:**

```typescript
export interface UsageUpdate {
  sessionUpdate: 'usage_update';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
```

Update SessionUpdateUnion and isSessionUpdateParams.

**Step 2: Write failing test:**

```typescript
test('usage_update emits result chunk with token usage', async () => {
  // ... send usage_update notification
  // Verify result chunk has tokens.input, tokens.output, tokens.total
});
```

**Step 3: Implement in event-bridge.ts:**

```typescript
} else if (update.sessionUpdate === 'usage_update') {
  const usage = update as UsageUpdate;
  // Store usage data to include in the final result chunk
  // (usage updates typically arrive before the final result)
}
```

**Step 4: Verify pass, commit.**

---

### Task 0.4: Add Hermes section to ai-assistants.md

**Objective:** Add a complete Hermes Agent section to the getting-started docs, matching the quality of the Claude/Codex/Pi sections.

**Files:**

- Modify: `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`

**Context:** The existing ai-assistants.md has sections for Claude Code, Codex, and Pi. Hermes needs a section that EXCEEDS the others in clarity and completeness. The issue requires:

- Install instructions
- Authentication options
- Configuration options
- Per-node model override
- Workflow examples
- Capabilities table

**Step 1: Read the existing file to understand the structure and style:**

```bash
# Read the file to understand markdown patterns, frontmatter, section structure
```

**Step 2: Add the Hermes section after the Pi section (before "How Assistant Selection Works")**:

The section should include:

- Overview paragraph (open-source, 15+ providers, MIT license)
- Install (pip install, brew, binary)
- Binary path configuration (env var, config file)
- Authentication (global auth via hermes login, API keys via .env)
- Configuration options (model, provider, endpoint, globalAuth, hermesBinaryPath)
- Per-node model override in workflows
- Workflow example with mixed Claude + Hermes nodes
- Capabilities table (matching the Pi capabilities table format)
- Set as default (DEFAULT_AI_ASSISTANT=hermes)
- See also (troubleshooting link)

**Step 3: Update the frontmatter description:**

```yaml
description: Configure Claude Code, Codex, Pi, and Hermes Agent as AI assistants for Archon.
```

**Step 4: Update the opening line:**

```
You must configure **at least one** AI assistant. All four can be configured and mixed within workflows.
```

**Step 5: Verify the docs build:**

```bash
# If docs-web has a build script:
bun --filter @archon/docs-web build 2>&1 | tail -10
```

**Step 6: Commit:**

```bash
git add packages/docs-web/src/content/docs/getting-started/ai-assistants.md
git commit -m "docs: add Hermes Agent section to AI Assistants getting-started guide"
```

---

## Gate 0: Verification Gate

> Fresh verifier subagent:

**Verifier prompt:**

```
You are a verifier. You did NOT implement any of these tasks.
Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify /home/d/Desktop/Archon-canonical

STEP 1: git log --oneline -6 — verify 4 new commits

STEP 2: bun test packages/providers/src/hermes/acp-protocol.test.ts 2>&1 | tail -5
Expected: all PASS

STEP 3: bun test packages/providers/src/hermes/event-bridge.test.ts 2>&1 | tail -5
Expected: all PASS

STEP 4: Read packages/providers/src/hermes/acp-protocol.ts
Verify: ToolCallUpdate interface exists, isSessionUpdateParams accepts 'tool_call_update'

STEP 5: Read packages/providers/src/hermes/event-bridge.ts
Verify: tool_call_update handler emits 'tool' chunk on started, 'tool_result' on completed

STEP 6: Read packages/docs-web/src/content/docs/getting-started/ai-assistants.md
Verify: Hermes section exists with install, auth, config, workflow examples, capabilities table

STEP 7: bun --filter @archon/providers run type-check 2>&1 | tail -5
Expected: exit 0

REPORT: STEP [N]: PASS/FAIL — [evidence]. OVERALL: GREEN / RED.
```

---

## Batch 1: Configuration Docs + Deployment Docs + Troubleshooting (3 parallel tasks)

### Task 1.1: Add Hermes to configuration.md

**Objective:** Add Hermes config examples to the configuration reference.

**Files:**

- Modify: `packages/docs-web/src/content/docs/getting-started/configuration.md`

**Context:** The current configuration.md shows Claude and Codex config examples. It needs Hermes examples added alongside them.

**Step 1: Read the existing file.**

**Step 2: Add Hermes to the Project Configuration section:**

```yaml
assistants:
  claude:
    model: sonnet
    settingSources:
      - project
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
  hermes:
    model: qwen2.5-coder:32b
    provider: ollama
    endpoint: http://localhost:11434/v1
```

**Step 3: Add Hermes environment variables to the table:**

| Variable               | Required | Description                                                    |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `HERMES_BINARY_PATH`   | No       | Absolute path to the hermes CLI binary. Overrides PATH lookup. |
| `DEFAULT_AI_ASSISTANT` | No       | Set to `hermes` to make Hermes the default assistant           |

**Step 4: Commit:**

```bash
git add packages/docs-web/src/content/docs/getting-started/configuration.md
git commit -m "docs: add Hermes configuration examples to configuration reference"
```

---

### Task 1.2: Add Hermes to deployment docs

**Objective:** Add Hermes setup instructions to local and cloud deployment guides.

**Files:**

- Modify: `packages/docs-web/src/content/docs/deployment/local.md`
- Modify: `packages/docs-web/src/content/docs/deployment/cloud.md`

**Context:** The local.md prerequisites say "At least one AI assistant installed and configured (Claude Code or Codex)". This must include Hermes. The cloud.md needs a Hermes setup section.

**Step 1: Read both files.**

**Step 2: In local.md, update the prerequisites:**

```
- At least one AI assistant installed and configured (Claude Code, Codex, or Hermes Agent)
```

Add a Hermes setup section after the existing setup instructions:

```markdown
### Hermes Agent (Optional)

For local models via Ollama:

\`\`\`bash

# Install Ollama

curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model

ollama pull qwen2.5-coder:32b

# Install Hermes Agent

pip install hermes-agent

# Configure

hermes setup
\`\`\`

Add to `.archon/config.yaml`:
\`\`\`yaml
assistants:
hermes:
model: qwen2.5-coder:32b
provider: ollama
endpoint: http://localhost:11434/v1
\`\`\`
```

**Step 3: In cloud.md, add a Hermes section after the existing setup:**

- Ollama setup on the VPS
- OpenRouter configuration for cloud models
- Environment variables needed

**Step 4: Commit:**

```bash
git add packages/docs-web/src/content/docs/deployment/local.md packages/docs-web/src/content/docs/deployment/cloud.md
git commit -m "docs: add Hermes Agent setup to local and cloud deployment guides"
```

---

### Task 1.3: Expand troubleshooting-hermes.md

**Objective:** Add tool-event-specific and live-endpoint troubleshooting entries.

**Files:**

- Modify: `packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md`

**Context:** The existing troubleshooting page covers: not found, model not available, connection refused, hangs, provider switching, binary path. It needs entries for:

- Tool events not appearing in logs
- HERMES_HOME temp directory issues
- OpenRouter rate limiting
- Model format mismatch (e.g., wrong provider prefix)
- Session timeout for slow models

**Step 1: Read the existing file.**

**Step 2: Add new entries following the existing format (## heading, **Symptom:**, **Fix:**).**

**Step 3: Commit:**

```bash
git add packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md
git commit -m "docs: expand Hermes troubleshooting with tool events and live endpoint issues"
```

---

## Gate 1: Verification Gate

> Fresh verifier subagent:

**Verifier prompt:**

```
You are a verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location

STEP 1: git log --oneline -10 — verify commits for docs changes

STEP 2: Read packages/docs-web/src/content/docs/getting-started/ai-assistants.md
Verify: Hermes section exists with install, auth, config, workflow examples, capabilities table
Verify: Frontmatter description mentions Hermes

STEP 3: Read packages/docs-web/src/content/docs/getting-started/configuration.md
Verify: Hermes config examples present alongside Claude/Codex

STEP 4: Read packages/docs-web/src/content/docs/deployment/local.md
Verify: Prerequisites mention Hermes Agent
Verify: Hermes setup section exists

STEP 5: Read packages/docs-web/src/content/docs/deployment/cloud.md
Verify: Hermes setup instructions present

STEP 6: Read packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md
Verify: Tool event troubleshooting entries exist
Verify: Live endpoint troubleshooting entries exist

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Batch 2: Live Integration Tests (3 parallel tasks)

> These tasks require live API keys. The user has Ollama running locally and OpenRouter API key.

### Task 2.1: Live test with Ollama (local model)

**Objective:** Run an actual Hermes query against a local Ollama model and verify the full pipeline works end-to-end.

**Files:**

- Read: `packages/providers/src/hermes/provider.ts` (verify HERMES_HOME approach)
- Create: `packages/providers/src/hermes/live-integration.test.ts` (new file)

**Context:** This is a REAL integration test — no mocks. It spawns an actual `hermes acp` process, sends a prompt to a local Ollama model, and verifies the response.

**Precondition:** Ollama must be running with a model pulled. Ask user for the model name if needed.

**Step 1: Verify Ollama is running:**

```bash
curl -s http://localhost:11434/api/tags | head -5
```

**Step 2: Write the live test:**

```typescript
// live-integration.test.ts
import { describe, test, expect } from 'bun:test';
import { HermesProvider } from './provider';

describe('Hermes live integration', () => {
  test('sendQuery with Ollama model returns assistant response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from Hermes"',
      '/tmp',
      undefined,
      { model: 'qwen2.5-coder:32b' } // or whatever model is available
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();
  }, 60_000); // 60s timeout for local model inference

  test('sendQuery with tool execution returns tool chunks', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Create a file at /tmp/hermes-test-integration.txt with content "test", then read it back',
      '/tmp',
      undefined,
      { model: 'qwen2.5-coder:32b' }
    )) {
      chunks.push(chunk);
    }

    const toolChunks = chunks.filter(c => c.type === 'tool');
    const toolResultChunks = chunks.filter(c => c.type === 'tool_result');

    // Should have at least write_file and read_file tool calls
    expect(toolChunks.length).toBeGreaterThanOrEqual(1);
    expect(toolResultChunks.length).toBeGreaterThanOrEqual(1);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();
  }, 120_000); // 2min timeout for tool execution

  test('sendQuery with system prompt passes it through', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery('What is your system prompt?', '/tmp', undefined, {
      model: 'qwen2.5-coder:32b',
      systemPrompt: 'You are a test bot. Always include TESTBOT in your response.',
    })) {
      chunks.push(chunk);
    }

    const assistantContent = chunks
      .filter(c => c.type === 'assistant')
      .map(c => c.content)
      .join('');

    expect(assistantContent.toLowerCase()).toContain('testbot');
  }, 60_000);
});
```

**Step 3: Run the live test:**

```bash
bun test packages/providers/src/hermes/live-integration.test.ts 2>&1 | tail -20
```

**Step 4: If it fails, debug and fix. The most likely failures:**

- Ollama not running → ask user to start it
- Model not pulled → ask user to pull it
- HERMES_HOME approach has issues → debug provider.ts
- Tool events not captured → check event-bridge.ts mapping

**Step 5: Commit:**

```bash
git add packages/providers/src/hermes/live-integration.test.ts
git commit -m "test(hermes): live integration tests with Ollama"
```

---

### Task 2.2: Live test with OpenRouter (cloud model)

**Objective:** Run an actual Hermes query against OpenRouter and verify cloud model support.

**Files:**

- Modify: `packages/providers/src/hermes/live-integration.test.ts`

**Context:** OpenRouter requires OPENROUTER_API_KEY. The test should use a cost-effective model.

**Precondition:** OPENROUTER_API_KEY must be set in ~/.hermes/.env or environment.

**Step 1: Verify OpenRouter access:**

```bash
grep OPENROUTER_API_KEY ~/.hermes/.env | head -1 | sed 's/=.*/=***/'
```

**Step 2: Add OpenRouter tests:**

```typescript
test('sendQuery with OpenRouter model returns response', async () => {
  const provider = new HermesProvider();
  const chunks: MessageChunk[] = [];

  for await (const chunk of provider.sendQuery(
    'Say exactly: "Hello from OpenRouter via Hermes"',
    '/tmp',
    undefined,
    { model: 'openrouter/google/gemini-2.5-flash' } // cheap model
  )) {
    chunks.push(chunk);
  }

  const assistantChunks = chunks.filter(c => c.type === 'assistant');
  expect(assistantChunks.length).toBeGreaterThan(0);

  const resultChunk = chunks.find(c => c.type === 'result');
  expect(resultChunk).toBeDefined();
  expect((resultChunk as any).isError).toBeFalsy();
}, 60_000);
```

**Step 3: Run:**

```bash
bun test packages/providers/src/hermes/live-integration.test.ts 2>&1 | tail -20
```

**Step 4: Commit:**

```bash
git add packages/providers/src/hermes/live-integration.test.ts
git commit -m "test(hermes): live integration tests with OpenRouter"
```

---

### Task 2.3: Verify and fix pre-existing session-resolver test failures

**Objective:** Fix the 6 pre-existing test failures in session-resolver.test.ts.

**Files:**

- Read: `packages/providers/src/hermes/session-resolver.ts`
- Read: `packages/providers/src/hermes/session-resolver.test.ts`

**Context:** The tests call `resolveHermesSession({ cwd: '/tmp/project' })` but `/tmp/project` doesn't exist. The function validates cwd existence at line 60 and throws ENOENT. The tests don't mock the filesystem.

**Step 1: Read the test file and understand the failures.**

**Step 2: Fix the tests to use a real temp directory:**

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hermes-test-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Replace all '/tmp/project' with tempDir
```

**Step 3: Verify all pass:**

```bash
bun test packages/providers/src/hermes/session-resolver.test.ts 2>&1 | tail -10
```

**Step 4: Commit:**

```bash
git add packages/providers/src/hermes/session-resolver.test.ts
git commit -m "fix(hermes): fix session-resolver tests to use real temp directories"
```

---

## Gate 2: Verification Gate

> Fresh verifier subagent:

**Verifier prompt:**

```
You are a verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location

STEP 1: git log --oneline -15 — verify all commits

STEP 2: bun test packages/providers/src/hermes/ 2>&1 | tail -10
Expected: ALL pass, 0 fail (session-resolver failures should be fixed)

STEP 3: Read packages/providers/src/hermes/live-integration.test.ts
Verify: Ollama test exists, OpenRouter test exists, tool execution test exists

STEP 4: bun --filter @archon/providers run type-check 2>&1 | tail -5
Expected: exit 0

STEP 5: Verify no HERMES_MODEL env var remains in provider.ts
grep -n "HERMES_MODEL" packages/providers/src/hermes/provider.ts
Expected: 0 matches (replaced by HERMES_HOME approach)

STEP 6: Verify tool event mapping in event-bridge.ts
grep -n "tool_call_update\|tool_result\|toolName" packages/providers/src/hermes/event-bridge.ts
Expected: matches showing tool event handling

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Final Gate: Full Validation

> Fresh verifier subagent:

**Verifier prompt:**

```
You are a final integration verifier. Working directory: /home/d/Desktop/Archon-canonical

STEP 0: pwd — verify location

STEP 1: bun --filter @archon/providers run type-check 2>&1 | tail -5
Expected: exit 0

STEP 2: bun test packages/providers/src/hermes/ 2>&1 | tail -10
Expected: ALL pass, 0 fail

STEP 3: bun test packages/workflows/src/dag-executor.test.ts 2>&1 | tail -5
Expected: ALL pass, 0 fail

STEP 4: git log --oneline -20
Verify: all commits follow conventional format

STEP 5: Verify documentation completeness
Read these files and verify Hermes coverage:
- packages/docs-web/src/content/docs/getting-started/ai-assistants.md
- packages/docs-web/src/content/docs/getting-started/configuration.md
- packages/docs-web/src/content/docs/deployment/local.md
- packages/docs-web/src/content/docs/deployment/cloud.md
- packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md

STEP 6: Verify tool event mapping
Read packages/providers/src/hermes/event-bridge.ts
Verify: tool_call_update → tool chunks, tool_result chunks

STEP 7: Verify live test file exists
Read packages/providers/src/hermes/live-integration.test.ts
Verify: Ollama test, OpenRouter test, tool execution test

STEP 8: git status --short
Expected: clean or only plan files untracked

REPORT: STEP [N]: PASS/FAIL. OVERALL: GREEN / RED.
```

---

## Scope — Issue #1106 Coverage

| Requirement                | Phase 1 | Phase 2            | Total          |
| -------------------------- | ------- | ------------------ | -------------- |
| Core Integration (4 items) | 100%    | tool mapping added | 100%           |
| Configuration (4 items)    | 100%    | —                  | 100%           |
| CLI Setup (4 items)        | 100%    | —                  | 100%           |
| Workflows (4 items)        | 100%    | —                  | 100%           |
| Testing (6 items)          | 67%     | live tests added   | 100%           |
| Documentation (5 items)    | 20%     | full docs added    | 100%           |
| Nice-to-haves (4 items)    | 25%     | —                  | 25% (deferred) |

**Exceeds issue requirements:**

- Live integration tests with real endpoints (issue didn't require this)
- Tool event mapping (issue listed it but didn't specify ACP tool_call_update)
- Pre-existing test fixes (session-resolver)
- Full deployment docs for both local and cloud
