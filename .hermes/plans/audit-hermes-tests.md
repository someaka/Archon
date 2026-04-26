# Hermes Provider + ACP Integration + Tests Audit

**Date:** 2026-04-26
**Scope:** `packages/providers/src/hermes/` + `packages/providers/src/test/mocks/` + `packages/providers/package.json`
**Commits:** based on `dev` branch (recent: `287fab93`, `cc39437a`, `41c7947f`, `b0f9ecc1`)

---

## 1. ACP Protocol Issues

### 1.1 Production code polluted by test-only state (`acp-protocol.ts`)

- **Issue:** `resetAcpIdCounter()` is exported solely for tests to reset the module-global `nextId` counter.
- **Risk:** Mutable global state in production code is a design smell. Tests that forget to call `resetAcpIdCounter()` can flake due to ordering-dependent id values.
- **Location:** `acp-protocol.ts:36-41`

### 1.2 `session/cancel` sent as request instead of notification (`event-bridge.ts`)

- **Issue:** The abort handler comments "fire-and-forget" but calls `createRequest('session/cancel', ...)` which includes an auto-incrementing `id`. It should use `createNotification`.
- **Location:** `event-bridge.ts:288-299`
- **Impact:** Hermes server may queue a response for `session/cancel` that never gets read, causing a minor resource leak or protocol desync.

### 1.3 `createRequest` cast pollution (`event-bridge.ts`)

- **Issue:** `createRequest('session/cancel' as const, { sessionId } as unknown as Record<string, unknown>)` — two casts for a simple notification.
- **Root cause:** `createRequest` types are too narrow for ACP method names.
- **Location:** `event-bridge.ts:292-297`

### 1.4 Hardcoded version string (`event-bridge.ts` + `acp-bridge.ts`)

- **Issue:** `clientInfo: { name: 'archon', version: '0.3.9' }` is hardcoded in both `event-bridge.ts:344` and `acp-bridge.ts:22`. When the package version bumps, this drifts.
- **Fix:** Import from `package.json` or define a single `HERMES_CLIENT_VERSION` constant.

### 1.5 No validation of `id` field in `parseMessage` (`acp-protocol.ts`)

- **Issue:** `parseMessage` accepts any object with `jsonrpc: '2.0'` and `result`/`error`/`method` without validating that `id` is present and is a number/string for responses.
- **Impact:** Malformed responses could be mis-routed.
- **Location:** `acp-protocol.ts:77-89`

---

## 2. Bridge Issues

### 2.1 `acp-bridge.ts` is orphaned — event-bridge duplicates its logic

- **Issue:** `acp-bridge.ts` exports `buildAcpRequests()` which constructs `initialize`, `newSession`, and `prompt` requests. `event-bridge.ts` does NOT import or use this function; it rebuilds the same three requests inline (lines 341-372).
- **Impact:** `acp-bridge.ts` is dead code that compiles but is never exercised in production. Any fix to `buildAcpRequests` (e.g. the hardcoded version string) would not affect actual behavior.
- **Location:** `acp-bridge.ts:18-42` (unused) vs `event-bridge.ts:341-372` (duplicated inline)

### 2.2 `acp-bridge.ts` accepts `mcpServers` but MCP capability is `false`

- **Issue:** `BuildAcpRequestsOptions.mcpServers?: unknown[]` exists, but `HERMES_CAPABILITIES.mcp === false`. If a workflow node specifies `mcp`, the dag-executor warns correctly, but the bridge type signature falsely implies support.
- **Location:** `acp-bridge.ts:14`, `capabilities.ts:25`

### 2.3 `event-bridge.ts` doesn't guard `stdin` before writing on abort

- **Issue:** `sendRequest` checks `if (!childProcess.stdin)` and throws, but the abort handler writes to `childProcess.stdin?.write(...)` without this guard. The optional-chain prevents a crash, but it silently drops the cancel message instead of surfacing an error.
- **Location:** `event-bridge.ts:290`

### 2.4 Missing error path coverage in bridge

- **Issue:** `event-bridge.ts` handles `JsonRpcSuccess` responses for `initialize` and `session/new`, but does not explicitly handle `JsonRpcError` responses from those requests. If Hermes returns an error for `session/new`, the code tries to read `.sessionId` from the error object, which will be `undefined`, then throws `'Hermes ACP did not return a sessionId'`.
- **Location:** `event-bridge.ts:354-358`
- **Gap:** No test covers this error path.

### 2.5 `provider.ts` re-spreads `process.env`, re-introducing undefined values

