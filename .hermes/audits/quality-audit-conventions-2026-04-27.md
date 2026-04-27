# Hermes Provider Convention Audit

**Date:** 2026-04-27  
**Scope:** `packages/providers/src/hermes/*`  
**Reference:** `packages/providers/src/claude/provider.ts`, `packages/providers/src/codex/provider.ts`, `packages/providers/src/claude/binary-resolver.ts`, `packages/providers/src/codex/binary-resolver.ts`

---

## 1. Error Handling Pattern

| File                                            | Line                               | Severity | Description                                                                                                                                                                                                                                                                                                                                     | Recommended Fix                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/src/hermes/event-bridge.ts` | 176-200, 213-228, 255-266, 379-392 | **info** | Hermes bridges subprocess errors into terminal `result` chunks with `isError: true` instead of throwing. Claude/Codex throw enriched `Error` objects from `classifyAndEnrichError` / `classifyAndEnrichCodexError` and rely on an outer retry loop. Hermes has no retry loop, so yielding error chunks is acceptable, but the pattern diverges. | Evaluate whether a retry loop (as in Claude/Codex, `MAX_SUBPROCESS_RETRIES`) should be added for transient failures (rate limits, crashes). If not, document the intentional deviation in a `DESIGN.md`. |
| `packages/providers/src/hermes/provider.ts`     | 102-105                            | **info** | `verifyHermesBinary` failure throws directly rather than yielding an error chunk. This is fine for pre-flight checks; matches Claude/Codex `resolveClaudeBinaryPath` throws.                                                                                                                                                                    | None. Consistent with other providers for pre-flight binary resolution.                                                                                                                                  |
| `packages/providers/src/hermes/event-bridge.ts` | 397-401                            | **info** | Consumer loop handles `item.kind === 'error'` by throwing, but the bridge never pushes `{ kind: 'error' }` — only `{ kind: 'chunk' }` with terminal error results. Dead code path.                                                                                                                                                              | Either remove the `'error'` branch if `AsyncQueue` error items are never produced, or push error items instead of terminal chunks for internal queue failures to simplify the consumer contract.         |

---

## 2. Logging Pattern

| File                                               | Line | Severity | Description                                                                                                                                                      | Recommended Fix                                                                      |
| -------------------------------------------------- | ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/providers/src/hermes/provider.ts`        | 18   | **ok**   | Uses `createLazyLogger('provider.hermes')`.                                                                                                                      | None. Matches Claude (`provider.claude`) and Codex (`provider.codex`).               |
| `packages/providers/src/hermes/event-bridge.ts`    | 21   | **ok**   | Uses `createLazyLogger('provider.hermes.event-bridge')`.                                                                                                         | None. Sub-module naming pattern matches repo style (e.g., no default logger import). |
| `packages/providers/src/hermes/binary-resolver.ts` | —    | **ok**   | Does **not** use `createLazyLogger`; relies on `resolveBinaryPath`'s internal logger (`getLog`). Acceptable because the shared resolver handles its own logging. | None. Consistent with Claude/Codex binary resolvers.                                 |

---

## 3. Binary Resolver Pattern

