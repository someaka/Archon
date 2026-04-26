# Archon Provider Audit — Phased Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix all CRITICAL and IMPORTANT findings from the provider audit, extract shared utilities, and standardize patterns across Claude, Codex, Hermes, and Pi providers.

**Architecture:** Extract shared abstractions first (AsyncQueue, binary resolver, retry loop, error classifier, env merger), then fix provider-specific bugs, then standardize type safety and exports.

**Tech Stack:** Bun + TypeScript, `@archon/paths`, `@archon/core`, `@archon/providers`

**Repo:** `/home/d/Desktop/Archon-canonical` (dev branch)

---

## Phase 0: Pre-Flight Audit

**Objective:** Verify the plan against the live codebase before any implementers run.

**Verifier gate:**

1. Read `packages/providers/src/` directory structure
2. Confirm all files referenced in the audit exist
3. Verify `bun run test` passes on current `dev` branch
4. Check git status is clean

**Expected:** PASS — all files exist, tests pass, working tree clean.

---

## Phase 1: Extract Shared Utilities (Foundation)

### Task 1.1: Create `packages/providers/src/utils/async-queue.ts`

**Objective:** Extract `AsyncQueue<T>` from Hermes and Pi event bridges.

**Files:**

- Create: `packages/providers/src/utils/async-queue.ts`
- Modify: `packages/providers/src/hermes/event-bridge.ts` (remove inline AsyncQueue)
- Modify: `packages/providers/src/community/pi/event-bridge.ts` (remove inline AsyncQueue)
- Modify: `packages/providers/src/providers/package.json` (add utils export if needed)

**Steps:**

1. Copy `AsyncQueue<T>` from `hermes/event-bridge.ts` lines 39-92 into new file
2. Export `AsyncQueue` and define `BridgeQueueItem` type:
   ```typescript
   export type BridgeQueueItem =
     | { kind: 'chunk'; chunk: MessageChunk }
     | { kind: 'done' }
     | { kind: 'error'; error: Error };
   ```
3. Update Hermes event-bridge to `import { AsyncQueue, type BridgeQueueItem } from '../utils/async-queue'`
4. Update Pi event-bridge to `import { AsyncQueue, type BridgeQueueItem } from '../../utils/async-queue'`
5. Run `bun test packages/providers` — expected: all Hermes and Pi tests pass
6. Commit: `git add -A && git commit -m "refactor(providers): extract AsyncQueue to shared utility"`

**Verifier gate:**

- `grep -r "class AsyncQueue" packages/providers/src/` → only one hit: `utils/async-queue.ts`
- `bun test packages/providers` → PASS

---

### Task 1.2: Create `packages/providers/src/utils/binary-resolver.ts`

**Objective:** Extract shared binary resolver pattern from Claude, Codex, Hermes.

**Files:**

- Create: `packages/providers/src/utils/binary-resolver.ts`
- Modify: `packages/providers/src/claude/binary-resolver.ts`
- Modify: `packages/providers/src/codex/binary-resolver.ts`
- Modify: `packages/providers/src/hermes/binary-resolver.ts`

**Steps:**

1. Create generic `resolveBinaryPath(options: BinaryResolverOptions): Promise<string | undefined>`
2. Include `fileExists()` wrapper in the same module
3. Refactor each provider's binary resolver to call the generic function
4. Run tests for all three providers
5. Commit

**Verifier gate:**

- `grep -r "function resolve.*Binary" packages/providers/src/` → only shared utility + thin wrappers
- `bun test packages/providers` → PASS

---

### Task 1.3: Create `packages/providers/src/utils/lazy-logger.ts`

**Objective:** Eliminate duplicated `getLog()` / `cachedLog` pattern.

**Files:**

- Create: `packages/providers/src/utils/lazy-logger.ts`
- Modify: All provider files that use the pattern

**Steps:**

1. Export `createLazyLogger(moduleName: string): () => ReturnType<typeof createLogger>`
2. Replace all inline `let cachedLog` / `function getLog()` blocks with `const getLog = createLazyLogger('module.name')`
3. Run tests
4. Commit

**Verifier gate:**

- `grep -r "let cachedLog" packages/providers/src/` → zero hits
- `bun test packages/providers` → PASS

---

### Task 1.4: Create `packages/providers/src/utils/retry-loop.ts`

**Objective:** Extract shared retry orchestration from Claude and Codex.

**Files:**

- Create: `packages/providers/src/utils/retry-loop.ts`
- Modify: `packages/providers/src/claude/provider.ts`
- Modify: `packages/providers/src/codex/provider.ts`

