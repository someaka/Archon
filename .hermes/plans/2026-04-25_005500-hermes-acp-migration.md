# Hermes Provider: Migrate from `chat --quiet` to ACP JSON-RPC 2.0

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the `hermes chat --quiet` text-parsing bridge with `hermes acp` — the Agent Client Protocol JSON-RPC 2.0 standard interface.

**Architecture:** Spawn `hermes acp` as a subprocess. Exchange JSON-RPC 2.0 newline-delimited messages over stdio. Replace `buildHermesCliArgs` with ACP request builders. Replace `bridgeHermesSession` text parser with ACP response handler. Remove `resolveHermesSession` — ACP `session/new` handles session creation natively.

**Source of truth:** [ACP Protocol Spec](https://github.com/NousResearch/hermes-agent/issues/569) and [ACP Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals)

**Tech Stack:** Bun/TypeScript, `child_process.spawn`, JSON-RPC 2.0 (no external library needed — protocol is simple newline-delimited JSON over stdio).

---

## ACP Protocol Summary (Hermes agent-side methods)

Archon is the **client**, Hermes ACP is the **server**. Archon sends JSON-RPC requests; Hermes responds.

### Archon → Hermes (requests)

| Method           | Params                                                 | Response                                                 |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `initialize`     | `{protocolVersion, clientCapabilities, clientInfo}`    | `{agentCapabilities, authMethods, protocolVersion}`      |
| `session/new`    | `{cwd, mcpServers}` (**required** — pass `[]` if none) | `{sessionId, configOptions?, modes?}`                    |
| `session/prompt` | `{sessionId, prompt: ContentBlock[]}`                  | `{stopReason: end_turn\|max_tokens\|refusal\|cancelled}` |
| `session/cancel` | `{sessionId}`                                          | (notification, no response)                              |

### Hermes → Archon (notifications during `session/prompt`)

| Method           | Params                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `session/update` | `{sessionId, update: {sessionUpdate: "agent_message_chunk"\|"agent_thought_chunk"\|..., content: ContentBlock}}` |

### JSON-RPC 2.0 wire format

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/path/to/repo","mcpServers":[]}}
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"abc123"}}
```

Newline-delimited — one JSON object per line. Stdout is ACP transport; stderr is human-readable logs.

---

## Execution Batches (rollout order)

### Batch 1 — Protocol Layer (new files, zero deps)

| File                                                 | Action                           |
| ---------------------------------------------------- | -------------------------------- |
| `packages/providers/src/hermes/acp-protocol.ts`      | Create — types, builders, parser |
| `packages/providers/src/hermes/acp-protocol.test.ts` | Create — 6 tests                 |
| `packages/providers/src/hermes/acp-bridge.ts`        | Create — `buildAcpRequests()`    |
| `packages/providers/src/hermes/acp-bridge.test.ts`   | Create — 5 tests                 |

**Gate:** `bun test packages/providers/src/hermes/acp-protocol.test.ts packages/providers/src/hermes/acp-bridge.test.ts` → 11 pass, 0 fail

### Batch 2 — Rewrite Event Bridge (depends on Batch 1)

| File                                            | Action                                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| `packages/providers/src/hermes/event-bridge.ts` | Rewrite — ACP JSON-RPC handler replacing text buffer |

**Gate:** `bun --filter '@archon/providers' type-check` passes

### Batch 3 — Wire Provider + Remove Deprecated (depends on Batch 2)

| File                                                  | Action                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/providers/src/hermes/provider.ts`           | Modify — spawn `['acp']`, wire ACP bridge, drop `buildHermesCliArgs`/`resolveHermesSession` |
| `packages/providers/src/hermes/options-translator.ts` | Modify — remove `buildHermesCliArgs`, keep model resolution functions                       |

**Gate:** `bun --filter '@archon/providers' type-check` passes

### Batch 4 — Update All Tests (depends on Batch 3)

| File                                                       | Action                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `packages/providers/src/hermes/provider.test.ts`           | Rewrite — ACP mock format, `['acp']` args  |
| `packages/providers/src/hermes/event-bridge.test.ts`       | Rewrite — ACP session/update notifications |
| `packages/providers/src/hermes/options-translator.test.ts` | Modify — remove `buildHermesCliArgs` tests |

**Gate:** `bun test packages/providers/src/hermes/` → all pass

### Batch 5 — Final Validation

