# Master Audit Synthesis: Providers + Utilities + Tests

**Scope:** `packages/providers/src/` (Claude, Codex, Hermes, Pi), `packages/paths/src/`, `packages/core/src/utils/`, `packages/providers/src/test/mocks/`
**Sources:**

- `audit-claude-provider.md`
- `audit-codex-cross-provider.md`
- `audit-pi-utilities.md`
- `audit-hermes-tests.md`
  **Date:** 2026-04-26

---

## Methodology

1. Read all four per-domain audits.
2. Deduplicated findings that appeared in multiple audits (e.g., `AsyncQueue` duplication noted in Claude, Codex, and Pi audits).
3. Re-ranked severity across the full surface. A finding marked "High" in a single audit was downgraded if its cross-cutting impact was lower, and vice-versa.
4. Grouped by theme. Within each severity level, findings are ordered by theme then impact.

---

## Severity Legend

| Level         | Meaning                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL**  | Can cause crashes, security breaches, silent data corruption, or completely unreliable test results. Fix immediately. |
| **IMPORTANT** | Causes incorrect runtime behavior, user-facing bugs, significant test gaps, or type-safety holes. Fix in next sprint. |
| **MINOR**     | Technical debt, naming inconsistencies, duplication, or low-impact dead code. Fix opportunistically.                  |

---

## CRITICAL Findings

### Test Reliability & Coverage

#### C1. Hermes Test Batching Causes Mock Pollution

- **Source:** Hermes audit 5.1
- **Issue:** 8 Hermes test files run in a single `bun test` invocation. `event-bridge.test.ts`, `provider.test.ts`, and `session-resolver.test.ts` all `mock.module('@archon/paths')` (and `provider.test.ts` also mocks `child_process`). Bun's `mock.module()` is process-global and irreversible; `mock.restore()` does NOT undo it.
- **Impact:** Tests run against the wrong mock factory depending on load order. Results are unreliable. This directly violates the project's own mock-isolation rules (CLAUDE.md).
- **Fix:** Split into isolated batches: (1) no mocks, (2) `@archon/paths` only, (3) `@archon/paths` + `child_process`.

### Security, Trust Boundaries & Environment

#### C2. Pi `enableExtensions` Default Mismatches Documentation

- **Source:** Pi audit 1.1
- **Issue:** `PiProviderDefaults` JSDoc says `enableExtensions` defaults to `false` ("Opt-in... Disabled by default"). The implementation uses `piConfig.enableExtensions !== false`, so `undefined` evaluates to `true`.
- **Impact:** Silent trust-boundary violation. Users who omit the key are opted into Pi extensions unexpectedly.
- **Fix:** Align implementation with docs (`=== true`) OR update JSDoc to `@default true` if intentional.

#### C3. Pi Permanently Mutates `process.env`

- **Source:** Pi audit 1.2
- **Issue:** `assistantConfig.env` entries are written to `process.env` if not already present. They are never removed after `sendQuery` completes. Claude and Codex pass env through SDK options without mutating global state.
- **Impact:** Env vars leak across runs and into subsequent provider calls. A workflow setting `PLANNOTATOR_REMOTE=1` for one Pi run pollutes all later processes.
- **Fix:** Scope vars to the Pi session lifecycle, or document that config env is global and permanent.

---

## IMPORTANT Findings

### Error Handling & Robustness

#### I1. Deterministic Errors Are Retried

- **Source:** Claude audit 4.2
- **Issue:** The retry loop in `sendQuery()` retries on _any_ classified error. Invalid model names, missing binaries, and root UID checks are retried, wasting API budget and time.
- **Fix:** Add a `deterministic: boolean` flag to error classification so the retry loop can skip non-retryable failures immediately.

#### I2. `withFirstMessageTimeout` Does Not Abort the Underlying SDK Call

- **Source:** Claude audit 4.3
- **Issue:** The wrapper throws `FirstMessageTimeoutError` after a `setTimeout`, but it does not call `abortController.abort()`. The SDK request continues running and consuming tokens/budget after the timeout.
- **Fix:** Signal `abortController.abort()` before throwing the timeout error.

