# AUDIT: Pi Provider + Project Utilities

**Scope:** `packages/providers/src/community/pi/*`, `packages/paths/src/*.ts`, `packages/core/src/utils/*.ts`, `packages/providers/src/types.ts`, `packages/providers/src/errors.ts`, `packages/providers/src/registry.ts`
**Date:** 2026-04-26
**Branch:** `archon/task-archon-provider-audit-1777216765968`

---

## 1. Pi-Specific Issues

### 1.1 `enableExtensions` defaults to `true`, but type docs say `@default false`

- **Location:** `packages/providers/src/types.ts:53`, `packages/providers/src/community/pi/provider.ts:359`
- **Issue:** `PiProviderDefaults` documents `enableExtensions` as defaulting to `false` ("Opt-in... Disabled by default"). The implementation uses `piConfig.enableExtensions !== false`, so `undefined` evaluates to `true`.
- **Risk:** Users reading the type docs expect an opt-in trust boundary; the implementation opts them in silently. A user who omits the key gets extensions enabled unexpectedly.
- **Fix:** Align implementation with docs (`piConfig.enableExtensions === true`) OR update the JSDoc to `@default true` if the behavior is intentional.

### 1.2 Pi mutates `process.env` permanently for config-level env vars

- **Location:** `packages/providers/src/community/pi/provider.ts:202-213`
- **Issue:** `assistantConfig.env` entries are written to `process.env` if not already present. They are never removed after `sendQuery` completes. Claude and Codex pass env through SDK options (`options.env`, `Codex({ env })`) without mutating global state.
- **Risk:** A workflow that sets `PLANNOTATOR_REMOTE=1` for one Pi run leaks that var into all subsequent Pi (and non-Pi) processes in the same Node process.
- **Fix:** Scope these vars to the Pi session lifecycle, or document that config env is global and permanent.

### 1.3 No retry logic for transient failures

- **Location:** `packages/providers/src/community/pi/provider.ts` (throughout `sendQuery`)
- **Issue:** Claude (`MAX_SUBPROCESS_RETRIES = 3`) and Codex (`MAX_SUBPROCESS_RETRIES = 3`) both classify errors (rate-limit, auth, crash) and retry with exponential backoff. Pi throws raw SDK errors immediately.
- **Risk:** A single transient rate-limit or subprocess crash surfaces as a hard failure to the user, requiring manual `/workflow resume`.
- **Fix:** Add error classification + retry loop consistent with Claude/Codex patterns.

### 1.4 No error classification / enrichment

- **Location:** `packages/providers/src/community/pi/provider.ts`
- **Issue:** Claude has `classifyAndEnrichError` mapping subprocess stderr + error messages into `rate_limit` | `auth` | `crash` | `unknown`. Codex has `classifyAndEnrichCodexError`. Pi passes SDK errors through unmodified.
- **Risk:** Users see raw Pi SDK stack traces instead of actionable Archon-classified messages.
- **Fix:** Add a `classifyPiError(err)` helper that produces enriched errors with retry hints, mirroring the built-in providers.

### 1.5 `resolvePiSkills` accepts directories named `SKILL.md`

- **Location:** `packages/providers/src/community/pi/options-translator.ts:313`
- **Issue:** `existsSync(join(candidate, 'SKILL.md'))` returns `true` for directories. It should verify `isFile()`.
- **Risk:** A directory named `SKILL.md` inside a skill folder is incorrectly resolved as a valid skill.
- **Fix:** Use `statSync(...).isFile()` instead of `existsSync`.

### 1.6 Empty-string env override is ignored

- **Location:** `packages/providers/src/community/pi/provider.ts:264-269`
- **Issue:** `envOverride` uses `??` fallback: `requestOptions?.env?.[envVarName] ?? process.env[envVarName]`. An explicit empty string in `requestOptions.env` is treated as missing and falls through to `process.env`.
- **Risk:** A user cannot intentionally blank out a global env var for a specific workflow node.
- **Fix:** Distinguish `undefined` from `''` (e.g., check `envVarName in (requestOptions?.env ?? {})`).