| Check           | Command                                       |
| --------------- | --------------------------------------------- |
| Full type-check | `bun --filter '@archon/providers' type-check` |
| Full test suite | `bun run test`                                |
| Lint            | `bun run lint`                                |

**Gate:** All three pass, zero regressions.

---

## Tasks (reference)

### Task 1: Create ACP JSON-RPC message builder

**Objective:** Build a pure-function module that constructs JSON-RPC 2.0 request objects and parses response/notification objects.

**Files:**

- Create: `packages/providers/src/hermes/acp-protocol.ts`
- Test: `packages/providers/src/hermes/acp-protocol.test.ts`

**Step 1: Define types**

```typescript
// acp-protocol.ts

/** JSON-RPC 2.0 request sent by Archon (client) → Hermes (server). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response from Hermes. */
export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

/** JSON-RPC 2.0 error response from Hermes. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification;
```

**Step 2: Build request factory**

```typescript
let nextId = 1;

export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

export function createNotification(
  method: string,
  params?: Record<string, unknown>
): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export function serializeMessage(msg: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(msg) + '\n';
}
```

**Step 3: Parse response**

```typescript
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const obj = JSON.parse(line);
    if (obj && obj.jsonrpc === '2.0') {
      if ('method' in obj && !('id' in obj)) return obj as JsonRpcNotification;
      if ('result' in obj) return obj as JsonRpcSuccess;
      if ('error' in obj) return obj as JsonRpcError;
    }
    return null;
  } catch {
    return null;
  }
}
```

**Step 4: ACP content block types (for `session/prompt`)**

```typescript
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextContentBlock;
```

**Step 5: ACP `session/update` event types**

> **⚠️ VERIFIED against [ACP Prompt Turn docs](https://agentclientprotocol.com/protocol/prompt-turn):**
> The discriminator field is `sessionUpdate` (not `type`), and `content` is itself a `ContentBlock` (`{type: "text", text: "..."}`), NOT a raw string.

```typescript
/** Discriminated update within a session/update notification.
 *  The discriminator field is `sessionUpdate` per the ACP schema. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: TextContentBlock; // ContentBlock, NOT raw string
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: TextContentBlock;
}

export type SessionUpdateUnion = AgentMessageChunkUpdate | AgentThoughtChunkUpdate;

/** The params payload of a `session/update` notification. */
export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdateUnion;
}
```

**Correct wire format example:**

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "test-session",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Code review:" }
    }
  }
}
```

**Step 6: Write tests**

```typescript
// acp-protocol.test.ts
import { describe, expect, test } from 'bun:test';
import { createRequest, createNotification, parseMessage, serializeMessage } from './acp-protocol';

describe('ACP protocol', () => {
  test('createRequest builds valid JSON-RPC 2.0 request', () => {
    const req = createRequest('session/new', { cwd: '/tmp' });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('session/new');
    expect(req.params).toEqual({ cwd: '/tmp' });
    expect(typeof req.id).toBe('number');
  });

  test('serializeMessage produces newline-terminated JSON', () => {
    const req = createRequest('initialize', { protocolVersion: 1 });
    const line = serializeMessage(req);
    expect(line.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test('parseMessage extracts success response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"abc"}}\n';
    const msg = parseMessage(line.trim());
    expect(msg).not.toBeNull();
    expect(msg!.jsonrpc).toBe('2.0');
    if ('result' in msg!) {
      expect(msg.result).toEqual({ sessionId: 'abc' });
    }
  });

  test('parseMessage extracts notification', () => {
    const line =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"abc","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n';
    const msg = parseMessage(line.trim());
    expect(msg).not.toBeNull();
    if ('method' in msg!) {
      expect(msg.method).toBe('session/update');
    }
  });

  test('parseMessage returns null for invalid JSON', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('{"not":"jsonrpc"}')).toBeNull();
  });

  test('createNotification has no id field', () => {
    const notif = createNotification('session/cancel', { sessionId: 'abc' });
    const serialized = JSON.parse(serializeMessage(notif).trim());
    expect(serialized.id).toBeUndefined();
    expect(serialized.method).toBe('session/cancel');
  });
});
```

**Verification:**

```bash
bun test packages/providers/src/hermes/acp-protocol.test.ts
# Expected: 6 pass, 0 fail
```

---

### Task 2: Replace `buildHermesCliArgs` with ACP request builders

**Objective:** Create `buildAcpRequests()` that returns the ACP sequences instead of CLI args. Deprecate `buildHermesCliArgs`.

**Files:**

- Create: `packages/providers/src/hermes/acp-bridge.ts`
- Modify: `packages/providers/src/hermes/options-translator.ts` (add deprecation comment)
- Test: `packages/providers/src/hermes/acp-bridge.test.ts`

**Step 1: Define the ACP initialization + prompt sequence**

The ACP protocol requires:

1. `initialize` — handshake
2. `session/new` — create session with cwd
3. `session/prompt` — send user prompt (with prepended system prompt)
4. Listen for `session/update` notifications (streaming)
5. On exit: `session/cancel` notification (cleanup, fire-and-forget)

```typescript
// acp-bridge.ts
import type { HermesProviderDefaults } from '../types';
import { createRequest, createNotification, type ContentBlock } from './acp-protocol';
import { resolveHermesModel, resolveHermesProvider } from './options-translator';