#### I3. `expandEnvVars` Silently Coerces `undefined` to String

- **Source:** Claude audit 4.5
- **Issue:** `$VAR_NAME` is replaced with `process.env[VAR_NAME]` even when the env var is undefined, resulting in the literal string `"undefined"`.
- **Fix:** Leave the placeholder intact or emit a `ProviderWarning` when expansion fails.

#### I4. Pi Has No Retry Logic for Transient Failures

- **Source:** Pi audit 1.3
- **Issue:** Claude and Codex classify errors (rate-limit, auth, crash) and retry with exponential backoff (`MAX_SUBPROCESS_RETRIES = 3`). Pi throws raw SDK errors immediately.
- **Impact:** A single transient rate-limit or subprocess crash surfaces as a hard failure requiring manual `/workflow resume`.
- **Fix:** Add error classification + retry loop consistent with Claude/Codex.

#### I5. Pi Passes Raw SDK Errors Through Unclassified

- **Source:** Pi audit 1.4
- **Issue:** Claude has `classifyAndEnrichError`; Codex has `classifyAndEnrichCodexError`. Pi passes SDK errors through unmodified.
- **Impact:** Users see raw Pi SDK stack traces instead of actionable Archon-classified messages with retry hints.
- **Fix:** Add a `classifyPiError(err)` helper.

#### I6. Missing Rate Limit Handling in Hermes and Pi

- **Source:** Claude audit 4.12
- **Issue:** Claude and Codex explicitly classify `rate_limit` errors and retry with backoff. Hermes and Pi have no equivalent detection, even though their backends (Ollama, OpenRouter, etc.) can rate-limit.

#### I7. `abortSignal` Listener Leak in Hermes Event Bridge

- **Source:** Claude audit 4.8
- **Issue:** If `bridgeHermesSession()` throws between registering the `abortSignal` listener and entering the `try/finally` block, the listener is never removed.
- **Fix:** Pair `addEventListener` with a `try/finally` or use `AbortSignal.any()` if available.

#### I8. Pi Event Bridge Silently Drops Unknown Event Types

- **Source:** Pi audit 4.2
- **Issue:** `mapPiEvent` has `default: return []`. If Pi adds a new event type (e.g., `agent_think`, `file_change`), Archon ignores it without a trace.
- **Fix:** Log unknown event types at `debug` level so SDK upgrades are discoverable.

#### I9. Pi Abort Signal Checked Too Late

- **Source:** Pi audit 1.7
- **Issue:** Pi only checks `abortSignal` inside `bridgeSession`, after model lookup, auth resolution, session creation, and extension loading have already run.
- **Impact:** Wasted compute and API calls when the user cancels before the first yield.
- **Fix:** Add an early abort check before expensive SDK setup.

#### I10. Pi Empty-String Env Override Is Ignored

- **Source:** Pi audit 1.6
- **Issue:** `envOverride` uses `??` fallback. An explicit empty string in `requestOptions.env` is treated as missing and falls through to `process.env`.
- **Impact:** User cannot intentionally blank out a global env var for a specific workflow node.
- **Fix:** Check `envVarName in (requestOptions?.env ?? {})` instead of `??`.

#### I11. Pi `resolvePiSkills` Accepts Directories Named `SKILL.md`

- **Source:** Pi audit 1.5
- **Issue:** `existsSync(join(candidate, 'SKILL.md'))` returns `true` for directories. It should verify `isFile()`.

#### I12. Pi `buildBashSpawnHook` Lacks `undefined` Guard for `context.env`

- **Source:** Pi audit 1.9
- **Issue:** The spread `env: { ...context.env, ...env }` assumes `context.env` is defined. If Pi's SDK passes `undefined`, the spread crashes.

#### I13. Pi `session-resolver.ts` Swallows `ENOENT` Silently

- **Source:** Pi audit 1.8
- **Issue:** When `SessionManager.list()` throws `ENOENT` or `ENOTDIR`, the resolver falls back to a fresh session but never logs the event.
- **Fix:** Add a `debug` log before swallowing.