### 1.7 Abort signal checked too late

- **Location:** `packages/providers/src/community/pi/provider.ts`
- **Issue:** Claude checks `abortSignal?.aborted` at the top of the retry loop (before expensive SDK setup). Codex checks before thread creation. Pi only checks inside `bridgeSession`, after model lookup, auth resolution, session creation, and extension loading have already run.
- **Risk:** Wasted compute and API calls when the user cancels before the first yield.
- **Fix:** Add an early `if (requestOptions?.abortSignal?.aborted) throw new Error('Query aborted')` before model/auth setup.

### 1.8 `session-resolver.ts` swallows ENOENT silently without logging

- **Location:** `packages/providers/src/community/pi/session-resolver.ts:54-58`
- **Issue:** When `SessionManager.list()` throws `ENOENT` or `ENOTDIR`, the resolver falls back to a fresh session but never logs the event. This makes debugging "why did my session not resume?" difficult.
- **Fix:** Add a `getLog().debug({ err }, 'pi.session_list_missing_dir')` before swallowing.

### 1.9 `options-translator.ts` `buildBashSpawnHook` lacks `undefined` guard for `context.env`

- **Location:** `packages/providers/src/community/pi/options-translator.ts:124-129`
- **Issue:** `return (context: BashSpawnContext): BashSpawnContext => ({ ...context, env: { ...context.env, ...env } })` assumes `context.env` is always defined. If Pi's SDK passes `context.env = undefined`, the spread crashes.
- **Risk:** Hard crash during bash tool execution if the SDK context shape changes.
- **Fix:** `env: { ...(context.env ?? {}), ...env }`.

---

## 2. Utility Reuse Gaps

### 2.1 `findMarkdownFilesRecursive` duplicated across packages

- **Locations:**
  - `packages/paths/src/archon-paths.ts:207-251`
  - `packages/core/src/utils/commands.ts:15-49`
- **Issue:** Both functions implement nearly identical recursive markdown discovery. The `paths` version handles `ENOENT` gracefully (returns `[]`); the `core` version does not, so a missing directory throws an uncaught exception.
- **Fix:** Delete the `core` version and import from `@archon/paths`. If `core` must stay zero-dep for this helper, copy the `ENOENT` guard into it.

### 2.2 `AsyncQueue` in Pi is generic but not shared

- **Location:** `packages/providers/src/community/pi/event-bridge.ts:29-84`
- **Issue:** `AsyncQueue<T>` is a clean, reusable single-consumer async queue. It is currently Pi-specific, but the pattern could be useful for other callback-to-generator bridges.
- **Assessment:** Not an active bug, but a note for future refactoring if another provider needs callback bridging.

### 2.3 Logger caching boilerplate repeated in every provider and utility

- **Pattern seen in:** `packages/providers/src/claude/provider.ts`, `packages/providers/src/codex/provider.ts`, `packages/providers/src/community/pi/provider.ts`, `packages/providers/src/community/pi/event-bridge.ts`, `packages/core/src/utils/conversation-lock.ts`, `packages/core/src/utils/port-allocation.ts`, `packages/core/src/utils/worktree-sync.ts`
- **Issue:** The `let cachedLog` / `function getLog()` pattern is copy-pasted 7+ times.
- **Assessment:** Minor DRY concern. A shared `lazyLogger(module)` one-liner in `@archon/paths` would reduce boilerplate, but the current pattern is not buggy.

---

## 3. Inconsistent Patterns vs Other Providers

### 3.1 Capability flag parity gaps

- **Location:** `packages/providers/src/community/pi/capabilities.ts`
- **Comparison:**