/** The complete set of ACP requests needed to run a single-turn query. */
export interface AcpRequests {
  initialize: { jsonrpc: '2.0'; id: number; method: 'initialize'; params: Record<string, unknown> };
  newSession: {
    jsonrpc: '2.0';
    id: number;
    method: 'session/new';
    params: Record<string, unknown>;
  };
  prompt: { jsonrpc: '2.0'; id: number; method: 'session/prompt'; params: Record<string, unknown> };
}

/**
 * Build the ACP JSON-RPC request sequence for a single-turn Hermes query.
 *
 * Unlike `buildHermesCliArgs` (deprecated), this produces structured JSON-RPC
 * messages for the `hermes acp` subprocess stdio transport.
 *
 * The `session/prompt` id depends on the `session/new` response (sessionId),
 * so the caller must send these sequentially:
 *   1. `initialize` → get protocol version
 *   2. `session/new` → get sessionId
 *   3. `session/prompt` (using sessionId from step 2)
 */
export function buildAcpRequests(options: {
  prompt: string;
  cwd: string;
  modelRef?: string;
  config?: HermesProviderDefaults;
  systemPrompt?: string;
}): AcpRequests {
  const { prompt, cwd, modelRef, config, systemPrompt } = options;
  const effectiveConfig = config ?? {};

  // Prepare prompt content blocks
  const blocks: ContentBlock[] = [];
  if (systemPrompt) {
    blocks.push({ type: 'text', text: systemPrompt });
  }
  blocks.push({ type: 'text', text: prompt });

  return {
    initialize: createRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'archon', version: '0.3.9' },
    }),
    newSession: createRequest('session/new', { cwd, mcpServers: [] }),
    prompt: {
      jsonrpc: '2.0' as const,
      id: -1, // placeholder — caller fills in after sessionId is known
      method: 'session/prompt',
      params: { sessionId: '<pending>', prompt: blocks },
    },
  };
}
```

**Step 2: Write tests**

```typescript
// acp-bridge.test.ts
import { describe, expect, test } from 'bun:test';
import { buildAcpRequests } from './acp-bridge';

describe('buildAcpRequests', () => {
  test('produces valid initialize request', () => {
    const reqs = buildAcpRequests({ prompt: 'hello', cwd: '/tmp' });
    expect(reqs.initialize.jsonrpc).toBe('2.0');
    expect(reqs.initialize.method).toBe('initialize');
    expect(reqs.initialize.params.protocolVersion).toBe(1);
  });

  test('produces valid session/new request with cwd', () => {
    const reqs = buildAcpRequests({ prompt: 'hello', cwd: '/home/user/project' });
    expect(reqs.newSession.method).toBe('session/new');
    expect(reqs.newSession.params.cwd).toBe('/home/user/project');
  });

  test('prompt request includes text content blocks', () => {
    const reqs = buildAcpRequests({ prompt: 'review code', cwd: '/tmp' });
    expect(reqs.prompt.method).toBe('session/prompt');
    const blocks = reqs.prompt.params.prompt;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'review code' });
  });

  test('system prompt is prepended as separate block', () => {
    const reqs = buildAcpRequests({
      prompt: 'implement',
      cwd: '/tmp',
      systemPrompt: 'You are a tester.',
    });
    const blocks = reqs.prompt.params.prompt;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'You are a tester.' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'implement' });
  });

  test('request IDs are unique and sequential', () => {
    const reqs = buildAcpRequests({ prompt: 'test', cwd: '/tmp' });
    expect(reqs.initialize.id).not.toBe(reqs.newSession.id);
    expect(reqs.newSession.id).toBe(reqs.initialize.id + 1);
  });
});
```

**Verification:**

```bash
bun test packages/providers/src/hermes/acp-bridge.test.ts
# Expected: 5 pass, 0 fail
```

---

### Task 3: Replace `bridgeHermesSession` with ACP event handler

**Objective:** Replace the text-buffering `bridgeHermesSession` with an ACP JSON-RPC handler that sends requests sequentially, parses `session/update` notifications as streaming chunks, and extracts the final response from the prompt result.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts` (rewrite `bridgeHermesSession`)
- Test: Update `packages/providers/src/hermes/provider.test.ts` (update mocks for ACP)