- **Issue:** `resolveHermesSession` correctly filters `undefined` values from `process.env` (fixed in commit `cc39437a`), but `provider.ts:106` does `env: { ...process.env, ...session.env }`, which re-introduces `undefined` entries from `process.env` for keys not present in `session.env`.
- **Fix:** Change `env: { ...process.env, ...session.env }` to `env: session.env` since `resolveHermesSession` already performs the merge.
- **Location:** `provider.ts:106`

---

## 3. Test Quality Gaps

### 3.1 Orphaned `acp-bridge.ts` has no integration test

- **Issue:** `acp-bridge.test.ts` tests the standalone `buildAcpRequests` function, but there is no test asserting that `event-bridge.ts` or `provider.ts` actually uses it. Because they don't, the test gives false confidence.
- **Location:** `acp-bridge.test.ts`

### 3.2 `systemPrompt` test in `event-bridge.test.ts` is superficial

- **Issue:** The test `systemPrompt is sent as separate ContentBlock` (line 497-506) only asserts on the `result` chunk count. It never inspects the stdin payload to verify the `systemPrompt` was actually prepended as a `ContentBlock`.
- **Location:** `event-bridge.test.ts:497-506`

### 3.3 `provider.test.ts` `resumeSessionId` test doesn't assert protocol behavior

- **Issue:** The test `resume session is accepted without throwing` verifies no error is thrown, but does not assert that `resumeSessionId` is ignored (as expected) or that it is passed through the ACP protocol.
- **Location:** `provider.test.ts:303-313`

### 3.4 No tests for malformed JSON-RPC in stdout

- **Issue:** Neither `event-bridge.test.ts` nor `provider.test.ts` tests the behavior when Hermes emits non-JSON lines or JSON that is not valid JSON-RPC 2.0.
- **Gap:** `parseMessage` returns `null` for invalid input, but the `data` event handler just logs a warning. No test verifies this warning path.

### 3.5 No tests for `initialize` or `session/new` returning JSON-RPC errors

- **Issue:** The happy path is well covered, but error responses from the first two ACP handshake requests are not tested.
- **Impact:** The bug in 2.4 (mis-handled error responses) is not caught by tests.

### 3.6 Duplicate mock code across test files

- **Issue:** `provider.test.ts` (lines 50-160) and `event-bridge.test.ts` (lines 65-203) both contain near-identical inline `createAcpMock` factories.
- **Impact:** Maintenance burden; fixing a mock bug requires editing two files.
- **Note:** The shared `hermes-cli.mock.ts` exists but is incompatible with the ACP protocol and unused (see 4.1).

### 3.7 `binary-resolver.test.ts` doesn't test logging

- **Issue:** The mock logger is passed but never asserted. Successful resolution should log at `info` level, but no test verifies this.
- **Location:** `binary-resolver.test.ts`

### 3.8 `options-translator.test.ts` JSDoc claim is untested and false

- **Issue:** `model-ref.ts:77-78` claims `resolveHermesModel` "falls back to the configured HERMES_MODEL env var". The code does not do this. There is no test for it either.
- **Location:** `model-ref.ts:77-78`, `options-translator.ts:19-41`

---

## 4. Mock Completeness

### 4.1 `hermes-cli.mock.ts` is completely unused and stale

- **Issue:** `packages/providers/src/test/mocks/hermes-cli.mock.ts` defines `MockHermesEvent` with types like `text_delta`, `tool_start`, `tool_output`, `tool_end`, `error`, `done`. These are from a pre-ACP Hermes CLI integration that used `--json` mode. The current ACP protocol uses `session/update` notifications with `agent_message_chunk` / `agent_thought_chunk`.
- **Impact:** 361 lines of dead code. None of the exported functions (`createMockHermesProcess`, `createSimpleTextMock`, `createToolUseMock`, `createErrorMock`, `createHermesErrorEventMock`) are imported by any test file.
- **Verification:** `grep -r "createMockHermesProcess\|createSimpleTextMock\|createToolUseMock\|createErrorMock\|createHermesErrorEventMock" packages/providers/src/ --include="*.ts"` only returns hits inside the mock file itself.

### 4.2 `provider.test.ts` mocks `child_process` globally

- **Issue:** `mock.module('child_process', () => ({ spawn: mockSpawn }))` replaces the entire `child_process` module for all tests in the same batch. If any other test file in the same batch imports `child_process`, it gets the mock.
- **Location:** `provider.test.ts:23-25`

---

## 5. Test Batching Configuration

### 5.1 All Hermes tests (except binary-resolver) run in a single process