**Steps:**

1. Define `classifyProviderError(error: Error, rules: ErrorClassificationRules): { category: string; retryable: boolean }`
2. Define `withRetry<T>(fn: () => Promise<T> | AsyncGenerator<T>, options: RetryOptions): Promise<T> | AsyncGenerator<T>`
3. Refactor Claude and Codex to use shared retry
4. Add retry to Pi (Phase 2)
5. Run tests
6. Commit

**Verifier gate:**

- `grep -r "MAX_SUBPROCESS_RETRIES" packages/providers/src/` → only in shared utility
- `bun test packages/providers` → PASS

---

### Task 1.5: Create `packages/providers/src/utils/env-helpers.ts`

**Objective:** Extract shared env var expansion and merging.

**Files:**

- Create: `packages/providers/src/utils/env-helpers.ts`
- Modify: `packages/providers/src/claude/provider.ts` (expandEnvVars)
- Modify: `packages/providers/src/hermes/session-resolver.ts`
- Modify: `packages/providers/src/community/pi/provider.ts`

**Steps:**

1. Export `expandEnvVars(str: string, env?: Record<string, string>): string`
2. Export `mergeEnv(base: Record<string, string | undefined>, override: Record<string, string>): Record<string, string>`
3. Refactor all providers to use shared helpers
4. Run tests
5. Commit

**Verifier gate:**

- `grep -r "expandEnvVars\|mergeEnv" packages/providers/src/` → only shared utility + imports
- `bun test packages/providers` → PASS

---

## Phase 2: Fix Critical Security & Correctness Bugs

### Task 2.1: Fix Pi `enableExtensions` Default

**Objective:** Align implementation with JSDoc (default false).

**File:** `packages/providers/src/community/pi/config.ts`

**Steps:**

1. Change `piConfig.enableExtensions !== false` to `piConfig.enableExtensions === true`
2. Write test: `parsePiConfig({})` → `enableExtensions: false`
3. Write test: `parsePiConfig({ enableExtensions: undefined })` → `enableExtensions: false`
4. Commit

**Verifier gate:**

- `bun test packages/providers/src/community/pi/config.test.ts` → PASS

---

### Task 2.2: Stop Pi from Mutating `process.env`

**Objective:** Scope env vars to Pi session lifecycle instead of global mutation.

**File:** `packages/providers/src/community/pi/provider.ts`

**Steps:**

1. Remove the `process.env[key] = value` loop
2. Pass env vars through Pi SDK session constructor or BashSpawnHook
3. If Pi SDK requires `process.env`, document it and gate behind explicit opt-in
4. Write test verifying no global mutation
5. Commit

**Verifier gate:**

- `grep -r "process.env\[" packages/providers/src/community/pi/` → no assignments
- `bun test packages/providers` → PASS

---

### Task 2.3: Fix Hermes `session/cancel` Notification Bug

**Objective:** Use `createNotification` instead of `createRequest` for fire-and-forget cancel.

**File:** `packages/providers/src/hermes/event-bridge.ts`

**Steps:**

1. Import `createNotification` from `acp-protocol.ts`
2. Change abort handler from `createRequest('session/cancel', ...)` to `createNotification('session/cancel', { sessionId })`
3. Add test verifying no `id` field in cancel message
4. Commit

**Verifier gate:**