| File                                               | Line  | Severity   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Recommended Fix                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/providers/src/hermes/binary-resolver.ts` | 57-78 | **medium** | `resolveHermesBinary` calls `resolveBinaryPath` with `throwOnMiss: false` and **omits** the `installInstructions` parameter. Other providers (Claude, Codex) pass `throwOnMiss: true` and `installInstructions`, letting the shared resolver throw a rich message. Hermes instead returns `undefined`, falls back to `'hermes'` from PATH, then does a separate `verifyHermesBinary` pre-flight check and throws a custom string. The user-facing error path is different and less uniform. | Either (a) pass `throwOnMiss: true` and `installInstructions` to `resolveBinaryPath` to align with Claude/Codex, or (b) document the intentional "soft-fail to PATH" strategy in a comment block referencing the shared resolver contract. |
| `packages/providers/src/hermes/binary-resolver.ts` | 24-39 | **info**   | `INSTALL_INSTRUCTIONS` is `export const` (unlike Claude's local `const`). This is required because `provider.ts` concatenates it into the `verifyHermesBinary` failure message.                                                                                                                                                                                                                                                                                                             | None. Necessary given the separate verify step, but note that if the resolver pattern is unified (see above), this export can become local.                                                                                                |
| `packages/providers/src/hermes/binary-resolver.ts` | 64    | **ok**     | Env var name `HERMES_BINARY_PATH` follows the `<PROVIDER>_BIN_PATH` convention (`CLAUDE_BIN_PATH`, `CODEX_BIN_PATH`).                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                                                                                                      |

---

## 4. Capability Flags

| File                                            | Line  | Severity | Description                                                                                                                                                                           | Recommended Fix                         |
| ----------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `packages/providers/src/hermes/capabilities.ts` | 24-38 | **ok**   | All flags are `false` except `envInjection: true`. Extensive JSDoc explains that flags are intentionally conservative. The dag-executor will correctly warn for unsupported features. | None. Honest and matches actual wiring. |
| `packages/providers/src/hermes/provider.ts`     | 40-45 | **ok**   | `getCapabilities()` returns `HERMES_CAPABILITIES`.                                                                                                                                    | None. Matches Claude/Codex pattern.     |

---

## 5. Export / Import Style

| File                                        | Line | Severity | Description                                                                                                                                                           | Recommended Fix                                                                                                                                                              |
| ------------------------------------------- | ---- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All Hermes files                            | —    | **ok**   | Strict named exports (`export function`, `export class`). No `default export` found anywhere in scope.                                                                | None. Matches repo convention.                                                                                                                                               |
| `packages/providers/src/hermes/provider.ts` | 1-16 | **info** | Import order: Node builtins → types from `../types` → local modules → utils. Minor: `type { ChildProcess }` imported before `../types` types; not a functional issue. | Optional: group all `type` imports together after value imports for consistency with the rest of the repo (Claude/Codex also have some inconsistency here, so low priority). |

---

## 6. JSDoc Conventions

| File                                                | Line         | Severity | Description                                                                               | Recommended Fix                                                                                                                                              |
| --------------------------------------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/providers/src/hermes/provider.ts`         | 29-48, 67-79 | **ok**   | Uses multi-line JSDoc with `@link` tags. Matches Claude/Codex header style.               | None.                                                                                                                                                        |
| `packages/providers/src/hermes/event-bridge.ts`     | 36-62        | **ok**   | Detailed behavior doc block for `bridgeHermesSession`.                                    | None. Good.                                                                                                                                                  |
| `packages/providers/src/hermes/session-resolver.ts` | 1-72         | **ok**   | Good JSDoc on exported interface and function.                                            | None.                                                                                                                                                        |
| `packages/providers/src/hermes/acp-protocol.ts`     | 1-161        | **info** | Very sparse JSDoc. Interfaces have one-line descriptions, but no module-level header doc. | Add a module header doc comment explaining what ACP is and linking to protocol docs, matching the `claude/provider.ts` and `codex/provider.ts` header style. |
| `packages/providers/src/hermes/error-classifier.ts` | 15-26        | **ok**   | Good doc block for `classifyHermesError`.                                                 | None.                                                                                                                                                        |

---

## 7. Naming Conventions

| File                                            | Line | Severity | Description                                                                                                         | Recommended Fix |
| ----------------------------------------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------- | --------------- |
| All Hermes files                                | —    | **ok**   | camelCase functions/variables, PascalCase classes/interfaces, UPPER_SNAKE_CASE constants. No cryptic abbreviations. | None.           |
| `packages/providers/src/hermes/acp-protocol.ts` | 143  | **info** | `ACP_METHODS` is UPPER_SNAKE_CASE. Acceptable for a constant map.                                                   | None.           |

---

## 8. Test Patterns