- **Issue:** `package.json` line 21 groups 8 test files into one `bun test` invocation:
  ```
  bun test src/hermes/config.test.ts src/hermes/model-ref.test.ts src/hermes/options-translator.test.ts src/hermes/session-resolver.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts src/hermes/acp-bridge.test.ts
  ```
- **Risk of mock pollution:**
  - `event-bridge.test.ts` mocks `@archon/paths`
  - `provider.test.ts` mocks `@archon/paths` AND `child_process`
  - `session-resolver.test.ts` mocks `@archon/paths`
  - `mock.module()` is process-global and irreversible in Bun (`mock.restore()` does NOT undo it).
  - Per project rules (CLAUDE.md): "Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation."
  - The batch violates this rule. The last-loaded mock wins, meaning earlier tests may run against the wrong mock factory.
- **Fix:** Split into isolated batches. Suggested grouping:
  - Batch 1 (no mocks): `config.test.ts`, `model-ref.test.ts`, `options-translator.test.ts`, `acp-protocol.test.ts`
  - Batch 2 (mocks `@archon/paths`): `event-bridge.test.ts`
  - Batch 3 (mocks `@archon/paths` + `child_process`): `provider.test.ts`
  - Batch 4 (mocks `@archon/paths`): `session-resolver.test.ts`
  - Batch 5 (dynamic import cache-busting): `binary-resolver.test.ts`
  - Batch 6 (no mocks): `acp-bridge.test.ts` (or merge with batch 1)

### 5.2 `binary-resolver.test.ts` correctly isolated

- **Observation:** It is the only Hermes test in its own `bun test` invocation. It uses dynamic import cache-busting (`?t=${importCounter++}`), which is the correct pattern for testing both `BUNDLED_IS_BINARY=true/false`.
- **Location:** `package.json:21` (trailing `&& bun test src/hermes/binary-resolver.test.ts`)

---

## 6. Stale References to Old Bridge

### 6.1 `acp-bridge.ts` is a stale abstraction

- **Issue:** The file was likely intended to be the canonical ACP request builder used by `event-bridge.ts`. After `event-bridge.ts` was written, it inlined the logic instead, leaving `acp-bridge.ts` as a stale, unused module.
- **Evidence:** `event-bridge.ts` imports from `acp-protocol.ts` directly but never imports `buildAcpRequests` from `acp-bridge.ts`.

### 6.2 `hermes-cli.mock.ts` references old `--json` bridge

- **Issue:** As noted in 4.1, the entire mock file is a stale artifact from a pre-ACP integration.

### 6.3 No other stale references found

- **Observation:** `grep -r "acp-bridge\|acp_bridge\|AcpBridge\|old bridge" packages/providers/src/ --include="*.ts"` only returns hits inside `acp-bridge.ts` and `acp-bridge.test.ts` themselves. No other files reference the old bridge.

---

## 7. Configuration/Runtime Wiring Gaps

### 7.1 `provider.ts` ignores Hermes model/provider/endpoint config at runtime

- **Issue:** `parseHermesConfig` and `resolveHermesModel` / `resolveHermesProvider` / `resolveHermesEndpoint` exist and are exported from the package, but `HermesProvider.sendQuery` never calls them. The `hermes` CLI is spawned with only `cwd` and `env` — no `--model`, `--provider`, `--endpoint`, or `--global-auth` flags are passed.
- **Impact:** User configuration in `.archon/config.yaml` under `assistants.hermes` is effectively ignored at runtime.
- **Location:** `provider.ts:82-106`

### 7.2 `mcpServers: []` sent in ACP init despite MCP capability being `false`

- **Issue:** `event-bridge.ts:351` sends `mcpServers: []` in the `session/new` request. The capability flag says `mcp: false`. This is harmless but inconsistent.
- **Location:** `event-bridge.ts:349-352`

---

## Summary Table

| Category            | Count | Severity    |
| ------------------- | ----- | ----------- |
| ACP Protocol Issues | 5     | Medium      |
| Bridge Issues       | 6     | Medium-High |
| Test Quality Gaps   | 8     | Medium      |
| Mock Completeness   | 2     | Medium      |
| Test Batching       | 1     | High        |
| Stale References    | 3     | Low-Medium  |
| Runtime Wiring      | 2     | High        |

**Highest priority fixes:**

1. Fix test batching to prevent mock pollution.
2. Wire `provider.ts` to use config-derived model/provider/endpoint (or remove the dead code).
3. Either delete `acp-bridge.ts` and use it in `event-bridge.ts`, or delete it and consolidate.
4. Delete `hermes-cli.mock.ts` or rewrite it for ACP.
5. Fix `provider.ts` env spread to avoid re-introducing `undefined` values.