#### I14. Hermes `session/cancel` Sent as Request Instead of Notification

- **Source:** Hermes audit 1.2
- **Issue:** The abort handler comments "fire-and-forget" but calls `createRequest('session/cancel', ...)` with an auto-incrementing `id`. It should use `createNotification`.
- **Impact:** Hermes server may queue a response that never gets read, causing minor resource leak or protocol desync.

#### I15. Hermes Event-Bridge Doesn't Guard `stdin` Before Writing on Abort

- **Source:** Hermes audit 2.3
- **Issue:** `sendRequest` checks `if (!childProcess.stdin)` and throws, but the abort handler writes via `childProcess.stdin?.write(...)` without this guard. The optional-chain prevents a crash but silently drops the cancel message.

#### I16. Hermes Event-Bridge Mis-Handles JSON-RPC Error Responses

- **Source:** Hermes audit 2.4
- **Issue:** Handles `JsonRpcSuccess` for `initialize` and `session/new`, but does not explicitly handle `JsonRpcError`. Tries to read `.sessionId` from the error object (which is `undefined`), then throws `'Hermes ACP did not return a sessionId'`.
- **Gap:** No test covers this error path.

### Runtime Configuration & Wiring

#### I17. Hermes `provider.ts` Ignores Config at Runtime

- **Source:** Hermes audit 7.1
- **Issue:** `parseHermesConfig`, `resolveHermesModel`, `resolveHermesProvider`, and `resolveHermesEndpoint` exist and are exported, but `HermesProvider.sendQuery` never calls them. The CLI is spawned with only `cwd` and `env`.
- **Impact:** User config in `.archon/config.yaml` under `assistants.hermes` is effectively ignored.
- **Fix:** Wire the resolvers into `sendQuery`, or remove the dead code and its tests.

#### I18. Hermes `provider.ts` Re-Spreads `process.env`, Re-Introducing `undefined` Values

- **Source:** Hermes audit 2.5; Codex cross-provider 4.3
- **Issue:** `resolveHermesSession` correctly filters `undefined` values, but `provider.ts:106` does `env: { ...process.env, ...session.env }`. Since `session.env` already contains the merged process.env, this is redundant and re-introduces undefined entries.
- **Fix:** Change to `env: session.env`.

#### I19. Hermes Sends `mcpServers: []` Despite Capability `false`

- **Source:** Hermes audit 7.2
- **Issue:** `event-bridge.ts:351` sends `mcpServers: []` in the `session/new` request even though `HERMES_CAPABILITIES.mcp === false`. Harmless but inconsistent.

#### I20. `loadMcpConfig` Does Not Validate JSON Schema

- **Source:** Claude audit 4.6
- **Issue:** Reads a JSON file and expands env vars, but does not validate that the resulting object matches the expected MCP server config shape.
- **Impact:** Malformed JSON causes a downstream SDK error with no clear provenance.

#### I21. `shouldPassNoEnvFile` Logic Is Fragile

- **Source:** Claude audit 4.11
- **Issue:** Detects Node.js executables by checking if `process.argv[1]` ends with `.js` or `.cjs`. Fails for `ts-node`, `tsx`, bundled binaries, and symlinked entry points.

### Type Safety & Schema Integrity

#### I22. Hand-Written `ContentBlock` Duplicates SDK Type

- **Source:** Claude audit 2.1
- **Issue:** `claude/provider.ts` defines a local `ContentBlock` interface that mirrors the Claude SDK's type. CLAUDE.md explicitly says: "Import SDK types directly" and "Avoid defining duplicate types."
- **Impact:** SDK updates can drift from the hand-written type, causing runtime mismatches that TypeScript won't catch.

#### I23. `as` Assertions Abound in Claude Provider

- **Source:** Claude audit 2.2
- **Issue:** At least 15 `as` type assertions bypass the SDK's own types (e.g., `message.message.content as { type: string; text?: string }[]`).
- **Impact:** If the SDK changes shape, these fail silently at runtime.