| Feature            | Claude | Codex | Pi    | Notes                                                         |
| ------------------ | ------ | ----- | ----- | ------------------------------------------------------------- |
| `sessionResume`    | true   | true  | true  | OK                                                            |
| `mcp`              | true   | false | false | OK                                                            |
| `hooks`            | true   | false | false | OK                                                            |
| `skills`           | true   | false | true  | OK                                                            |
| `agents`           | true   | false | false | OK                                                            |
| `toolRestrictions` | true   | false | true  | OK                                                            |
| `structuredOutput` | true   | true  | true  | OK (Pi is best-effort)                                        |
| `envInjection`     | true   | true  | true  | OK                                                            |
| `costControl`      | true   | false | false | OK                                                            |
| `effortControl`    | true   | false | true  | OK                                                            |
| `thinkingControl`  | true   | false | true  | OK                                                            |
| `fallbackModel`    | true   | false | false | OK (Pi handles SDK fallback messages but not explicit config) |
| `sandbox`          | true   | false | false | OK                                                            |

- **Assessment:** Capability declarations are accurate and consistent with implementation. No issues here.

### 3.2 Config parser pattern consistency

- **Location:** `packages/providers/src/community/pi/config.ts`
- **Comparison:** `parseClaudeConfig` and `parseCodexConfig` both use the same defensive, silent-drop pattern. `parsePiConfig` follows the same shape.
- **Assessment:** Consistent. No issue.

### 3.3 Provider constructor patterns diverge

- **Locations:**
  - `packages/providers/src/claude/provider.ts:887-898` (has root guard + retry delay option)
  - `packages/providers/src/codex/provider.ts:470-475` (has retry delay option)
  - `packages/providers/src/community/pi/provider.ts:153-467` (no constructor at all)
- **Issue:** Claude guards against root UID. Codex accepts `retryBaseDelayMs`. Pi has no constructor, so it cannot accept runtime options or perform safety checks.
- **Risk:** Root guard is missing for Pi (may or may not matter for the Pi SDK). Retry delay is not configurable.
- **Fix:** Add a minimal constructor to accept `retryBaseDelayMs` and any future Pi-specific options.

### 3.4 `getType()` / `getCapabilities()` pattern

- **Assessment:** All three providers implement `getType(): string` and `getCapabilities(): ProviderCapabilities` consistently. No issue.

### 3.5 Result chunk shape completeness

- **Claude sets:** `sessionId`, `tokens`, `structuredOutput`, `isError`, `errorSubtype`, `errors`, `cost`, `stopReason`, `numTurns`, `modelUsage`
- **Codex sets:** `sessionId`, `tokens`, `structuredOutput`
- **Pi sets:** `sessionId`, `tokens`, `structuredOutput`, `isError`, `errorSubtype`, `cost`, `stopReason`
- **Issue:** Pi is actually more complete than Codex, but none of the three are fully aligned on optional fields. This is acceptable since all fields are optional on `MessageChunk`.

### 3.6 `modelFallbackMessage` handling

- **Location:** `packages/providers/src/community/pi/provider.ts:404-406`
- **Issue:** Pi yields a system chunk when the SDK returns a `modelFallbackMessage`. Claude/Codex do not have an equivalent concept because their SDKs don't surface internal fallbacks this way.
- **Assessment:** Pi-specific behavior, not an inconsistency bug. It is correctly surfaced as a warning chunk.

---

## 4. Error Handling Consistency

### 4.1 Pi throws raw SDK errors; built-ins classify and enrich

- **See 1.3 and 1.4 above.**
- **Severity:** Medium. Transient failures are not retried, and error messages are not user-friendly.

### 4.2 `event-bridge.ts` silently drops unknown Pi event types

- **Location:** `packages/providers/src/community/pi/event-bridge.ts:244-245`
- **Issue:** `mapPiEvent` has `default: return []`. If Pi adds a new event type (e.g., `agent_think`, `file_change`), Archon silently ignores it.
- **Risk:** New Pi features won't surface without manual code changes. Users may think Archon is broken when events simply disappear.
- **Fix:** Log unknown event types at `debug` level so SDK upgrades are discoverable.