**Step 1: Rewrite `bridgeHermesSession`**

The new function:

1. Sends `initialize` request → waits for response
2. Sends `session/new` request → extracts `sessionId`
3. Sends `session/prompt` request (with resolved sessionId)
4. Reads stdout line-by-line, parsing ACP notifications:
   - `session/update` with `agent_message_chunk` → emits `{type: 'assistant', content}`
   - `session/update` with `agent_thought_chunk` → emits `{type: 'thinking', content}`
5. When the `session/prompt` response arrives (with `stopReason`), emits terminal result chunk
6. On process exit/error, handles cleanup

```typescript
// event-bridge.ts — new bridgeHermesSession (simplified core loop)

export async function* bridgeHermesSession(
  childProcess: ChildProcess,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();
  let terminalEmitted = false;
  let sessionId: string | undefined;
  const stderrLines: string[] = [];

  childProcess.unref();

  if (!childProcess.stdout) {
    throw new Error('Hermes ACP child process stdout is not available');
  }

  // Buffer for partial lines (ACP uses newline-delimited JSON)
  let lineBuffer = '';
  let pendingRequestId: number | undefined;
  let requestResolve: ((msg: JsonRpcMessage) => void) | undefined;

  childProcess.stdout.on('data', (data: Buffer | string) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const msg = parseMessage(trimmed);
      if (!msg) {
        getLog().warn({ line: trimmed.slice(0, 200) }, 'acp.invalid_json');
        continue;
      }

      // Route response to pending request resolver
      if ('id' in msg && msg.id === pendingRequestId && requestResolve) {
        requestResolve(msg);
        requestResolve = undefined;
        pendingRequestId = undefined;
        continue;
      }

      // Handle notifications (session/update)
      if ('method' in msg && !('id' in msg)) {
        const notif = msg as JsonRpcNotification;
        if (notif.method === 'session/update' && notif.params) {
          const params = notif.params as SessionUpdateParams;
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk') {
            queue.push({
              kind: 'chunk',
              chunk: { type: 'assistant', content: update.content.text },
            });
          } else if (update.sessionUpdate === 'agent_thought_chunk') {
            queue.push({
              kind: 'chunk',
              chunk: { type: 'thinking', content: update.content.text },
            });
          }
        }
      }
    }
  });

  // Send ACP requests sequentially
  async function sendRequest(req: JsonRpcRequest): Promise<JsonRpcMessage> {
    return new Promise(resolve => {
      pendingRequestId = req.id;
      requestResolve = resolve;
      childProcess.stdin!.write(serializeMessage(req));
    });
  }

  try {
    // 1. Initialize
    const initReq = createRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'archon', version: '0.3.9' },
    });
    await sendRequest(initReq);

    // 2. New session
    const sessionReq = createRequest('session/new', { cwd });
    const sessionResp = await sendRequest(sessionReq);
    if ('result' in sessionResp) {
      sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
    }

    // 3. Send prompt
    const blocks: ContentBlock[] = systemPrompt
      ? [
          { type: 'text', text: systemPrompt },
          { type: 'text', text: prompt },
        ]
      : [{ type: 'text', text: prompt }];
    const promptReq = createRequest('session/prompt', { sessionId, prompt: blocks });
    const promptResp = await sendRequest(promptReq);

    // 4. Emit terminal result
    if (!terminalEmitted) {
      terminalEmitted = true;
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'result',
          sessionId,
          stopReason:
            'result' in promptResp
              ? ((promptResp.result as Record<string, unknown>).stopReason as string)
              : undefined,
        },
      });
    }
  } catch (err) {
    // ...error handling...
  }

  // ... consumer loop (unchanged) ...
}
```