#### I24. `NodeConfig.agents` Is Hand-Written Duplicate of Zod Schema

- **Source:** Claude audit 2.4; Pi audit 5.3
- **Issue:** `types.ts:191-228` acknowledges this explicitly: "Intentional hand-written duplicate... broken here on purpose... Drift risk." References follow-up #1276.
- **Impact:** When the schema gains a field, this shape must be updated by hand.

#### I25. `ProviderDefaults` Is Too Permissive

- **Source:** Claude audit 2.5
- **Issue:** `ProviderDefaults = Record<string, unknown>` defeats TypeScript's ability to validate provider-specific config shapes.

#### I26. `HermesProviderDefaults` Lacks Index Signature

- **Source:** Claude audit 2.7
- **Issue:** Unlike Claude, Codex, and Pi defaults, `HermesProviderDefaults` has no `[key: string]: unknown`. Excess property checks fail when passed through generic `ProviderDefaults` surfaces.

#### I27. `ProviderDefaultsMap` Is Under-Typed

- **Source:** Pi audit 5.4
- **Issue:** `Record<string, ProviderDefaults>` loses the knowledge that keys are provider IDs and values are specific defaults.

#### I28. `createRequest` Cast Pollution in Hermes Event-Bridge

- **Source:** Hermes audit 1.3
- **Issue:** `createRequest('session/cancel' as const, { sessionId } as unknown as Record<string, unknown>)` — two casts for a simple call. Root cause: `createRequest` types are too narrow for ACP method names.

#### I29. Hardcoded Version String in Hermes

- **Source:** Hermes audit 1.4
- **Issue:** `clientInfo: { name: 'archon', version: '0.3.9' }` is hardcoded in `event-bridge.ts` and the orphaned `acp-bridge.ts`. Drifts when the package version bumps.
- **Fix:** Import from `package.json` or define a single constant.

#### I30. No Validation of `id` Field in `parseMessage`

- **Source:** Hermes audit 1.5
- **Issue:** `parseMessage` accepts any object with `jsonrpc: '2.0'` without validating that `id` is present and is a number/string for responses.
- **Impact:** Malformed responses could be mis-routed.

### Test Coverage Gaps

#### I31. Codex Has Zero Dedicated Tests

- **Source:** Claude audit 6.2
- **Issue:** No dedicated test file for `CodexProvider`. The only Codex-related tests are in `registry.test.ts` (capability checks). Major gap for a built-in provider.

#### I32. Hermes Has No Dedicated Provider Tests

- **Source:** Claude audit 6.3
- **Issue:** No test file exists for `HermesProvider` as an integrated unit. Only registry-level tests verify its existence.

#### I33. Pi Has No Test Files At All

- **Source:** Claude audit 6.4
- **Issue:** `community/pi/` has zero test files. Complex dynamic imports, extension support, and event mapping are entirely untested.

#### I34. `buildSDKHooksFromYAML` Has Zero Test Coverage

- **Source:** Claude audit 4.10
- **Issue:** Complex YAML → SDK hook translation with `PostToolUse`/`PostToolUseFailure` capture. A malformed hook definition could crash the SDK at runtime.

#### I35. Claude Provider: Missing Dedicated Unit Tests

- **Source:** Claude audit 6.1
- **Missing:** `applyNodeConfig`, `buildBaseClaudeOptions`, `loadMcpConfig`, `expandEnvVars`, `buildSDKHooksFromYAML`, `buildToolCaptureHooks`, `withFirstMessageTimeout`, `parseClaudeConfig`, `resolveClaudeBinaryPath`, abort-signal mid-stream, `forkSession`, `persistSession: false`, `maxBudgetUsd`, `fallbackModel`, `output_format`, `sandbox`, `betas`.

#### I36. Hermes `systemPrompt` Test Is Superficial

- **Source:** Hermes audit 3.2
- **Issue:** Only asserts on result chunk count; never inspects the stdin payload to verify `systemPrompt` was actually prepended as a `ContentBlock`.

