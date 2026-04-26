# Claude Code Provider Audit

**Scope:** `packages/providers/src/claude/` compared against `codex/`, `hermes/`, `community/pi/`, and `types.ts`.
**Date:** 2026-04-26
**Auditor:** Claude Code

---

## 1. Code Duplication

### 1.1 AsyncQueue<T> — Identical in Hermes and Pi

**Hermes:** `packages/providers/src/hermes/event-bridge.ts:39-92`  
**Pi:** `packages/providers/src/community/pi/event-bridge.ts:39-92`

Both files contain the exact same `AsyncQueue<T>` class (single-producer/single-consumer async queue with `consumed` guard, `close()` sentinel, and identical JSDoc). This should be extracted to a shared utility in `@archon/providers` (or `@archon/paths` since it has zero deps).

**Impact:** Any bug fix or improvement (e.g., backpressure, size limits) must be applied in two places. Current risk is low but technical debt is real.

### 1.2 Binary Resolver Pattern — Claude, Codex, and Hermes Repeat the Same Logic

All three built-in providers implement the same fallback chain:

1. Environment variable (`CLAUDE_BIN_PATH`, `CODEX_BIN_PATH`, `HERMES_BIN_PATH`)
2. Config override (`claudeBinaryPath`, `codexBinaryPath`, `hermesBinaryPath`)
3. Autodetect (platform-specific paths)
4. Throw or return `undefined`

**Claude:** `packages/providers/src/claude/binary-resolver.ts` (4-step chain, throws on miss)  
**Codex:** `packages/providers/src/codex/binary-resolver.ts` (5-step chain with vendor dir, throws on miss)  
**Hermes:** `packages/providers/src/hermes/binary-resolver.ts` (3-step chain, returns `undefined` on miss)

**Recommendation:** Extract a generic `resolveBinaryPath({ envVar, configPath, autodetectPaths, throwOnMiss })` to `packages/providers/src/utils/binary-resolver.ts`. Hermes's "return undefined" behavior can be parameterized.

### 1.3 Error Classification — Claude and Codex Share the Same Pattern

**Claude:** `classifyAndEnrichError()` in `provider.ts` (~80 lines)  
**Codex:** `classifyAndEnrichCodexError()` in `provider.ts` (~60 lines)

Both classify by string matching on `error.message`, add `retryable` boolean, enrich with `errorSubtype`, and wrap in a structured error. The only meaningful difference is Codex's extra `model_access` classification.

**Recommendation:** Extract a shared `classifyProviderError(error, rules): ProviderError` where `rules` is a provider-specific array of `{ pattern, subtype, retryable }` tuples.

### 1.4 Env Var Expansion — Claude and Pi Both Expand `$VAR_NAME`

**Claude:** `expandEnvVars()` and `expandEnvVarsInRecord()` in `provider.ts`  
**Pi:** Used in `options-translator.ts` for `env` injection

The pattern of replacing `$VAR_NAME` with `process.env[VAR_NAME]` is identical. Pi's `buildBashSpawnHook` also does environment merging that mirrors Hermes's `resolveHermesSession`.

**Recommendation:** Extract `expandEnvVars(str, env?)` and `mergeEnv(base, override)` to a shared utility.

### 1.5 Logger Caching Pattern