| File                              | Line | Severity   | Description                                                                                                                                                                                                                            | Recommended Fix                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/src/hermes/*` | —    | **medium** | No test files exist for the Hermes provider (`*.test.ts`). Likewise, no test files exist for Claude or Codex in this package. This means "test pattern match" is vacuously true, but the overall coverage gap is a project-wide issue. | Add unit tests for `parseHermesConfig`, `resolveHermesBinary`, `classifyHermesError`, and `withFirstEventTimeout` using `mock.module` or `spyOn` (the repo already provides `fileExists` wrappers for this purpose). Reference: Claude binary-resolver has `fileExists` explicitly exported to enable `spyOn` — Hermes follows this pattern, so tests can be written. |

---

## 9. Zod / Schema Validation

| File                                            | Line    | Severity | Description                                                                                                                                                                                           | Recommended Fix                                                                                  |
| ----------------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/providers/src/hermes/config.ts`       | 18-47   | **ok**   | `parseHermesConfig` does runtime manual type narrowing (`typeof raw.model === 'string'`). No Zod usage. This matches `parseClaudeConfig` and `parseCodexConfig`, which also perform manual narrowing. | None. Consistent with other providers in this package.                                           |
| `packages/providers/src/hermes/acp-protocol.ts` | 151-161 | **info** | `isSessionUpdateParams` is a hand-written type guard. No Zod schema.                                                                                                                                  | None. Acceptable for a lightweight protocol layer; Zod is not used elsewhere in `providers/src`. |

---

## 10. Hardcoded Versions / Strings

| File                                             | Line | Severity | Description                                                                                                                                                                    | Recommended Fix                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/src/hermes/event-bridge.ts`  | 310  | **high** | Hardcoded `version: '0.3.9'` in the ACP `initialize` request (`clientInfo`). This drift risk means every Archon release may leave an outdated version in the Hermes handshake. | Import the version dynamically from `package.json` (e.g., `import { version } from '../../package.json'` or via `@archon/paths` if it exposes the app version). If dynamic import is impossible in compiled builds, at minimum add a `TODO(#<issue>): sync with release` comment. |
| `packages/providers/src/hermes/event-bridge.ts`  | 25   | **info** | `REQUEST_TIMEOUT_MS = 30000` hardcoded. Acceptable as a default constant.                                                                                                      | Optional: make it overridable via an env var (e.g., `ARCHON_HERMES_REQUEST_TIMEOUT_MS`) to match the `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` pattern.                                                                                                                              |
| `packages/providers/src/hermes/timeout-utils.ts` | 9    | **info** | Error message hardcodes "Hermes subprocess". The function is in the Hermes folder so this is acceptable, but if moved to `utils/` it would be provider-specific leakage.       | If the utility stays Hermes-local, no fix needed. If it is intended to be generic, accept a `providerName` parameter.                                                                                                                                                             |

---

## 11. Timeout / Abort Handling

| File                                             | Line | Severity   | Description                                                                                                                                                                                                                                                                                                                                                                                                                       | Recommended Fix                                                                                                                                                                                                              |
| ------------------------------------------------ | ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/providers/src/hermes/timeout-utils.ts` | 1-26 | **medium** | `withFirstEventTimeout` does not accept an `AbortController` parameter and does **not** signal abort on timeout. Claude's `withFirstMessageTimeout` receives a controller, calls `controller.abort()` on timeout, and includes diagnostic context (`diagnostics`) in the thrown error. Hermes' version can leave the child process running past a timeout because only the generator promise is raced, not the subprocess itself. | Align with Claude: accept an optional `AbortController`, abort it on timeout, and include minimal diagnostics (e.g., `cwd`, `timeoutMs`) in the error message. This prevents zombie subprocesses when the first event hangs. |

---

## Summary

**Strengths:**

- Named exports only, no default exports.
- Lazy logger usage matches Claude and Codex.
- Capability flags are honest and conservative.
- Manual config parsing is consistent with other providers.
- Binary resolver provides `fileExists` wrapper for testability.
- JSDoc on `provider.ts` and `event-bridge.ts` is detailed and helpful.

**Key Gaps:**

1. **Hardcoded version** (`0.3.9`) in ACP handshake — highest severity; will drift on every release.
2. **Binary resolver deviation** — Hermes uses `throwOnMiss: false` + separate `verifyHermesBinary` instead of letting the shared resolver throw with instructions. This creates a non-uniform user experience.
3. **Timeout utility lacks abort control** — unlike Claude's `withFirstMessageTimeout`, the Hermes wrapper cannot kill a hanging subprocess on first-event timeout.
4. **No retry loop** — Claude and Codex both implement up to 3 retries for transient failures. Hermes yields a single terminal error chunk. This is acceptable for a local CLI but should be documented if intentional.
5. **No tests** — same gap exists for Claude/Codex, but the groundwork (`fileExists` export) is already laid for testability.
6. **Sparse module-level JSDoc** in `acp-protocol.ts` compared to other provider entry points.

**Files Created:**

- `/home/d/Desktop/Archon-canonical/.hermes/audits/quality-audit-conventions-2026-04-27.md`

**No files modified.**