#### I37. Hermes `resumeSessionId` Test Doesn't Assert Protocol Behavior

- **Source:** Hermes audit 3.3
- **Issue:** Verifies no error is thrown, but does not assert that `resumeSessionId` is ignored (as expected) or passed through the ACP protocol.

#### I38. No Tests for Malformed JSON-RPC in stdout

- **Source:** Hermes audit 3.4
- **Issue:** `parseMessage` returns `null` for invalid input, but no test verifies the warning path.

#### I39. No Tests for `initialize` or `session/new` Returning JSON-RPC Errors

- **Source:** Hermes audit 3.5
- **Issue:** Happy path is covered, but error responses from handshake requests are not tested.

#### I40. Hermes Binary-Resolver Doesn't Test Logging

- **Source:** Hermes audit 3.7
- **Issue:** Mock logger is passed but never asserted. Successful resolution should log at `info` level.

#### I41. Hermes Options-Translator JSDoc Claim Is Untested and False

- **Source:** Hermes audit 3.8
- **Issue:** `model-ref.ts:77-78` claims `resolveHermesModel` falls back to `HERMES_MODEL` env var. The code does not do this. No test exists for it either.

#### I42. Claude Lacks `binary-guard.test.ts` Equivalent

- **Source:** Codex cross-provider 8.1
- **Issue:** Codex has an integration test verifying the binary path is passed through to the SDK constructor. Claude is missing this coverage.

### Dead Code & Maintenance

#### I43. `acp-bridge.ts` Is Orphaned Dead Code

- **Source:** Hermes audit 2.1, 3.1, 6.1; Codex cross-provider 7.1
- **Issue:** `buildAcpRequests()` is exported but `event-bridge.ts` never imports it; it rebuilds the same three requests inline. Tests give false confidence because production doesn't use the exported function.
- **Fix:** Delete the file, or refactor `event-bridge.ts` to use it and deduplicate the version string.

#### I44. `hermes-cli.mock.ts` Is Completely Unused and Stale

- **Source:** Hermes audit 4.1, 6.2
- **Issue:** 361 lines referencing a pre-ACP `--json` bridge protocol. None of its exports are imported by any test file. Verified by `grep`.

#### I45. `acp-protocol.ts` Polluted by Test-Only State

- **Source:** Hermes audit 1.1
- **Issue:** `resetAcpIdCounter()` exported solely for tests to reset the module-global `nextId` counter. Tests that forget to call it can flake.

### API / Interface Inconsistency

#### I46. `applyNodeConfig` Throws on Some Paths but Returns Warnings on Others

- **Source:** Claude audit 4.1
- **Issue:** Returns `ProviderWarning[]` for unsupported features (e.g., `skills` on non-Claude), but throws synchronously on invalid `agents` definitions. Callers must handle both return values AND exceptions.

#### I47. `applyNodeConfig` Called Twice Per `sendQuery` Attempt

- **Source:** Claude audit 2.3
- **Issue:** Called once on a throwaway `tempOptions` to collect warnings, and once on the real `options` inside the retry loop. Wasteful and confusing.
- **Fix:** Make the function pure: `buildClaudeOptions(nodeConfig, cwd): { options, warnings }`.

---

## MINOR Findings

### Duplication & Missing Shared Utilities

#### M1. `AsyncQueue<T>` Duplicated in Hermes and Pi

- **Source:** Claude audit 1.1; Codex cross-provider 1.5; Pi audit 2.2
- **Issue:** Identical class with single-consumer invariant, `close()` sentinel, buffer + waiters design. ~53 lines duplicated verbatim.
- **Fix:** Extract to `packages/providers/src/utils/async-queue.ts` (or `@archon/core`).

#### M2. Binary Resolver Pattern Triplicated (Claude / Codex / Hermes)

- **Source:** Claude audit 1.2; Codex cross-provider 1.1
- **Issue:** Same env-var → config-override → autodetect → throw/return pipeline. Same `fileExists()` wrapper, same lazy-logger, same tiered resolution. Only provider-specific strings differ.
- **Fix:** Generic `resolveBinaryPath({ envVar, configPath, autodetectPaths, throwOnMiss })` factory.