- `grep -r "session/cancel" packages/providers/src/hermes/` → uses `createNotification`
- `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS

---

### Task 2.4: Fix Hermes Test Batching (Mock Pollution)

**Objective:** Split Hermes tests into isolated batches per CLAUDE.md rules.

**File:** `packages/providers/package.json`

**Steps:**

1. Identify which test files mock which modules
2. Split `bun test` invocations:
   - Batch 1: no mocks (e.g., `binary-resolver.test.ts`)
   - Batch 2: `@archon/paths` mocks only
   - Batch 3: `@archon/paths` + `child_process` mocks
3. Update `package.json` test scripts
4. Run all batches
5. Commit

**Verifier gate:**

- `bun test packages/providers` → all batches pass, no mock pollution

---

## Phase 3: Fix Important Runtime Bugs

### Task 3.1: Fix `withFirstMessageTimeout` to Abort SDK Call

**Objective:** Signal `abortController.abort()` before throwing timeout error.

**File:** `packages/providers/src/claude/provider.ts`

**Steps:**

1. In `withFirstMessageTimeout`, call `abortController.abort()` before throwing `FirstMessageTimeoutError`
2. Add test verifying SDK call is aborted
3. Commit

**Verifier gate:**

- `bun test packages/providers/src/claude/provider.test.ts` → PASS

---

### Task 3.2: Fix `expandEnvVars` Silent Coercion of `undefined`

**Objective:** Leave placeholder intact when env var is undefined.

**File:** `packages/providers/src/utils/env-helpers.ts` (from Phase 1.5)

**Steps:**

1. In `expandEnvVars`, check `env[varName] !== undefined` before replacing
2. If undefined, leave `$VAR_NAME` intact or emit warning
3. Add test
4. Commit

**Verifier gate:**

- `bun test` → PASS

---

### Task 3.3: Add Retry + Error Classification to Pi

**Objective:** Match Claude/Codex resilience.

**File:** `packages/providers/src/community/pi/provider.ts`

**Steps:**

1. Import shared `classifyProviderError` and `withRetry` from `utils/retry-loop.ts`
2. Wrap `session.prompt()` in retry loop
3. Add `classifyPiError(err)` helper
4. Write tests for retry behavior
5. Commit

**Verifier gate:**

- `bun test packages/providers/src/community/pi/` → PASS

---

### Task 3.4: Fix Hermes `provider.ts` Env Spread Redundancy

**Objective:** Use `session.env` directly instead of re-spreading `process.env`.

**File:** `packages/providers/src/hermes/provider.ts`

**Steps:**

1. Change `env: { ...process.env, ...session.env }` to `env: session.env`
2. Run tests
3. Commit

**Verifier gate:**

- `bun test packages/providers/src/hermes/` → PASS

---

### Task 3.5: Fix Hermes Event-Bridge JSON-RPC Error Handling

**Objective:** Explicitly handle `JsonRpcError` responses from `initialize` and `session/new`.

**File:** `packages/providers/src/hermes/event-bridge.ts`

**Steps:**

1. After each `sendRequest`, check `'error' in response`
2. Throw clear error with JSON-RPC error message
3. Add tests for error responses
4. Commit

**Verifier gate:**

- `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS

---

### Task 3.6: Fix Pi Early Abort Check

**Objective:** Check `abortSignal` before expensive SDK setup.

**File:** `packages/providers/src/community/pi/provider.ts`

**Steps:**

1. Add `if (requestOptions?.abortSignal?.aborted) throw new Error('Query aborted')` immediately after parsing config
2. Add test
3. Commit

**Verifier gate:**

- `bun test` → PASS

---

## Phase 4: Type Safety & Export Consistency

### Task 4.1: Add Index Signature to `HermesProviderDefaults`

**Objective:** Match Claude, Codex, Pi defaults shape.

**File:** `packages/providers/src/types.ts`

**Steps:**

1. Add `[key: string]: unknown` to `HermesProviderDefaults`
2. Run type check
3. Commit

**Verifier gate:**

- `bun run type-check` → PASS

---

### Task 4.2: Export `HermesProviderDefaults` and `PiModelRef` from `index.ts`

**Objective:** Consistent package exports.

**File:** `packages/providers/src/index.ts`

**Steps:**

1. Add `export type { HermesProviderDefaults } from './hermes/config'`
2. Add `export type { PiModelRef } from './community/pi/model-ref'`
3. Run type check
4. Commit

**Verifier gate:**

- `bun run type-check` → PASS

---

### Task 4.3: Fix Hardcoded Version in Hermes ACP

**Objective:** Import version from `@archon/paths` or `package.json`.

**File:** `packages/providers/src/hermes/event-bridge.ts`

**Steps:**

1. Import `version` from `@archon/paths` (or read from `package.json`)
2. Replace `'0.3.9'` with imported version
3. Run tests
4. Commit

**Verifier gate:**

- `grep -r "0.3.9" packages/providers/src/hermes/` → zero hits
- `bun test` → PASS

---

## Phase 5: Dead Code & Test Coverage

### Task 5.1: Delete Orphaned `acp-bridge.ts`

**Objective:** Remove dead code that gives false confidence.

**Files:**

- Delete: `packages/providers/src/hermes/acp-bridge.ts`
- Delete: `packages/providers/src/hermes/acp-bridge.test.ts` (if exists)

**Steps:**

1. Verify `event-bridge.ts` does not import from `acp-bridge.ts`
2. Delete files
3. Run tests
4. Commit

**Verifier gate:**

- `ls packages/providers/src/hermes/acp-bridge.ts` → file not found
- `bun test` → PASS

---

### Task 5.2: Delete Stale `hermes-cli.mock.ts`