### 4.3 `buildResultChunk` flags `missing_assistant_message` as error

- **Location:** `packages/providers/src/community/pi/event-bridge.ts:130-152`
- **Assessment:** Correct behavior. An `agent_end` with no assistant message is anomalous and should be treated as an error so the orchestrator doesn't treat it as a clean success.

### 4.4 `tryParseStructuredOutput` degrades gracefully

- **Location:** `packages/providers/src/community/pi/event-bridge.ts:165-179`
- **Assessment:** Correct. Returns `undefined` on any failure, leaving the executor's existing `dag.structured_output_missing` path to warn the user. Matches Codex's degradation pattern.

---

## 5. Type Export Completeness

### 5.1 Pi public API surface (`index.ts`)

- **Exports:** `PI_CAPABILITIES`, `parsePiConfig`, `PiProviderDefaults` (type), `isPiModelCompatible`, `parsePiModelRef`, `PiModelRef` (type), `PiProvider`, `registerPiProvider`
- **Assessment:** Complete. All types a consumer needs are exported. Internal helpers (`options-translator`, `event-bridge`, `session-resolver`, `resource-loader`, `ui-context-stub`) are correctly kept private.

### 5.2 `ProviderRegistration` interface has `builtIn: boolean`

- **Location:** `packages/providers/src/types.ts:289`
- **Assessment:** Pi uses `builtIn: false` correctly. The registry differentiates community vs core providers.

### 5.3 `NodeConfig` hand-written interface drift risk

- **Location:** `packages/providers/src/types.ts:186-228`
- **Issue:** The comment acknowledges this is a deliberate hand-written duplicate of `agentDefinitionSchema` from `@archon/workflows/schemas/dag-node` to avoid a circular dependency. The comment references follow-up work #1276.
- **Assessment:** Not a Pi-specific issue, but a project-wide architectural debt. No action needed in this audit.

### 5.4 `ProviderDefaultsMap` is under-typed

- **Location:** `packages/providers/src/types.ts:99-102`
- **Issue:** `ProviderDefaultsMap = Record<string, ProviderDefaults>` loses the knowledge that keys are provider IDs and values are specific defaults (Claude, Codex, Pi, Hermes). Callers must cast.
- **Assessment:** Minor. Not Pi-specific.

---

## Summary Table: Priority Ranking

| #   | Finding                                                                  | Severity   | Category             |
| --- | ------------------------------------------------------------------------ | ---------- | -------------------- |
| 1   | `enableExtensions` default mismatch (docs say false, code says true)     | **High**   | Pi-specific          |
| 2   | `process.env` permanent mutation for Pi config env                       | **Medium** | Pi-specific          |
| 3   | Missing retry + error classification in Pi                               | **Medium** | Pi-specific          |
| 4   | `findMarkdownFilesRecursive` duplicated; core version lacks ENOENT guard | **Medium** | Utility reuse        |
| 5   | Empty-string env override ignored in Pi                                  | **Low**    | Pi-specific          |
| 6   | `resolvePiSkills` accepts directories as `SKILL.md`                      | **Low**    | Pi-specific          |
| 7   | Abort signal checked too late in Pi                                      | **Low**    | Pi-specific          |
| 8   | `session-resolver.ts` silently swallows ENOENT                           | **Low**    | Pi-specific          |
| 9   | `buildBashSpawnHook` lacks `undefined` guard                             | **Low**    | Pi-specific          |
| 10  | Unknown Pi event types silently dropped                                  | **Low**    | Pi-specific          |
| 11  | Pi provider has no constructor                                           | **Low**    | Inconsistent pattern |
| 12  | `AsyncQueue` is Pi-local, not shared                                     | **Info**   | Utility reuse        |
| 13  | Logger caching boilerplate repeated                                      | **Info**   | Utility reuse        |