#### M3. Logger Lazy-Init/Caching Pattern Duplicated

- **Source:** Claude audit 1.5; Codex cross-provider 1.2; Pi audit 2.3
- **Issue:** Same `let cachedLog` / `function getLog()` boilerplate in 8+ files. `createLogger` is already cheap; the caching is unnecessary.
- **Fix:** Add `createLazyLogger(name)` to `@archon/paths`, or remove caching entirely.

#### M4. Retry Orchestration Duplicated (Claude / Codex)

- **Source:** Claude audit 1.6; Codex cross-provider 1.4
- **Issue:** Same max 3 retries, exponential backoff (base 2000ms), error classification, `withFirstMessageTimeout` wrapper, terminal `result` chunk emission.
- **Fix:** Extract `withRetry<T>(generator, { maxRetries, baseDelayMs, classifyError })`.

#### M5. Error Classification Constants Duplicated

- **Source:** Claude audit 1.3; Codex cross-provider 1.3
- **Issue:** `RATE_LIMIT_PATTERNS`, `AUTH_PATTERNS`, `SUBPROCESS_CRASH_PATTERNS` copy-pasted between Claude and Codex. Only one entry differs (`'operation aborted'` vs `'codex exec'`).
- **Fix:** Shared `classifyProviderError(error, rules)` where `rules` is provider-specific.

#### M6. Config Parsers Duplicated Across All Providers

- **Source:** Claude audit 1.7; Codex cross-provider 2.3; Pi audit 3.2
- **Issue:** All four providers implement the same defensive `typeof check + assign` pattern independently.
- **Fix:** Shared `parseProviderDefaults<T>(defaults, schema): T` or `pickString`/`pickBoolean` helpers.

#### M7. Env Var Expansion Duplicated (Claude / Pi)

- **Source:** Claude audit 1.4
- **Issue:** Same `$VAR_NAME` → `process.env[VAR_NAME]` pattern.
- **Fix:** Shared `expandEnvVars(str, env?)` utility.

#### M8. Environment Merging Duplicated (Hermes / Pi)

- **Source:** Claude audit 1.8
- **Issue:** Same `Object.entries(process.env)` baseline + override loop. Same `cwd` fallback to `process.cwd()`.
- **Fix:** Shared `resolveExecutionContext(cwd, env?)` utility.

#### M9. Event Bridge Pattern Duplicated (Hermes / Pi)

- **Source:** Claude audit 1.10
- **Issue:** Same `AsyncQueue`, same `kind: 'chunk' | 'done' | 'error'` discriminated union, same `for await` consumer loop with `try/finally`. ~250 lines of near-identical infrastructure.

#### M10. Model Ref Parsing Duplicated (Hermes / Pi)

- **Source:** Claude audit 1.11; Codex cross-provider 2.5
- **Issue:** Both split provider/model strings. Different split logic (`'hermes:'` prefix vs bare `'/'` split), different validation regex.
- **Fix:** Unified `parseModelRef(ref, { prefix? })` helper.

#### M11. `findMarkdownFilesRecursive` Duplicated

- **Source:** Pi audit 2.1
- **Issue:** `packages/paths/src/archon-paths.ts` and `packages/core/src/utils/commands.ts`. The `core` version lacks the `ENOENT` graceful guard that the `paths` version has.
- **Fix:** Delete the `core` version and import from `@archon/paths`.

### Inconsistency & Naming

#### M12. Binary Resolver Naming Divergence

- **Source:** Claude audit 5; Codex cross-provider
- **Issue:** `resolveClaudeBinaryPath`, `resolveCodexBinaryPath`, `resolveHermesBinary` (drops "Path"), `resolvePiBinaryPath`.

#### M13. Error Classifier Naming Divergence

- **Source:** Claude audit 5
- **Issue:** `classifyAndEnrichError` (Claude) vs `classifyAndEnrichCodexError` (Codex). Suggests Claude was original and Codex was copied without generic rename.