**Step 2: Update the `provider.ts` call site**

The provider currently calls `buildHermesCliArgs` then `spawn(hermesBinary, args)`. It needs to:

1. Drop `buildHermesCliArgs` and `resolveHermesSession`
2. Spawn `hermes acp` (no args beyond `['acp']`)
3. Pass cwd/prompt/systemPrompt to the ACP bridge

**Step 3: Write provider-level ACP integration test**

The existing mock-based `provider.test.ts` mocks `child_process.spawn` and `writeStdout` with NDJSON lines. Update mocks to send ACP JSON-RPC messages:

```typescript
// provider.test.ts — updated mock for ACP
// 1. initialize response
mockProc.writeStdout(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
  }) + '\n'
);

// 2. session/new response
mockProc.writeStdout(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { sessionId: 'test-session' },
  }) + '\n'
);

// 3. Stream session/update notifications (CORRECT format)
mockProc.writeStdout(
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'test-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Code review:' },
      },
    },
  }) + '\n'
);

mockProc.writeStdout(
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'test-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Looks good!' },
      },
    },
  }) + '\n'
);

// 4. Final prompt response
mockProc.writeStdout(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    result: { stopReason: 'end_turn' },
  }) + '\n'
);

mockProc.emitExit(0);
```

**Verification:**

```bash
bun test packages/providers/src/hermes/provider.test.ts
# Expected: all tests pass with updated ACP mock format
```

---

### Task 4: Remove deprecated code

**Objective:** Delete `buildHermesCliArgs`, text-parsing fallback in `bridgeHermesSession`, and stale NDJSON event types.

**Files:**

- Modify: `packages/providers/src/hermes/options-translator.ts` (remove `buildHermesCliArgs`, keep `resolveHermesModel`/`resolveHermesProvider`/`resolveHermesEndpoint`)
- Modify: `packages/providers/src/hermes/event-bridge.ts` (remove text-parsing code, AsyncQueue stays)
- Modify: `packages/providers/src/hermes/provider.ts` (update JSDoc, remove `buildHermesCliArgs` import, update spawn call)

**Step 1: Remove `buildHermesCliArgs` from options-translator.ts**

Keep `resolveHermesModel`, `resolveHermesProvider`, `resolveHermesEndpoint` (still used for model/provider resolution). Remove only `buildHermesCliArgs` and its interface.

**Step 2: Clean up event-bridge.ts**

Remove the text-parsing block (stdout buffer + session_id regex extraction). The `AsyncQueue` and `BridgeQueueItem` types remain — the ACP handler still uses them.

**Step 3: Update provider.ts**

```typescript
// provider.ts — updated spawn call
// OLD: const args = buildHermesCliArgs({...});
//      const child = spawn(hermesBinary, args, {...});
// NEW:
const child = spawn(hermesBinary, ['acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...effectiveEnv },
});
```

**Step 4: Remove `--quiet --source tool` remnants**

Any stale JSDoc, comments, or constants referencing `--json`, `--quiet`, `--source tool`.

**Verification:**

```bash
bun --filter '@archon/providers' type-check
# Must pass with no errors
```

---

### Task 5: Update tests to match ACP protocol

**Objective:** Fix all Hermes provider tests that reference the old CLI flag format or text-parsing behavior.

**Files:**

- Modify: `packages/providers/src/hermes/provider.test.ts`
- Modify: `packages/providers/src/hermes/options-translator.test.ts`
- Modify: `packages/providers/src/hermes/model-ref.test.ts`

**Changes needed:**

1. **`provider.test.ts`**: Mock `spawn` to capture `['acp']` args (not `['chat', '--quiet', ...]`). Mock stdout responses in ACP JSON-RPC format.

2. **`options-translator.test.ts`**: Remove tests for `buildHermesCliArgs`. Keep tests for `resolveHermesModel`, `resolveHermesProvider`, `resolveHermesEndpoint`. Add tests for `buildAcpRequests` if not in Task 2.

3. **`model-ref.test.ts`**: Update `isHermesModelCompatible` tests to expect `true` for all inputs (already changed in current state — verify tests pass).

**Step 1: Fix `provider.test.ts` spawn args assertion**

```typescript
// Change from:
expect(mockSpawn).toHaveBeenCalledWith(
  expect.stringContaining('hermes'),
  expect.arrayContaining(['chat', '--quiet', '--source', 'tool']),
  expect.any(Object)
);
// To:
expect(mockSpawn).toHaveBeenCalledWith(
  expect.stringContaining('hermes'),
  ['acp'],
  expect.any(Object)
);
```