**Objective:** Remove 361 lines of unused pre-ACP mock code.

**File:** `packages/providers/src/test/mocks/hermes-cli.mock.ts`

**Steps:**

1. Verify no imports reference this file
2. Delete
3. Run tests
4. Commit

**Verifier gate:**

- `grep -r "hermes-cli.mock" packages/providers/src/` → zero hits
- `bun test` → PASS

---

### Task 5.3: Add Dedicated CodexProvider Tests

**Objective:** Fill test coverage gap.

**File:** `packages/providers/src/codex/provider.test.ts`

**Steps:**

1. Create test file with basic provider instantiation test
2. Test `getType()`, `getCapabilities()`
3. Test `sendQuery` with mocked SDK
4. Run tests
5. Commit

**Verifier gate:**

- `bun test packages/providers/src/codex/provider.test.ts` → PASS

---

### Task 5.4: Add Dedicated HermesProvider Tests

**Objective:** Fill test coverage gap.

**File:** `packages/providers/src/hermes/provider.test.ts`

**Steps:**

1. Create test file with provider instantiation
2. Test `getType()`, `getCapabilities()`
3. Test `sendQuery` with mocked `child_process.spawn`
4. Run tests
5. Commit

**Verifier gate:**

- `bun test packages/providers/src/hermes/provider.test.ts` → PASS

---

## Phase 6: Final Integration & Verification

### Task 6.1: Run Full Validation

**Command:** `bun run validate`

**Expected:** All five checks pass:

1. `check:bundled` — bundled defaults match source
2. `type-check` — zero TypeScript errors
3. `lint` — zero ESLint warnings
4. `format:check` — no formatting issues
5. `test` — all packages pass

**If any check fails:** Fix and re-run until all pass.

---

### Task 6.2: Create PR

**Command:**

```bash
git checkout -b fix/provider-audit-$(date +%Y%m%d)
git push origin fix/provider-audit-$(date +%Y%m%d)
gh pr create --title "fix(providers): address audit findings — shared utilities, security bugs, type safety" \
  --body "Fixes CRITICAL and IMPORTANT findings from provider audit. See .hermes/plans/audit-master-synthesis.md"
```

---

## Verification Gates Summary

| Phase | Gate                       | Check                                            |
| ----- | -------------------------- | ------------------------------------------------ |
| 0     | Pre-flight                 | `bun run test` passes, git clean                 |
| 1.1   | AsyncQueue extracted       | Single `AsyncQueue` class, tests pass            |
| 1.2   | Binary resolver extracted  | Generic resolver, thin wrappers, tests pass      |
| 1.3   | Lazy logger extracted      | Zero `cachedLog` duplication, tests pass         |
| 1.4   | Retry loop extracted       | Shared retry, tests pass                         |
| 1.5   | Env helpers extracted      | Shared expand/merge, tests pass                  |
| 2.1   | Pi extensions default      | `enableExtensions` defaults to false             |
| 2.2   | Pi env mutation stopped    | No `process.env` assignments in Pi               |
| 2.3   | Hermes cancel notification | Uses `createNotification`                        |
| 2.4   | Hermes test batching       | No mock pollution                                |
| 3.1   | Timeout aborts SDK         | `abortController.abort()` called                 |
| 3.2   | Env expansion safe         | No `undefined` coercion                          |
| 3.3   | Pi retry added             | Retry loop wraps `session.prompt()`              |
| 3.4   | Hermes env clean           | `session.env` used directly                      |
| 3.5   | JSON-RPC errors handled    | Error responses throw clearly                    |
| 3.6   | Pi early abort             | Signal checked before SDK setup                  |
| 4.1   | Hermes defaults typed      | Index signature present                          |
| 4.2   | Exports consistent         | `HermesProviderDefaults` + `PiModelRef` exported |
| 4.3   | Version dynamic            | No hardcoded `'0.3.9'`                           |
| 5.1   | Dead code removed          | `acp-bridge.ts` deleted                          |
| 5.2   | Stale mock removed         | `hermes-cli.mock.ts` deleted                     |
| 5.3   | Codex tests added          | `provider.test.ts` exists and passes             |
| 5.4   | Hermes tests added         | `provider.test.ts` exists and passes             |
| 6.1   | Full validation            | `bun run validate` passes all 5 checks           |
| 6.2   | PR created                 | Branch pushed, PR opened                         |

---

_Plan generated from audit-master-synthesis.md findings. 22 tasks across 6 phases with explicit verifier gates at each step._