#### M14. Stream Normalizer Naming Divergence

- **Source:** Claude audit 5
- **Issue:** `streamClaudeMessages()`, `streamCodexEvents()`, inline in `bridgeHermesSession()`, `mapPiEvent()`.

#### M15. Binary Resolver Dev-Mode Divergence

- **Source:** Codex cross-provider 3.1
- **Issue:** In binary mode when not found: Claude/Codex **throw** with install instructions; Hermes **returns `undefined`** (caller falls back to PATH). Intentional but undocumented.

#### M16. `outputFormat` vs `output_format` Path Divergence

- **Source:** Codex cross-provider 3.2
- **Issue:** Codex has special dual-path handling. Claude handles `output_format` inside `applyNodeConfig()` and `outputFormat` inside `buildBaseClaudeOptions()`. If a workflow sets both node-level and request-level, behavior differs between providers.

#### M17. Session Resume Semantics Divergence

- **Source:** Codex cross-provider 3.4
- **Issue:** Claude delegates entirely to SDK with no fallback or user notification. Codex/Pi catch missing session, fall back to new session, warn user. Hermes silently ignores `resumeSessionId`.

#### M18. Env Merging Differences Across All Providers

- **Source:** Codex cross-provider section 4
- **Issue:**
  - Claude: direct `process.env` spread, no filtering.
  - Codex: filters `undefined` values.
  - Hermes: filters `typeof !== 'string'` (most defensive).
  - Pi: two separate channels (config env mutates global `process.env`; request env injected via BashSpawnHook).
- **Impact:** Security-relevant divergence in subprocess environment construction.

#### M19. Spawn Pattern Differences

- **Source:** Codex cross-provider section 5
- **Issue:** Claude/Codex rely on SDK internal spawn; Hermes directly spawns `child_process`; Pi is in-process. Only Hermes can implement custom abort logic (SIGTERM + SIGKILL).

#### M20. Chunk Emission Differences

- **Source:** Codex cross-provider section 6
- **Issue:** `thinking` chunks: Claude no, others yes. `tool`/`tool_result`: Hermes no. `system` chunks: semantics differ per provider. `rate_limit` chunks: only Claude. `workflow_dispatch` type exists but no provider yields it.

#### M21. Codex `isModelCompatible` Uses Negation of Claude Check

- **Source:** Codex cross-provider 9.2
- **Issue:** `!claude aliases` incorrectly validates gibberish like `"foo-bar"` as Codex-compatible.
- **Fix:** Add actual Codex model validation (e.g., `gpt-*` prefix or known list).

#### M22. `MessageChunk` Union Lacks Exhaustiveness Protection

- **Source:** Claude audit 2.6
- **Issue:** No `assertNever` helper. Unknown event types silently dropped rather than logged or warned.

#### M23. Hermes Structured Output Capability Flag Contradicts Comment

- **Source:** Codex cross-provider 3.3
- **Issue:** Comment says "best-effort" and "not SDK-enforced", implying possible support, yet flag is `false`. Either set `true` (if `--json` is wired) or update the comment.

#### M24. `nodeConfig` Translation Divergence

- **Source:** Codex cross-provider 3.6
- **Issue:** Claude has rich `applyNodeConfig()`; Codex has none; Pi has partial; Hermes has none. No shared "nodeConfig capability guard" that validates which fields a provider supports before translation.

#### M25. Registry Inline Construction vs Registration Functions

- **Source:** Codex cross-provider 9.1
- **Issue:** `registerBuiltinProviders()` constructs Claude/Codex inline, while Hermes/Pi are registered via independent functions. Inconsistent pattern.

### Architecture & Dead Code

#### M26. Claude `provider.ts` Is 1043 Lines

- **Source:** Claude audit 7.1
- **Issue:** Mixes retry orchestration, SDK option building, nodeConfig translation, stream normalization, error classification, MCP config loading, hook building, tool capture, timeout utilities, root UID check.
- **Fix:** Extract `claude/event-bridge.ts`, `claude/options-translator.ts`, `claude/session-resolver.ts`, `claude/hooks-builder.ts` to match Hermes/Pi structure.

