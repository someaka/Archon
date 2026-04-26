# Cross-Provider Audit: Codex + Hermes vs. Claude + Pi

## Scope

Audited directories:

- `packages/providers/src/codex/` (9 files)
- `packages/providers/src/hermes/` (16 files)
- `packages/providers/src/claude/` (8 files)
- `packages/providers/src/community/pi/` (16 files)

Plus contract layer: `packages/providers/src/types.ts`, `packages/providers/src/registry.ts`

---

## 1. Cross-Provider Duplication

### 1.1 Binary Resolver Pattern — Triplicated (Claude / Codex / Hermes)

All three built-in providers implement the same env → config → autodetect → throw resolution pipeline with only provider-specific strings changed.

| File                        | Lines | Throws in binary mode?  | Vendor dir checked?  | # autodetect paths        |
| --------------------------- | ----- | ----------------------- | -------------------- | ------------------------- |
| `claude/binary-resolver.ts` | 117   | Yes                     | No                   | 1 (`~/.local/bin/claude`) |
| `codex/binary-resolver.ts`  | 166   | Yes                     | Yes (`vendor/codex`) | 4 (platform-specific)     |
| `hermes/binary-resolver.ts` | 102   | No (falls back to PATH) | No                   | 1 (`~/.local/bin/hermes`) |

**Duplicated code:**

- `fileExists()` wrapper around `fs.existsSync` (identical, ~3 lines each)
- Lazy-initialized `cachedLog` + `getLog()` helper (identical, ~5 lines each)
- Env-var override → config override → autodetect → outcome branching (same structure)
- Install-instructions string formatting (same pattern, different text)

**Gap:** No shared `BinaryResolver` base or factory. The `BUNDLED_IS_BINARY` guard, `fileExists` wrapper, and tiered resolution logic are copy-pasted.

### 1.2 Logger Lazy-Init Pattern — Quadrupled

Every provider file contains the exact same boilerplate:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.<name>');
  return cachedLog;
}
```

Found in:

- `claude/provider.ts:42-47`
- `codex/provider.ts:23-28`
- `hermes/provider.ts:17-21`
- `hermes/event-bridge.ts:15-18`
- `hermes/binary-resolver.ts:28-32`
- `pi/provider.ts:92-96`
- `pi/event-bridge.ts:7-10`
- plus binary resolver files

**Gap:** No `getLogger(name)` utility in `@archon/paths` or `@archon/providers`.

### 1.3 Retry Classification Constants — Duplicated (Claude / Codex)

Claude and Codex share the same retry taxonomy but duplicate the constants:

```typescript
// claude/provider.ts:97-109
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'operation aborted'];

// codex/provider.ts:120-129
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'codex exec'];
```

Only `SUBPROCESS_CRASH_PATTERNS` differs by one entry (`'operation aborted'` vs `'codex exec'`).

**Gap:** No shared `classifyError(message, patterns)` utility.

### 1.4 Retry Orchestration — Duplicated (Claude / Codex)

Both Claude and Codex implement the same retry loop:

- `MAX_SUBPROCESS_RETRIES = 3`
- `RETRY_BASE_DELAY_MS = 2000`
- Exponential backoff: `delayMs = baseDelayMs * Math.pow(2, attempt)`
- Same error-class enrichment pattern: `` `${Provider} ${errorClass}: ${message}` ``
- Same `lastError` fallback throw

Claude: `provider.ts:955-1036`
Codex: `provider.ts:564-622`

**Gap:** No shared `RetryingProvider` base class or `withRetry()` wrapper.

### 1.5 AsyncQueue — Duplicated (Hermes / Pi)

The `AsyncQueue<T>` class is copy-pasted verbatim between:

- `hermes/event-bridge.ts:39-92`
- `pi/event-bridge.ts:29-84`

Same single-consumer invariant enforcement, same `close()` semantics, same buffer + waiters design.

**Gap:** No shared async queue in `@archon/providers` or `@archon/core`.

### 1.6 Session Resume Fallback Message — Duplicated (Codex / Pi)

Both emit an identical system warning when resume fails:

```typescript
// codex/provider.ts:553-558
yield {
  type: 'system',
  content: '⚠️ Could not resume previous session. Starting fresh conversation.',
};