All provider modules use the same lazy-logger pattern:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  if (!cachedLog) cachedLog = createLogger('provider.X');
  return cachedLog;
}
```

This appears in Claude provider, Hermes event-bridge, Pi event-bridge, and Pi provider. `createLogger` is already cheap; the caching is unnecessary boilerplate. Either remove the cache or extract a `createCachedLogger(name)` helper.

### 1.6 Retry Loop — Claude and Codex Are Structurally Identical

Both `sendQuery()` methods implement:

1. Max 3 retries
2. Exponential backoff (base delay 2000ms)
3. Error classification to decide retryability
4. `withFirstMessageTimeout` wrapper
5. Terminal `result` chunk emission on final failure

The only differences are the SDK-specific option building and event normalization. The retry orchestration itself is pure duplication.

**Recommendation:** Extract `withRetry<T>(generator, { maxRetries, baseDelayMs, classifyError }): AsyncGenerator<T>` to a shared utility.

### 1.7 Config Parsers — Claude, Codex, and Pi All Have Defensive Parsers

**Claude:** `parseClaudeConfig()` in `config.ts`  
**Codex:** `parseCodexConfig()` in `config.ts`  
**Pi:** `parsePiConfig()` in `config.ts`

All three do `typeof defaults === 'object' && defaults !== null`, extract known fields with `typeof` guards, and return a sanitized object. The pattern is identical; only the field names differ.

**Recommendation:** A generic `parseProviderDefaults<T>(defaults, schema): T` or at least a shared `pickString()`, `pickBoolean()`, `pickArray()` helper set would eliminate ~150 lines of duplication.

### 1.8 Session/Context Resolution — Hermes and Pi Both Build Execution Contexts

**Hermes:** `resolveHermesSession()` merges `process.env` with caller-provided `env`.  
**Pi:** `buildBashSpawnHook()` merges `process.env` with `assistants.pi.env` and per-request `env`.

The environment merging logic is identical (`Object.entries(process.env)` baseline + override loop). Pi also validates `cwd` fallback to `process.cwd()`, which Hermes does too.

**Recommendation:** Shared `resolveExecutionContext(cwd, env?)` utility.

### 1.9 Stream Normalization — All Providers Map SDK Events to MessageChunk

Every provider has a function that maps raw SDK events to the Archon `MessageChunk` discriminated union:

- Claude: `streamClaudeMessages()` (~200 lines)
- Codex: `streamCodexEvents()` (~150 lines)
- Hermes: inline in `bridgeHermesSession()` (~80 lines of routing)
- Pi: `mapPiEvent()` (~100 lines)

While the event shapes differ, the structural pattern (switch on event type, yield normalized chunk) is the same. A shared `normalizeEvent(type, payload)` base or at least a common test harness for stream normalization would help.

### 1.10 Event Bridge Pattern — Hermes and Pi Both Bridge Callback-Based SDKs to Async Generators

**Hermes:** `bridgeHermesSession()` wraps a `ChildProcess` in `AsyncQueue<BridgeQueueItem>`.  
**Pi:** `bridgeSession()` wraps Pi SDK callbacks in `AsyncQueue<PiBridgeItem>`.

Both use the exact same `AsyncQueue` class, same `kind: 'chunk' | 'done' | 'error'` discriminated union, same `for await` consumer loop with `try/finally` cleanup. This is ~250 lines of near-identical infrastructure.

### 1.11 Model Ref Parsing — Hermes and Pi Both Parse Provider-Prefixed Model Strings

**Hermes:** `parseHermesModelRef()` splits `hermes:provider/model`.  
**Pi:** `resolvePiModel()` splits `provider/model`.

Both validate the format, extract provider and model, and fall back to config defaults. The parsing logic is trivial but duplicated.

---

## 2. Type Issues

### 2.1 Hand-Written ContentBlock Duplicates SDK Type

**Claude provider:** `provider.ts` defines a local `ContentBlock` interface that mirrors the Claude SDK's `ContentBlock` but is hand-written. The CLAUDE.md explicitly says "Import SDK types directly" and "Avoid defining duplicate types."

**Impact:** SDK updates can drift from the hand-written type, causing runtime mismatches that TypeScript won't catch.

### 2.2 `as` Assertions Abound in Claude Provider

`provider.ts` contains at least 15 `as` type assertions, many of which are unnecessary or could be replaced with proper narrowing:

- `const contentBlocks = message.message.content as { type: string; text?: string }[]`
- `const toolUse = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }`
- `const text = (block as { text?: string }).text`

These assertions bypass the SDK's own types. If the SDK changes shape, these will fail silently at runtime.

### 2.3 `applyNodeConfig` Mutates Its Input and Returns Warnings

`applyNodeConfig(options, nodeConfig, cwd)` mutates `options` in place (adding `tools`, `hooks`, `mcpServers`, etc.) and returns `ProviderWarning[]`. This side-effect-heavy signature is surprising and makes the function hard to test in isolation.

**Inelegance:** `sendQuery()` calls `applyNodeConfig` **twice** per attempt:

1. Once on a throwaway `tempOptions` to collect warnings for the caller.
2. Once on the real `options` inside the retry loop.

This is wasteful and confusing. The function should be pure: `buildClaudeOptions(nodeConfig, cwd): { options, warnings }`.

### 2.4 NodeConfig.agents Is a Hand-Written Duplicate of Zod Schema

**types.ts:191-228** acknowledges this explicitly: "Intentional hand-written duplicate of `agentDefinitionSchema`... broken here on purpose... Drift risk." The comment references follow-up work #1276.

**Status:** This is a known issue with a ticket, but it remains a type safety gap. When the schema gains a field, this shape must be updated by hand.

### 2.5 `ProviderDefaults` Is Too Permissive

`types.ts:99` defines `ProviderDefaults = Record<string, unknown>`, which defeats TypeScript's ability to validate provider-specific config shapes. `ClaudeProviderDefaults`, `CodexProviderDefaults`, etc. exist but are not linked to `ProviderDefaults` via generics or mapped types.

### 2.6 `MessageChunk` Union Lacks Exhaustiveness Protection

The `MessageChunk` discriminated union is not accompanied by an `assertNever` helper or exhaustive switch utility. Several providers have `default` cases in their event mapping that silently drop unknown event types rather than warning.

### 2.7 `HermesProviderDefaults` Lacks `[key: string]: unknown` Index Signature

Unlike `ClaudeProviderDefaults`, `CodexProviderDefaults`, and `PiProviderDefaults`, `HermesProviderDefaults` does not have an index signature. This means excess property checks will fail when Hermes defaults are passed through generic `ProviderDefaults` surfaces.

### 2.8 `AbortSignal` Handling Is Inconsistent

- **Claude:** Forwards `AbortSignal` to the SDK via `options.signal` (SDK-native cancellation).
- **Codex:** Forwards `AbortSignal` to the SDK via `TurnOptions.signal`.
- **Hermes:** Manually listens to `abortSignal`, sends `session/cancel` JSON-RPC notification, then `SIGTERM` + `SIGKILL` fallback.
- **Pi:** Manually listens to `abortSignal`, calls Pi's `session.cancel()`, then cleans up.

The manual implementations (Hermes, Pi) are similar but not shared. A common `withAbortSignal(signal, cleanupFn)` utility would reduce duplication and prevent listener leaks.

---

## 3. Missing Shared Utilities

The following patterns appear in multiple providers but have no shared implementation:

| Pattern                                         | Used By                   | Missing Utility                                                 |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| Exponential backoff retry                       | Claude, Codex             | `withRetry()`                                                   |
| AsyncQueue<T>                                   | Hermes, Pi                | `AsyncQueue` in `utils/`                                        |
| Binary path resolution                          | Claude, Codex, Hermes     | `resolveBinaryPath()`                                           |
| Error classification by pattern                 | Claude, Codex             | `classifyProviderError()`                                       |
| Env var expansion (`$VAR_NAME`)                 | Claude, Pi                | `expandEnvVars()`                                               |
| Environment merging                             | Hermes, Pi                | `mergeEnv()`                                                    |
| First-message timeout                           | Claude, Codex             | `withFirstMessageTimeout()` (currently in Claude only)          |
| Logger lazy-cache                               | Claude, Hermes, Pi        | `createCachedLogger()` or remove caching                        |
| Config defensive parser                         | Claude, Codex, Pi, Hermes | `parseProviderDefaults()` helpers                               |
| Terminal `result` chunk emission                | Claude, Codex, Hermes, Pi | `emitTerminalResult()`                                          |
| Stream cleanup (kill process, remove listeners) | Hermes, Pi                | `cleanupChildProcess()`                                         |
| JSON fence stripping for structured output      | Pi                        | Could be shared if other providers add best-effort JSON parsing |

---

## 4. Error Handling Gaps

### 4.1 `applyNodeConfig` Throws on Some Paths but Not Others

`applyNodeConfig()` returns warnings for unsupported features (e.g., `skills` on non-Claude providers), but throws synchronously on invalid `agents` definitions. This inconsistency means callers must handle both return values _and_ exceptions.

### 4.2 Deterministic Errors Are Retried

The retry loop in `sendQuery()` retries on _any_ classified error. However, some errors are deterministic (e.g., invalid model name, missing binary, root UID check). Retrying these wastes time and API budget.

**Missing:** A `deterministic: boolean` flag in the error classification so the retry loop can skip retries for deterministic failures.

### 4.3 `withFirstMessageTimeout` Does Not Abort the Underlying SDK Call

`withFirstMessageTimeout()` wraps the async generator with a `setTimeout` that throws `FirstMessageTimeoutError`. However, it does not call `abortController.abort()`, so the underlying SDK request continues to run (and consume tokens/budget) even after the timeout.

### 4.4 Missing Validation for `nodeConfig.agents` Tools

`nodeConfig.agents` allows `tools?: string[]` and `disallowedTools?: string[]`, but there is no validation that these tool names are valid or that `tools` and `disallowedTools` don't conflict.

### 4.5 `expandEnvVars` Silently Coerces Undefined to String

`expandEnvVars()` replaces `$VAR_NAME` with `process.env[VAR_NAME]` even when the env var is undefined, resulting in the string `"undefined"`. It should either leave the placeholder intact or warn.

### 4.6 `loadMcpConfig` Does Not Validate JSON Schema

`loadMcpConfig()` reads a JSON file and expands env vars, but does not validate that the resulting object matches the expected MCP server config shape. A malformed JSON file will cause a downstream SDK error with no clear provenance.

### 4.7 `childProcess.kill('SIGKILL')` in `finally` Block Can Throw

**Hermes event-bridge:** The `finally` block calls `childProcess.kill('SIGKILL')` without checking if the process is already dead. While wrapped in `try/catch`, this is defensive rather than explicit. The Pi event-bridge has the same pattern.

### 4.8 `abortSignal` Listener Leak if `bridgeHermesSession` Throws Before Cleanup

If `bridgeHermesSession()` throws between registering the `abortSignal` listener and entering the `try/finally` block, the listener is never removed. The `abortSignal.addEventListener` call should be paired with a `try/finally` or use `AbortSignal.any()` if available.

### 4.9 `parseHermesModelRef` Returns `null` on Invalid Input, Callers Don't Always Check

`resolveHermesModel()` returns `null` when resolution fails, but some callers (e.g., `provider.ts` when building spawn args) may not handle this case explicitly.

### 4.10 `buildSDKHooksFromYAML` Has No Test Coverage

The hook-building logic (`buildSDKHooksFromYAML`, `buildToolCaptureHooks`) is complex (YAML → SDK hook translation with `PostToolUse`/`PostToolUseFailure` capture) but has zero unit tests. A malformed hook definition could crash the SDK at runtime.

### 4.11 `shouldPassNoEnvFile` Logic Is Fragile

`shouldPassNoEnvFile()` detects Node.js executables by checking if `process.argv[1]` ends with `.js` or `.cjs`. This fails for:

- Executables run via `ts-node` or `tsx`
- Bundled binaries where the entry point is not a `.js` file
- Symlinked entry points

### 4.12 Missing Rate Limit Handling in Hermes and Pi

Claude and Codex explicitly classify `rate_limit` errors and retry with backoff. Hermes and Pi do not have equivalent rate limit detection, even though their backends (Ollama, OpenRouter, etc.) can rate-limit.

---

## 5. Naming Inconsistencies

| Concept                      | Claude                      | Codex                           | Hermes                            | Pi                      | Inconsistency                                    |
| ---------------------------- | --------------------------- | ------------------------------- | --------------------------------- | ----------------------- | ------------------------------------------------ |
| Send function                | `sendQuery()`               | `sendQuery()`                   | `sendQuery()`                     | `sendQuery()`           | Consistent                                       |
| Stream normalizer            | `streamClaudeMessages()`    | `streamCodexEvents()`           | inline in `bridgeHermesSession()` | `mapPiEvent()`          | Naming diverges; Hermes has no named function    |
| Error classifier             | `classifyAndEnrichError()`  | `classifyAndEnrichCodexError()` | None                              | None                    | Codex adds provider suffix; Claude doesn't       |
| Config parser                | `parseClaudeConfig()`       | `parseCodexConfig()`            | None                              | `parsePiConfig()`       | Hermes lacks config parser                       |
| Binary resolver              | `resolveClaudeBinaryPath()` | `resolveCodexBinaryPath()`      | `resolveHermesBinary()`           | `resolvePiBinaryPath()` | Hermes drops "Path" suffix                       |
| Timeout wrapper              | `withFirstMessageTimeout()` | None                            | None                              | None                    | Only Claude has this; should be shared           |
| Hook builder                 | `buildSDKHooksFromYAML()`   | None                            | None                              | None                    | Only Claude; no generic name                     |
| Tool capture                 | `buildToolCaptureHooks()`   | None                            | None                              | None                    | Only Claude                                      |
| MCP loader                   | `loadMcpConfig()`           | None                            | None                              | None                    | Only Claude                                      |
| Env expander                 | `expandEnvVars()`           | None                            | None                              | inline                  | Only Claude has named function                   |
| Model resolver               | N/A (alias-based)           | N/A (direct)                    | `resolveHermesModel()`            | `resolvePiModel()`      | Hermes and Pi share pattern but different naming |
| Provider capabilities export | `CLAUDE_CAPABILITIES`       | `CODEX_CAPABILITIES`            | `HERMES_CAPABILITIES`             | `PI_CAPABILITIES`       | Consistent                                       |
| Registration function        | `registerClaudeProvider()`  | `registerCodexProvider()`       | `registerHermesProvider()`        | `registerPiProvider()`  | Consistent                                       |

**Notable issue:** The error classifier naming (`classifyAndEnrichError` vs `classifyAndEnrichCodexError`) suggests Claude was the original and Codex was copied without renaming to a generic pattern. If shared, this should be `classifyError()`.

---

## 6. Test Coverage Gaps

### 6.1 Claude Provider Tests (`provider.test.ts` — 1294 lines)

**Well covered:** Constructor root check, basic sendQuery streaming, retry behavior, tool events, result chunks, inline agents, decomposition behaviors, `shouldPassNoEnvFile`.

**Missing coverage:**

1. `applyNodeConfig()` — no dedicated unit tests; only tested indirectly through `sendQuery`.
2. `buildBaseClaudeOptions()` — no direct tests.
3. `loadMcpConfig()` — no tests at all.
4. `expandEnvVars()` and `expandEnvVarsInRecord()` — no tests.
5. `buildSDKHooksFromYAML()` — no tests.
6. `buildToolCaptureHooks()` — no tests.
7. `withFirstMessageTimeout()` — no tests.
8. `parseClaudeConfig()` — no tests (file exists but no test file).
9. `resolveClaudeBinaryPath()` — no tests (file exists but no test file).
10. MCP config loading with env var expansion in nested objects.
11. Hook execution with `PostToolUse` and `PostToolUseFailure` capture.
12. `abortSignal` cancellation mid-stream.
13. `forkSession` behavior.
14. `persistSession: false` behavior.
15. `maxBudgetUsd` enforcement or passthrough.
16. `fallbackModel` usage.
17. `output_format` passthrough.
18. `sandbox` option passthrough.
19. `betas` option passthrough.

### 6.2 Codex Provider Tests

No dedicated test file exists for `CodexProvider`. The only Codex-related tests are in `registry.test.ts` (capability checks). This is a major gap given that Codex is a built-in provider.

### 6.3 Hermes Provider Tests

No dedicated test file exists for `HermesProvider`. Only registry-level tests verify its existence and capabilities.

### 6.4 Pi Provider Tests

`community/pi/` has no test files at all. Given that Pi is a community provider with complex dynamic imports and extension support, this is risky.

### 6.5 Shared Utilities

No tests exist for:

- `AsyncQueue<T>` (Hermes/Pi)
- Binary resolvers (any provider)
- Config parsers (any provider)
- Error classification logic

---

## 7. Architecture / Design Issues

### 7.1 `claude/provider.ts` Is 1043 Lines — Too Large

The file mixes concerns:

- Retry orchestration
- SDK option building
- NodeConfig translation
- Stream normalization
- Error classification
- MCP config loading
- Hook building
- Tool capture hooks
- Timeout utilities
- Root UID check

**Comparison:**

- Hermes splits into `provider.ts` (127 lines), `event-bridge.ts` (433 lines), `session-resolver.ts` (73 lines), `options-translator.ts` (92 lines), `binary-resolver.ts` (41 lines).
- Pi splits into `provider.ts` (468 lines), `event-bridge.ts` (387 lines), `options-translator.ts` (328 lines), `session-resolver.ts` (156 lines), `binary-resolver.ts` (64 lines).

**Recommendation:** Extract `claude/event-bridge.ts`, `claude/options-translator.ts`, `claude/session-resolver.ts`, and `claude/hooks-builder.ts` to match the Hermes/Pi structure.

### 7.2 `ProviderRegistration.factory` Returns `IAgentProvider`, But Registry Also Stores Capabilities Separately

The registry stores both `capabilities` (static) and `factory().getCapabilities()` (runtime). For all current providers these are identical, but the design allows divergence. The registry should enforce that static caps match runtime caps (or drop one).

### 7.3 `registerBuiltinProviders()` Hardcodes Provider IDs

`registry.ts` imports and calls `registerClaudeProvider()`, `registerCodexProvider()`, and `registerHermesProvider()` directly. Adding a new built-in requires editing `registry.ts`. A convention-based discovery (e.g., scan `src/*/capabilities.ts`) would reduce friction.

### 7.4 `@sinclair/typebox` in `package.json` Dependencies

`packages/providers/package.json` lists `@sinclair/typebox` in `dependencies`, but no provider code imports from it. This may be dead weight from an earlier schema approach.

---

## 8. Summary of Recommendations (Prioritized)

### High Priority

1. **Extract `AsyncQueue<T>`** to a shared utility (Hermes and Pi are identical).
2. **Extract retry loop** to `withRetry()` shared by Claude and Codex.
3. **Extract binary resolver** to a generic utility shared by all providers.
4. **Add tests for CodexProvider** — currently zero dedicated tests.
5. **Split `claude/provider.ts`** into smaller modules matching the Hermes/Pi structure.

### Medium Priority

6. **Extract error classification** to a shared `classifyProviderError()` with provider-specific rule sets.
7. **Extract env var expansion** and environment merging to shared utilities.
8. **Add deterministic error flag** so retry loops skip non-retryable failures immediately.
9. **Fix `withFirstMessageTimeout`** to abort the underlying SDK request, not just the consumer.
10. **Add tests for `applyNodeConfig`**, `loadMcpConfig`, `expandEnvVars`, and `buildSDKHooksFromYAML`.

### Low Priority

11. **Unify naming** of error classifiers, stream normalizers, and config parsers.
12. **Remove or use `@sinclair/typebox`** from dependencies.
13. **Add `assertNever` helper** for exhaustive `MessageChunk` switching.
14. **Add index signature** to `HermesProviderDefaults` for consistency.
15. **Extract first-message timeout** utility for use by Codex (and future providers).

---

_End of audit._