#### M27. `registerBuiltinProviders` Hardcodes Provider IDs

- **Source:** Claude audit 7.3
- **Issue:** Adding a new built-in requires editing `registry.ts`. Convention-based discovery (e.g., scan `src/*/capabilities.ts`) would reduce friction.

#### M28. `@sinclair/typebox` Dead Dependency

- **Source:** Claude audit 7.4
- **Issue:** Listed in `packages/providers/package.json` dependencies but no provider code imports from it.

#### M29. `ProviderRegistration` Stores Capabilities Twice

- **Source:** Claude audit 7.2
- **Issue:** Registry stores both static `capabilities` and `factory().getCapabilities()`. For all current providers these are identical, but the design allows divergence.

#### M30. Pi Has No Constructor

- **Source:** Pi audit 3.3
- **Issue:** Missing root guard and retry delay option. Cannot accept runtime options or perform safety checks.

#### M31. Result Chunk Shape Completeness Differs Across Providers

- **Source:** Pi audit 3.5
- **Issue:** Claude sets the most fields; Codex sets only `sessionId`, `tokens`, `structuredOutput`; Pi is in between. Acceptable since all fields are optional, but not ideal.

### Test Quality

#### M32. Duplicate Mock Code Across Hermes Test Files

- **Source:** Hermes audit 3.6
- **Issue:** `provider.test.ts` and `event-bridge.test.ts` both contain near-identical inline `createAcpMock` factories.

#### M33. Hermes `provider.test.ts` Mocks `child_process` Globally

- **Source:** Hermes audit 4.2
- **Issue:** `mock.module('child_process', () => ({ spawn: mockSpawn }))` replaces the module for all tests in the batch.

#### M34. Codex/Hermes Test Split Inconsistency

- **Source:** Codex cross-provider 8.1
- **Issue:** Codex splits binary resolver tests into 3 files. Claude has 2. Hermes has only 1 (missing dev-mode coverage).

---

## Appendix: Cross-Cutting Recommendations (Priority Order)

### Immediate (This Week)

1. **Fix Hermes test batching** (C1) — split `bun test` invocations to eliminate mock pollution.
2. **Fix Pi `enableExtensions` default** (C2) — align docs and code.
3. **Stop Pi from mutating `process.env`** (C3) — scope env to session lifecycle.

### Short-Term (Next 2 Weeks)

4. **Add dedicated tests for CodexProvider** (I31) and `PiProvider` (I33).
5. **Wire Hermes config resolvers or delete dead code** (I17).
6. **Fix `withFirstMessageTimeout` to abort the SDK call** (I2).
7. **Add deterministic-error flag to retry logic** (I1).
8. **Delete or wire up `acp-bridge.ts`** (I43) and delete `hermes-cli.mock.ts` (I44).
9. **Add retry + error classification to Pi** (I4, I5).

### Medium-Term (Next Month)

10. **Extract shared utilities:** `AsyncQueue`, binary resolver, retry loop, error classifier, env expander/merger, config parser helpers, first-message timeout.
11. **Split `claude/provider.ts`** into focused modules matching Hermes/Pi structure.
12. **Fix type safety gaps:** remove hand-written `ContentBlock`, reduce `as` assertions, add index signature to `HermesProviderDefaults`, tighten `ProviderDefaultsMap`.
13. **Standardize env merging** across all providers (Hermes' `typeof === 'string'` filtering is the safest baseline).
14. **Standardize session resume fallback** — Claude should follow Codex/Pi pattern of catching missing session and warning the user.

### Opportunistic (Backlog)

15. Unify naming of error classifiers, stream normalizers, and binary resolvers.
16. Add `assertNever` helper for exhaustive `MessageChunk` switching.
17. Remove `@sinclair/typebox` dead dependency.
18. Unify `isModelCompatible` checks — stop using negation of another provider's logic.
19. Consider convention-based provider discovery to eliminate `registry.ts` hardcoding.

---

_End of synthesis._