// pi/provider.ts:339-344
yield {
  type: 'system',
  content: '⚠️ Could not resume Pi session. Starting fresh conversation.',
};
```

---

## 2. Shared Abstraction Gaps

### 2.1 No Unified Env Builder

Four different env-merging strategies, none shared:

| Provider | Process.env filtering                  | Request env precedence       | Notes                                                    |
| -------- | -------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Claude   | None (direct spread)                   | `requestOptions.env` wins    | `buildSubprocessEnv()` just returns `{ ...process.env }` |
| Codex    | Filters `undefined` values             | `requestEnv` wins            | `buildCodexEnv()` uses `Object.entries().filter()`       |
| Hermes   | Filters `typeof !== 'string'`          | `session.env` wins           | `resolveHermesSession()` iterates and copies manually    |
| Pi       | Config env injected into `process.env` | BashSpawnHook for subprocess | Two separate env channels (config vs request)            |

**Impact:** Security-relevant divergence. If a provider accidentally leaks `undefined` values into a subprocess env, behavior varies by provider. Hermes is the most defensive (filters non-strings); Claude is the most permissive (direct spread).

### 2.2 No Unified Stream Normalizer Interface

Each provider implements its own `async function* streamEvents(...)`:

- `claude/provider.ts:709-828` — `streamClaudeMessages()`
- `codex/provider.ts:190-425` — `streamCodexEvents()`
- `hermes/event-bridge.ts:137-433` — `bridgeHermesSession()`
- `pi/event-bridge.ts:275-387` — `bridgeSession()`

All do the same job (SDK/native events → `MessageChunk[]`), but with no common interface or helper for:

- Abort-signal handling
- Terminal `result` chunk guarantee
- Structured output normalization
- Error event → system chunk conversion

### 2.3 No Unified Config Parser Base

All config parsers (`parseClaudeConfig`, `parseCodexConfig`, `parseHermesConfig`, `parsePiConfig`) implement the same defensive "typeof check + assign" pattern independently. No shared `defensiveAssign<T>(raw, key, validator)` helper.

### 2.4 No Unified Tool-Result Serialization

- Claude: tool results are captured via SDK hooks into a `ToolResultEntry[]` queue, then drained during stream normalization
- Codex: tool results are emitted inline during `item.completed` event processing
- Pi: tool results are emitted inline during `tool_execution_end` event mapping
- Hermes: no tool concept in ACP v1

No shared `ToolResult` type or serialization helper (Pi has `serializeToolResult()` in `event-bridge.ts`, but it's local).

### 2.5 No Unified Model-Ref Parser

Hermes and Pi both model provider/model split refs, but implement their own:

- `hermes/model-ref.ts:33-67` — `parseHermesModelRef()`
- `pi/model-ref.ts:21-42` — `parsePiModelRef()`

Different split logic (`'hermes:'` prefix vs bare `'/'` split), different validation (`/^[a-z][a-z0-9-]*$/` vs no provider validation).

---

## 3. Inconsistent Patterns

### 3.1 Binary Resolver Dev-Mode Divergence

In dev mode (`BUNDLED_IS_BINARY=false`):

- Claude: returns `undefined` (SDK resolves from node_modules)
- Codex: returns `undefined` (SDK resolves from node_modules)
- Hermes: returns `undefined`, \*\*but caller falls back to `'hermes'` from PATH

In binary mode when not found:

- Claude: **throws** with install instructions
- Codex: **throws** with install instructions
- Hermes: **returns `undefined`** (caller falls back to PATH)

**Inconsistency:** Hermes is the outlier — it never throws from the resolver, while Claude and Codex treat missing binaries as fatal in compiled builds. This is intentional (Hermes may be in PATH) but the divergence is undocumented in any central place.

### 3.2 `outputFormat` vs `output_format` Path Divergence

Codex has special dual-path handling:

```typescript
// codex/provider.ts:159-177
function buildTurnOptions(requestOptions?: SendQueryOptions) {
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.outputFormat.schema;
  }
  if (requestOptions?.nodeConfig?.output_format && !requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.nodeConfig.output_format;
  }
}
```

Claude handles `output_format` inside `applyNodeConfig()` (nodeConfig path only), and `outputFormat` inside `buildBaseClaudeOptions()` (requestOptions path only). The two paths don't overlap cleanly — `requestOptions.outputFormat` is not checked inside `applyNodeConfig()`.

**Impact:** If a workflow sets `output_format` at the node level and the orchestrator also passes `outputFormat` at the request level, behavior differs between Claude and Codex.

### 3.3 Structured Output Capability Declaration vs Implementation

| Provider | Capability flag           | Implementation                               |
| -------- | ------------------------- | -------------------------------------------- |
| Claude   | `structuredOutput: true`  | SDK-enforced (`options.outputFormat`)        |
| Codex    | `structuredOutput: true`  | SDK-enforced (`turnOptions.outputSchema`)    |
| Pi       | `structuredOutput: true`  | Best-effort prompt augmentation + JSON parse |
| Hermes   | `structuredOutput: false` | Comment says "best-effort" but flag is false |

Hermes `capabilities.ts` has an extensive comment explaining why structured output is "best-effort" and "not SDK-enforced", yet the flag is set to `false`. This contradicts the comment. If the capability flag is meant to reflect wired-up behavior, and Hermes has a `--json` flag, the flag may be under-declared.

### 3.4 Session Resume Semantics Divergence

| Provider | resumeSessionId handling                | Failure mode                                                  |
| -------- | --------------------------------------- | ------------------------------------------------------------- |
| Claude   | Sets `options.resume = resumeSessionId` | SDK handles resume internally; no fallback                    |
| Codex    | Calls `codex.resumeThread(id, opts)`    | Catches error, falls back to `startThread()` + system warning |
| Pi       | Calls `SessionManager.open(match.path)` | Falls back to fresh session + system warning                  |
| Hermes   | Ignored (`void resumeSessionId`)        | No warning; no resume support                                 |

Claude is the outlier — it delegates resume entirely to the SDK with no fallback or user notification if the session doesn't exist. Codex and Pi both explicitly handle "resume failed" and notify the user. Hermes silently ignores.

### 3.5 Abort Signal Handling Divergence

| Provider | Strategy                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------- |
| Claude   | Per-attempt `AbortController`; parent `abortSignal` listener calls `currentController.abort()` |
| Codex    | Passes `signal` in `TurnOptions`; checks `abortSignal.aborted` between events                  |
| Hermes   | Sends `session/cancel` ACP notification + `SIGTERM` + `SIGKILL` fallback after 5s              |
| Pi       | Calls `session.abort()` fire-and-forget; listener removed in finally                           |

No shared abort handling contract. Each provider invented its own cancellation semantics.

### 3.6 `nodeConfig` Translation Divergence

Claude has the richest `applyNodeConfig()` implementation (`provider.ts:361-527`), handling:

- `allowed_tools` / `denied_tools`
- `hooks` (with SDK hook building)
- `mcp` (with config loading + env expansion)
- `skills` (with AgentDefinition wrapping)
- `agents` (with collision detection)
- `effort`, `thinking`, `sandbox`, `betas`, `output_format`, `maxBudgetUsd`, `systemPrompt`, `fallbackModel`

Codex has no `nodeConfig` translation at all — it only reads from `requestOptions` and `assistantConfig`. Node-level `output_format` is handled ad-hoc in `buildTurnOptions()`.

Pi has `options-translator.ts` which handles `thinking`/`effort`, `allowed_tools`/`denied_tools`, and `skills` — but the surface area is smaller.

Hermes has no nodeConfig translation (ACP v1 is minimal).

**Gap:** There's no shared "nodeConfig capability guard" that checks which fields a provider supports before translation. The dag-executor does capability-flag warnings, but the actual field mapping is entirely per-provider.

---

## 4. Env Merging Differences (Detailed)

### 4.1 Claude

```typescript
// provider.ts:84-95
function buildSubprocessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}
// provider.ts:928
const env = requestOptions?.env ? { ...subprocessEnv, ...requestOptions.env } : subprocessEnv;
```

- No filtering of `undefined` values
- No filtering of non-string values
- Direct `process.env` spread into subprocess

### 4.2 Codex

```typescript
// provider.ts:82-88
function buildCodexEnv(requestEnv: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...requestEnv };
}
```

- Filters `undefined` values from `process.env`
- No type narrowing (relies on type assertion)
- Explicit `Record<string, string>` return type

### 4.3 Hermes

```typescript
// session-resolver.ts:53-65
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') {
    env[key] = value;
  }
}
if (providedEnv) {
  for (const [key, value] of Object.entries(providedEnv)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
}
```

- Most defensive: filters `typeof !== 'string'` for both process.env and providedEnv
- Iterates manually instead of spreading
- Used in `spawn()` as `{ ...process.env, ...session.env }` in `provider.ts:106` — wait, this is a **bug**: `resolveHermesSession` already merged process.env into session.env, but then `provider.ts` does `env: { ...process.env, ...session.env }`, which means process.env values are duplicated. The session.env already contains process.env, so the spread is redundant but harmless.

### 4.4 Pi

Two separate env channels:

1. Config-level: `piConfig.env` → applied to `process.env` at session start (for in-process extensions)
2. Request-level: `requestOptions.env` → injected into bash subprocess via `BashSpawnHook`

No direct equivalent to Claude/Codex's "spread process.env then override" pattern.

---

## 5. Spawn Pattern Differences

| Provider | Spawn mechanism                               | Archon controls spawn args?             | Stdio access?                                  |
| -------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Claude   | SDK spawns internally                         | Partially (via `executableArgs`, `env`) | No direct access; captures stderr via callback |
| Codex    | SDK spawns internally via `Codex` class       | Partially (via constructor `env`)       | No direct access; reads from event stream      |
| Hermes   | `child_process.spawn('hermes', ['acp'], ...)` | Full control                            | Direct access to stdin/stdout/stderr           |
| Pi       | In-process (no spawn)                         | N/A                                     | N/A                                            |

**Impact:** Hermes is the only provider that can implement custom abort logic (SIGTERM + SIGKILL fallback). Claude/Codex rely on SDK-level abort support. Pi relies on `session.abort()`.

**Impact:** Only Hermes can directly parse stdout line-by-line for a custom protocol (ACP JSON-RPC). Claude and Codex are locked into their SDKs' event shapes.

---

## 6. Chunk Emission Differences

### 6.1 Event types yielded by each provider

| Chunk type          | Claude              | Codex                             | Hermes | Pi                            |
| ------------------- | ------------------- | --------------------------------- | ------ | ----------------------------- |
| `assistant`         | Yes                 | Yes                               | Yes    | Yes                           |
| `thinking`          | No                  | Yes                               | Yes    | Yes                           |
| `tool`              | Yes                 | Yes                               | No     | Yes                           |
| `tool_result`       | Yes                 | Yes                               | No     | Yes                           |
| `system`            | Yes (MCP init only) | Yes (errors, todos, file changes) | No     | Yes (warnings, retry notices) |
| `rate_limit`        | Yes                 | No                                | No     | No                            |
| `result`            | Yes                 | Yes                               | Yes    | Yes                           |
| `workflow_dispatch` | No                  | No                                | No     | No                            |

**Note:** The `workflow_dispatch` type exists in `MessageChunk` but no provider yields it.

### 6.2 Codex-specific enrichments not present elsewhere

Codex is the only provider that yields:

- `todo_list` → `system` chunk with task list formatting + deduplication
- `file_change` → `system` chunk with file change summary (add/update/delete icons)
- `web_search` → `tool` + `tool_result` pair
- `mcp_tool_call` → `tool` + `tool_result` pair with special formatting

These are Codex SDK-specific event types with no equivalent in Claude, Pi, or Hermes.

### 6.3 Structured output normalization divergence

| Provider | Where parsed                                            | Failure behavior            |
| -------- | ------------------------------------------------------- | --------------------------- |
| Claude   | SDK returns `structured_output` on result event         | Pass-through                |
| Codex    | Parses `agent_message` text as JSON on `turn.completed` | Yields system warning chunk |
| Pi       | Parses accumulated assistant text on `agent_end`        | Silent omission (logged)    |
| Hermes   | N/A (capability false)                                  | N/A                         |

Codex and Pi both do best-effort JSON parsing, but Codex emits a warning chunk while Pi logs silently. This means a Codex workflow with bad structured output shows a UI warning; a Pi workflow with bad structured output fails silently from the user's perspective (only logs).

---

## 7. Dead / Duplicated Code

### 7.1 `hermes/acp-bridge.ts` is orphaned

`hermes/acp-bridge.ts` exports `buildAcpRequests()`, but `hermes/event-bridge.ts` constructs the same three requests (`initialize`, `session/new`, `session/prompt`) inline rather than importing `buildAcpRequests()`. The file is not imported by `hermes/provider.ts`.

**Verification:**

- `hermes/provider.ts` imports: `bridgeHermesSession` from `./event-bridge`
- `hermes/event-bridge.ts` imports: `createRequest`, `parseMessage`, `serializeMessage` from `./acp-protocol`
- No import of `buildAcpRequests` anywhere in the provider.

### 7.2 `hermes/acp-bridge.ts` and `hermes/event-bridge.ts` version drift risk

Both hardcode `clientInfo: { name: 'archon', version: '0.3.9' }`. If the version is bumped, both must be updated. Since `acp-bridge.ts` is unused, only `event-bridge.ts` matters in practice.

---

## 8. Test Pattern Inconsistencies

### 8.1 Binary resolver test splits

Codex splits binary resolver tests into three files:

- `binary-resolver.test.ts` (binary mode)
- `binary-resolver-dev.test.ts` (dev mode)
- `binary-guard.test.ts` (integration with provider)

Claude has only:

- `binary-resolver.test.ts` (binary mode)
- `binary-resolver-dev.test.ts` (dev mode)
- No `binary-guard.test.ts` equivalent

Hermes has:

- `binary-resolver.test.ts` (binary mode)
- No `binary-resolver-dev.test.ts` (dev mode coverage missing?)

### 8.2 Mock isolation comments

Codex tests have detailed comments explaining why files must run in separate `bun test` invocations (BUNDLED_IS_BINARY mock conflicts). Claude tests have the same pattern but fewer comments. Hermes and Pi test files were not fully audited for mock isolation comments.

---

## 9. Registry Observations

### 9.1 `registerBuiltinProviders()` hardcodes Claude and Codex

`registry.ts:109-146` constructs `ClaudeProvider` and `CodexProvider` inline, while Hermes is registered via `registerHermesProvider()`. This means:

- Hermes can be registered independently
- Claude/Codex cannot be registered independently without calling `registerBuiltinProviders()`
- Pi is registered via `registerCommunityProviders()` → `registerPiProvider()`

### 9.2 `isModelCompatible` inconsistency

- Claude: checks aliases (`sonnet`, `opus`, `haiku`) + `claude-*` prefix + `inherit`
- Codex: negation of Claude's check (!claude aliases)
- Hermes: always returns `true`
- Pi: syntactic check only (`parsePiModelRef` !== undefined)

Codex's `isModelCompatible` is fragile — it assumes anything that isn't a Claude alias is valid for Codex. This would incorrectly validate gibberish strings like `"foo-bar"` as Codex-compatible.

---

## 10. Recommendations (Ranked by Impact)

### High Impact

1. **Extract shared binary resolver** — Create `packages/providers/src/shared/binary-resolver.ts` with a factory that accepts provider-specific config (env var name, config key, autodetect paths, install instructions). Reduce 3 copy-pasted implementations to 1.

2. **Extract shared retry machinery** — Create a `withRetry()` wrapper or `RetryingProvider` base class. Claude and Codex share identical retry loops, classification patterns, and delay math. Hermes may need retry in the future.

3. **Extract `AsyncQueue`** — Move the duplicated `AsyncQueue<T>` to `@archon/core` or `@archon/providers`. Used by Hermes and Pi; likely useful for future providers.

4. **Unify env builder** — Create a single `buildSubprocessEnv(processEnv, requestEnv)` that all providers use. Decide on the filtering strategy (Hermes' `typeof === 'string'` is safest) and apply consistently.

### Medium Impact

5. **Add `binary-guard.test.ts` for Claude** — Claude lacks the integration test that verifies the binary path is passed through to the SDK constructor. Codex has this (`binary-guard.test.ts`); Claude should too.

6. **Delete or wire up `hermes/acp-bridge.ts`** — Either delete the orphaned file or refactor `event-bridge.ts` to use `buildAcpRequests()`. If kept, deduplicate the version string.

7. **Standardize structured output failure UX** — Codex emits a `system` warning; Pi logs silently. Pick one behavior (recommend Codex's warning-chunk approach) and apply to both.

8. **Standardize session resume fallback** — Claude should follow Codex/Pi pattern: catch missing session, fall back to new session, warn user. Currently Claude delegates to SDK with no fallback.

### Low Impact

9. **Extract lazy-logger helper** — Add `createLazyLogger(name)` to `@archon/paths` to eliminate the 8+ copies of `cachedLog` + `getLog()`.

10. **Fix Codex `isModelCompatible`** — Don't use negation of Claude's check. Add actual Codex model validation (e.g., `gpt-*` prefix or known Codex model list).

11. **Hermes capabilities comment vs flag** — Either set `structuredOutput: true` (if `--json` is wired) or update the comment to match the `false` flag.

---

## Appendix: File Inventory

```
packages/providers/src/
├── types.ts                          # Contract layer
├── registry.ts                       # Provider registry
├── errors.ts                         # UnknownProviderError
├── claude/
│   ├── provider.ts                   # Main provider (1043 lines)
│   ├── config.ts                     # parseClaudeConfig
│   ├── capabilities.ts               # CLAUDE_CAPABILITIES
│   ├── binary-resolver.ts            # resolveClaudeBinaryPath
│   ├── index.ts                      # Re-exports
│   ├── provider.test.ts              # Main tests
│   ├── binary-resolver.test.ts       # Binary mode tests
│   └── binary-resolver-dev.test.ts   # Dev mode tests
├── codex/
│   ├── provider.ts                   # Main provider (629 lines)
│   ├── config.ts                     # parseCodexConfig
│   ├── capabilities.ts               # CODEX_CAPABILITIES
│   ├── binary-resolver.ts            # resolveCodexBinaryPath
│   ├── index.ts                      # Re-exports
│   ├── provider.test.ts              # Main tests
│   ├── binary-guard.test.ts          # Binary → provider integration tests
│   ├── binary-resolver.test.ts       # Binary mode tests
│   └── binary-resolver-dev.test.ts   # Dev mode tests
├── hermes/
│   ├── provider.ts                   # Main provider (128 lines)
│   ├── config.ts                     # parseHermesConfig
│   ├── capabilities.ts               # HERMES_CAPABILITIES
│   ├── binary-resolver.ts            # resolveHermesBinary
│   ├── model-ref.ts                  # parseHermesModelRef
│   ├── options-translator.ts         # resolveHermesModel, resolveHermesEndpoint
│   ├── session-resolver.ts           # resolveHermesSession
│   ├── event-bridge.ts               # bridgeHermesSession, AsyncQueue
│   ├── acp-bridge.ts                 # buildAcpRequests (ORPHANED)
│   ├── acp-protocol.ts               # JSON-RPC types + createRequest
│   ├── registration.ts               # registerHermesProvider
│   └── index.ts                      # Re-exports
│   └── [various .test.ts files]
└── community/pi/
    ├── provider.ts                   # Main provider (468 lines)
    ├── config.ts                     # parsePiConfig
    ├── capabilities.ts               # PI_CAPABILITIES
    ├── model-ref.ts                  # parsePiModelRef
    ├── options-translator.ts         # resolvePiThinkingLevel, resolvePiTools, resolvePiSkills
    ├── session-resolver.ts           # resolvePiSession
    ├── event-bridge.ts               # bridgeSession, AsyncQueue, mapPiEvent
    ├── ui-context-stub.ts            # createArchonUIContext, createArchonUIBridge
    ├── resource-loader.ts            # createNoopResourceLoader
    ├── registration.ts               # registerPiProvider
    └── index.ts                      # Re-exports
    └── [various .test.ts files]
```