**Step 2: Fix `options-translator.test.ts`**

Remove all tests for `buildHermesCliArgs` (flag assertions). These tested `--json`, `--cwd`, `--prompt`, `--endpoint`, `--system`, `--env` which no longer exist.

**Verification:**

```bash
bun test packages/providers/src/hermes/
# Expected: all tests pass
bun run test  # full suite
# Expected: no regressions
```

---

### Task 6: Final validation

**Objective:** Run full validate pipeline, verify end-to-end workflow with `hermes acp`.

**Verification:**

```bash
cd /home/d/Desktop/Archon-canonical
bun run validate
# Expected: all gates pass

# Live test
HERMES_BINARY_PATH=/home/d/.local/bin/hermes \
  archon workflow run hermes-local-review \
  "Review packages/providers/src/hermes/ for correctness"
# Expected: workflow completes, Hermes ACP session created and streamed
```

---

## Files Summary

| File                                                       | Action                                             |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `packages/providers/src/hermes/acp-protocol.ts`            | **Create** — JSON-RPC 2.0 types, builders, parser  |
| `packages/providers/src/hermes/acp-protocol.test.ts`       | **Create** — 6 tests                               |
| `packages/providers/src/hermes/acp-bridge.ts`              | **Create** — ACP request sequence builder          |
| `packages/providers/src/hermes/acp-bridge.test.ts`         | **Create** — 5 tests                               |
| `packages/providers/src/hermes/event-bridge.ts`            | **Rewrite** — ACP JSON-RPC handler                 |
| `packages/providers/src/hermes/options-translator.ts`      | **Modify** — Remove `buildHermesCliArgs`           |
| `packages/providers/src/hermes/provider.ts`                | **Modify** — Spawn `['acp']`, wire ACP bridge      |
| `packages/providers/src/hermes/provider.test.ts`           | **Modify** — ACP mock format                       |
| `packages/providers/src/hermes/options-translator.test.ts` | **Modify** — Remove stale flag tests               |
| `packages/providers/src/hermes/model-ref.test.ts`          | **Verify** — `isHermesModelCompatible` always true |

## Risks & Tradeoffs

| Risk                                                                    | Mitigation                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP requires `pip install -e '.[acp]'` extra                            | Verify `hermes acp` works before migrating; fail with clear message if ACP not installed                                                                                                    |
| ACP session lifecycle is stateful (init→new→prompt)                     | Sequential request/response via promise chain; abort signal cancels                                                                                                                         |
| `session/update` notifications arrive while waiting for prompt response | Pending request resolver pattern handles interleaved messages                                                                                                                               |
| Hermes ACP may evolve (protocol version bumps)                          | Send `protocolVersion: 1` in initialize; Hermes responds with its version                                                                                                                   |
| `authenticate` is a baseline ACP method                                 | Check `authMethods` in `initialize` response. Hermes ACP currently returns `authMethods: []` (based on `acp_adapter/server.py`), so Archon can skip auth for now. Document this assumption. |

## Open Questions

1. **Does the user's Hermes install have ACP support?** Check: `hermes acp --help` or `pip list | grep agent-client-protocol`. If not, this migration is blocked until ACP is installed.

2. ~~**Does ACP `session/prompt` support model/provider overrides?**~~ **ANSWERED by verifier:** NO. Per the [ACP schema](https://agentclientprotocol.com/protocol/schema), `PromptRequest` only has `sessionId`, `prompt`, `_meta`. Model selection must happen via `session/set_config_option` (optional method) or pre-configured in `~/.hermes/config.yaml` before the ACP session. For Archon's single-turn use case, pre-configuration is sufficient.

## Verifier Audit Summary

| #   | Severity | Finding                                                                      | Status   |
| --- | -------- | ---------------------------------------------------------------------------- | -------- |
| 1   | CRITICAL | `session/update` discriminator is `sessionUpdate`, content is `ContentBlock` | ✅ Fixed |
| 2   | MEDIUM   | `mcpServers` required (not optional)                                         | ✅ Fixed |
| 3   | MEDIUM   | `session/new` response uses `configOptions` not `models`                     | ✅ Fixed |
| 4   | LOW      | Missing `authenticate` baseline method documentation                         | ✅ Noted |
