# Archon-Hermes-Bridge Forensic Inventory

> **Generated:** 2026-04-24T21:02 UTC  
> **Analyst:** Hermes Agent (code-divergence-forensics)  
> **Source:** `/home/d/Desktop/Archon-hermes-bridge` (fork from `someaka/Archon-hermes-bridge`, branch `main`)  
> **Baseline:** `/home/d/Desktop/Archon-canonical` (fresh clone of `coleam00/Archon`, branch `dev`, commit `91226735`)  

---

## 1. Git State Summary

| Property | Value |
|----------|-------|
| Remote origin | `https://github.com/someaka/Archon-hermes-bridge.git` |
| Branch | `main` (up to date with `origin/main`) |
| Commit count | 6 total (fresh fork + 5 Hermes commits) |
| Uncommitted modified files | 8 |
| Untracked files | 2 workflow YAML files + `docs/` directory |
| Staged changes | None |
| Working tree | Dirty (uncommitted polish work) |

### Commit History (oldest → newest)

```
5c29d65 test(workflows): add Hermes E2E workflow execution test
a181d00 docs(docs-web): add Hermes troubleshooting page
6da30c5 feat(cli): validate Hermes endpoint and binary path in setup wizard
a26bafb test(workflows): add Hermes integration tests + type safety
e7a6b76 feat(config): add Hermes safe fields and HERMES_* env overrides
a9622b5 first commit
```

---

## 2. Complete Hermes File Inventory

### 2.1 Core Provider Package (`packages/providers/src/hermes/`)

15 files, **89,071 bytes** total. **All are bridge-only** — canonical has no `hermes/` directory.

| File | Size | Lines | Description |
|------|------|-------|-------------|
| `index.ts` | 687 B | 16 | Public API re-exports |
| `capabilities.ts` | 1,344 B | 38 | `HERMES_CAPABILITIES` constant — conservative v1 flags |
| `config.ts` | 1,510 B | 48 | `parseHermesConfig()` — defensive YAML-to-typed parser |
| `model-ref.ts` | 2,858 B | 77 | `parseHermesModelRef()` + `isHermesModelCompatible()` |
| `provider.ts` | 4,649 B | 135 | `HermesProvider` class — `spawn()`-based, implements `IAgentProvider` |
| `event-bridge.ts` | 16,744 B | 492 | `bridgeHermesSession()` + `AsyncQueue<T>` — largest file |
| `options-translator.ts` | 5,478 B | 168 | `buildHermesCliArgs()`, `resolveHermesModel/Provider/Endpoint()` |
| `session-resolver.ts` | 2,658 B | 67 | `resolveHermesSession()` — stateless per-invocation context |
| `registration.ts` | 864 B | 25 | `registerHermesProvider()` — idempotent registration hook |
| `config.test.ts` | 4,219 B | — | Config parser tests |
| `model-ref.test.ts` | 3,752 B | — | Model ref parser tests |
| `provider.test.ts` | 11,104 B | — | Provider unit tests |
| `event-bridge.test.ts` | 20,522 B | — | Event bridge tests (largest test file) |
| `options-translator.test.ts` | 8,990 B | — | Options translator tests |
| `session-resolver.test.ts` | 3,692 B | — | Session resolver tests |

### 2.2 Hermes-Related Files Outside `hermes/` Directory

| File | Purpose | In Canonical? |
|------|---------|---------------|
| `packages/providers/src/test/mocks/hermes-cli.mock.ts` | Mock Hermes CLI process factory (363 lines) | **No** |
| `packages/workflows/src/hermes-integration.test.ts` | Multi-provider DAG integration tests (318 lines) | **No** |
| `packages/workflows/src/hermes-e2e.test.ts` | E2E `executeWorkflow()` test with `provider: hermes` (178 lines) | **No** |
| `packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md` | User-facing troubleshooting doc (82 lines) | **No** |
| `docs/plans/2026-04-24-hermes-integration-polish.md` | Polish & fix implementation plan (475 lines) | **No** |
| `docs/plans/hermes-server-boot-plan.md` | Hermes-first server boot plan (734 lines) | **No** |

### 2.3 Hermes Workflow YAML Files (`.archon/workflows/defaults/`)

| File | Size | Status |
|------|------|--------|
| `hermes-local-review.yaml` | 287 B | **Untracked** (not in git) |
| `plan-with-claude-implement-with-hermes.yaml` | 443 B | **Untracked** (not in git) |

---

## 3. Committed Features Inventory

Each Hermes commit with semantic description:

### Commit `e7a6b76` — `feat(config): add Hermes safe fields and HERMES_* env overrides`
- Added `hermes` entry to `SAFE_ASSISTANT_FIELDS` in `config-loader.ts` with fields: `['model', 'provider', 'endpoint', 'hermesBinaryPath']`
- Added 4 `HERMES_*` environment variable overrides: `HERMES_MODEL`, `HERMES_PROVIDER`, `HERMES_ENDPOINT`, `HERMES_BINARY_PATH`
- Wired them into the config loading pipeline (process.env → config.assistants.hermes)

### Commit `a26bafb` — `test(workflows): add Hermes integration tests + type safety`
- Added `hermes-integration.test.ts`: 2 test suites covering single-provider (Hermes-only) and multi-provider (Claude→Hermes) DAG execution
- Added Hermes to `WorkflowConfig.assistants` type in `deps.ts`
- Added `hermes` to mock configs in integration tests

### Commit `6da30c5` — `feat(cli): validate Hermes endpoint and binary path in setup wizard`
- Added `collectHermesConfig()` to CLI setup wizard
- Validates Hermes binary availability via `which`/`where` command
- Prompts for model, provider, endpoint, and binary path
- Generates `HERMES_*` entries in `.env` output
- Added install instructions for `pip install hermes-agent` / `npm install -g @nousresearch/hermes-agent`
- Added Hermes to the default assistant selector (alongside Claude and Codex)

### Commit `a181d00` — `docs(docs-web): add Hermes troubleshooting page`
- Added `troubleshooting-hermes.md` with 6 common issues:
  1. Hermes not found (ENOENT)
  2. Model not available
  3. Connection refused to Ollama
  4. Hermes hangs or times out
  5. Provider switching not working
  6. Binary path validation fails during setup

### Commit `5c29d65` — `test(workflows): add Hermes E2E workflow execution test`
- Added `hermes-e2e.test.ts`: exercises `executeWorkflow()` with `provider: 'hermes'`
- Uses `mock.module('./dag-executor')` to isolate from the actual DAG executor
- Runs in a separate `bun test` invocation to avoid `mock.module` pollution

---

## 4. Uncommitted Changes Inventory

All 8 uncommitted changes correspond exactly to **Tasks 1–5** of the polish plan. None are committed; all are in the working tree.

### 4.1 `packages/providers/src/registry.test.ts` (+60/–9 lines)

**Semantic change:** Updates all hardcoded test assertions from 2 built-in providers to 3 (adding Hermes).

- Changes `expect(all.length).toBe(2)` → `.toBe(3)` (3 locations)
- Changes `expect(ids).toEqual(['claude', 'codex', 'pi'])` → `['claude', 'codex', 'hermes', 'pi']`
- Updates error message assertion: `"Available: claude, codex"` → `"Available: claude, codex, hermes"`
- Adds 5 new Hermes-specific test blocks:
  - `'returns HermesProvider for hermes type'`
  - `'returns Hermes capabilities without instantiation'`
  - `'matches runtime getCapabilities for Hermes'`
  - `'Hermes registration declares conservative v1 capabilities'` (verifies all 13 capability flags)
  - `'Hermes isModelCompatible accepts hermes refs'` (tests 4 model ref patterns)
- Adds `hermes` to `isRegisteredProvider`, `registerBuiltinProviders` idempotency, and `getRegisteredProviders` assertions

### 4.2 `packages/providers/src/registry.ts` (+1/–1 line)

**Semantic change:** JSDoc update only. Changes docstring on `registerBuiltinProviders()`:
```
- * Register built-in providers (Claude, Codex). Idempotent ...
+ * Register built-in providers (Claude, Codex, Hermes). Idempotent ...
```

### 4.3 `packages/core/src/config/config-loader.ts` (+1/–1 line)

**Semantic change:** **Security fix.** Removes `'hermesBinaryPath'` from `SAFE_ASSISTANT_FIELDS`.

```
- hermes: ['model', 'provider', 'endpoint', 'hermesBinaryPath'],
+ hermes: ['model', 'provider', 'endpoint'],
```

Rationale: Absolute filesystem paths are sensitive. Claude and Codex binary paths are NOT exposed in safe config; Hermes should follow the same rule. The `hermesBinaryPath` is still loaded via `HERMES_BINARY_PATH` env var override (line 360–362) but is NOT exposed to the web UI's safe config API.

### 4.4 `packages/web/src/routes/SettingsPage.tsx` (+47 lines)

**Semantic change:** Adds a dedicated Hermes provider settings editor in the Web UI Assistant Configuration section.

- New conditional block: `if (provider.id === 'hermes')` renders a custom form with:
  - **Model** text input (placeholder: `qwen2.5-coder:32b`)
  - **Provider** dropdown select: Ollama, OpenRouter, OpenAI, Anthropic
  - **Endpoint** text input (placeholder: `http://localhost:11434/v1`)
- Uses the same grid layout pattern as Claude/Codex editors (`grid-cols-[140px_1fr]`)
- Integrates with existing `updateProviderSettings('hermes', ...)` state management

### 4.5 `packages/cli/src/commands/setup.test.ts` (+44 lines)

**Semantic change:** Adds Hermes-specific test coverage for `generateEnvContent()`.

- **Case 1:** `'should include Hermes configuration when configured'` — verifies that when `hermes: true` with model/provider/endpoint/binaryPath, the generated `.env` contains:
  - `DEFAULT_AI_ASSISTANT=hermes`
  - `HERMES_MODEL=qwen2.5-coder:32b`
  - `HERMES_PROVIDER=ollama`
  - `HERMES_ENDPOINT=http://localhost:11434/v1`
  - `HERMES_BINARY_PATH=/usr/local/bin/hermes`
- **Case 2:** `'should omit Hermes fields when not configured'` — verifies no `HERMES_*` lines when `hermes: false`

### 4.6 `packages/workflows/src/defaults/bundled-defaults.generated.ts` (+2 lines)

**Semantic change:** Adds 2 new bundled workflow entries to the generated file:
1. `"hermes-local-review"` — single-node code review workflow using `provider: hermes`, `model: qwen2.5-coder:32b`
2. `"plan-with-claude-implement-with-hermes"` — 2-node DAG: plan (Claude) → implement (Hermes)

### 4.7 `scripts/generate-bundled-defaults.ts` (+2/–1 lines)

**Semantic change:** Changes how empty YAML files are handled during bundle generation.

```
- throw new Error(`Bundled default "${entry}" in ${dir} is empty.`);
+ console.warn(`Skipping empty bundled default "${entry}" in ${dir}.`);
+ continue;
```

Previously, the script threw a fatal error if any `.archon/workflows/defaults/*.yaml` file was empty. Since the bridge repo has many empty YAML stub files (0 bytes), this prevented regeneration. The fix skips empty files with a warning, allowing generation to succeed.

### 4.8 `.archon/workflows/defaults/archon-assist.yaml` (+5 lines)

**Semantic change:** Populates a previously empty (0-byte) file with a minimal workflow definition:

```yaml
name: archon-assist
description: General-purpose coding assistant
nodes:
  - id: assist
    prompt: $ARGUMENTS
```

---

## 5. Files That Exist ONLY in Bridge (Not in Canonical)

### 5.1 Entirely New Directories

| Directory | Contents |
|-----------|----------|
| `packages/providers/src/hermes/` | 15 files, 89 KB — complete Hermes provider implementation |
| `packages/providers/src/test/mocks/` | `hermes-cli.mock.ts` (363 lines) — mock CLI process factory |

### 5.2 New Test Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/workflows/src/hermes-integration.test.ts` | 318 | Multi-provider DAG integration tests |
| `packages/workflows/src/hermes-e2e.test.ts` | 178 | E2E workflow execution with Hermes provider |

### 5.3 New Documentation

| File | Lines | Purpose |
|------|-------|---------|
| `packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md` | 82 | User-facing Hermes troubleshooting guide |
| `docs/plans/2026-04-24-hermes-integration-polish.md` | 475 | Polish implementation plan (this is the plan being executed) |
| `docs/plans/hermes-server-boot-plan.md` | 734 | Hermes-first server boot integration plan |

### 5.4 New Workflow YAML Files

| File | Purpose |
|------|---------|
| `.archon/workflows/defaults/hermes-local-review.yaml` | Single-node code review with local Hermes model |
| `.archon/workflows/defaults/plan-with-claude-implement-with-hermes.yaml` | 2-node DAG: Claude plans, Hermes implements |

---

## 6. Files That Differ Between Bridge and Canonical

### 6.1 `packages/providers/src/types.ts`

- **Canonical:** 319 lines, no `HermesProviderDefaults` type
- **Bridge:** Adds `HermesProviderDefaults` interface with fields: `model?`, `provider?`, `endpoint?`, `globalAuth?`, `hermesBinaryPath?`

### 6.2 `packages/providers/src/registry.ts`

- **Canonical:** `registerBuiltinProviders()` registers 2 providers (Claude, Codex). JSDoc says "(Claude, Codex)".
- **Bridge (committed):** Registers 3 providers (Claude, Codex, Hermes) via `registerHermesProvider()`. JSDoc says "(Claude, Codex)".
- **Bridge (uncommitted diff):** JSDoc updated to "(Claude, Codex, Hermes)".

### 6.3 `packages/providers/src/index.ts`

- **Canonical:** Does not export any Hermes types or functions
- **Bridge:** Exports `HermesProviderDefaults` type from `./types` and re-exports from `./hermes`

### 6.4 `packages/core/src/config/config-loader.ts`

- **Canonical:** `SAFE_ASSISTANT_FIELDS` has entries for `claude`, `codex`, `pi` only. No `HERMES_*` env overrides.
- **Bridge (committed):** Added `hermes: ['model', 'provider', 'endpoint', 'hermesBinaryPath']` entry. Added 4 `HERMES_*` env override blocks (HERMES_MODEL, HERMES_PROVIDER, HERMES_ENDPOINT, HERMES_BINARY_PATH).
- **Bridge (uncommitted diff):** Removed `'hermesBinaryPath'` from safe fields (security fix).

### 6.5 `packages/core/src/config/config-types.ts`

- **Bridge:** `AssistantProviderId` union includes `'hermes'`. `AssistantDefaults` interface includes `hermes?: HermesProviderDefaults`.

### 6.6 `packages/cli/src/commands/setup.ts`

- **Canonical:** 0 Hermes references. Assistant selection offers Claude and Codex only.
- **Bridge:** ~30+ Hermes references throughout. Adds:
  - `collectHermesConfig()` function
  - `HERMES_INSTALL_INSTRUCTIONS` constant
  - Hermes binary validation (`which hermes` / `where hermes`)
  - Hermes option in default assistant selector
  - `HERMES_*` env var generation in `.env` output
  - Hermes as a selectable AI assistant alongside Claude and Codex

### 6.7 `packages/web/src/routes/SettingsPage.tsx`

- **Canonical:** No Hermes UI. Provider list shows Claude and Codex only.
- **Bridge (committed):** No Hermes editor (uses generic fallback for unknown providers).
- **Bridge (uncommitted diff):** Adds dedicated Hermes editor with model input, provider select, and endpoint input.

### 6.8 `packages/workflows/src/deps.ts`

- **Canonical:** `WorkflowConfig.assistants` includes `claude` and `codex` only.
- **Bridge:** Added `hermes: HermesProviderDefaults` to `WorkflowConfig.assistants`.

### 6.9 `packages/workflows/src/defaults/bundled-defaults.generated.ts`

- **Canonical:** Contains 20 bundled workflows (no Hermes workflows).
- **Bridge (uncommitted diff):** Contains 22 bundled workflows (adds 2 Hermes workflows).

### 6.10 `scripts/generate-bundled-defaults.ts`

- **Canonical:** Throws on empty YAML files.
- **Bridge (uncommitted diff):** Warns and skips empty YAML files.

---

## 7. Hermes Feature Architecture Summary

### Provider Architecture
- **`HermesProvider`** implements `IAgentProvider`
- Invokes the Hermes CLI Python tool via `child_process.spawn()`
- Each `sendQuery()` creates a fresh process (stateless, single-shot)
- Model ref format: `hermes`, `hermes:provider/model`, `hermes:model`
- Supports multiple LLM backends: Ollama, OpenRouter, OpenAI, Anthropic

### Event Bridge (`bridgeHermesSession`)
- Custom `AsyncQueue<T>` for single-producer/single-consumer async bridging
- Parses newline-delimited JSON from `hermes chat --json` stdout
- Event types: `text_delta`, `tool_start`, `tool_output`, `tool_end`, `error`, `done`
- Maps Hermes events → Archon `MessageChunk` types
- Handles: abort signals (SIGTERM + SIGKILL fallback), non-zero exits, process errors, partial lines
- Zombie prevention: `childProcess.unref()`, defensive SIGKILL in `finally`

### Configuration
- `parseHermesConfig()` — defensive (never throws, drops invalid fields silently)
- Endpoint validation via `new URL()` in try/catch
- Ollama defaults: `http://localhost:11434/v1` when provider is `ollama` and no endpoint configured
- `HERMES_*` env var overrides: MODEL, PROVIDER, ENDPOINT, BINARY_PATH

### Capabilities (v1 — conservative)
| Capability | Value |
|------------|-------|
| `sessionResume` | `false` |
| `mcp` | `false` |
| `hooks` | `false` |
| `skills` | `true` |
| `agents` | `false` |
| `toolRestrictions` | `false` |
| `structuredOutput` | `false` |
| `envInjection` | `true` |
| `costControl` | `false` |
| `effortControl` | `false` |
| `thinkingControl` | `false` |
| `fallbackModel` | `true` |
| `sandbox` | `false` |

---

## 8. Test Results

| Test Suite | Result | Notes |
|------------|--------|-------|
| `packages/providers/src/registry.test.ts` | **40 pass, 0 fail** | Includes all new Hermes assertions |
| `packages/providers/src/hermes/` (6 test files) | **117 pass, 0 fail** | 96.14% line coverage, 86.87% function coverage |

Uncovered lines (minimal, intentional):
- `event-bridge.ts:442-443` — SIGKILL fallback timeout (hard to trigger in unit tests)
- `provider.ts:130-131` — error catch block in sendQuery

---

## 9. Build/Structural Issues

### 9.1 Empty Stub Files (Same in Both Repos)

**`.archon/commands/defaults/`**: 26 markdown files, all **0 bytes**:
`archon-assist.md`, `archon-auto-fix-review.md`, `archon-code-review-agent.md`, etc.

These exist in both bridge and canonical — not a bridge-specific issue. They exist as placeholder stubs for command definitions.

### 9.2 Empty Workflow YAML Files (Bridge Only)

Several workflow YAML files in `.archon/workflows/defaults/` are 0 bytes:
`archon-comprehensive-pr-review.yaml`, `archon-create-issue.yaml`, `archon-feature-development.yaml`, `archon-fix-github-issue.yaml`, `archon-idea-to-pr.yaml`, `archon-interactive-prd.yaml`, `archon-issue-review-full.yaml`, `archon-plan-to-pr.yaml`, `archon-ralph-dag.yaml`, `archon-remotion-generate.yaml`, `archon-resolve-conflicts.yaml`, `archon-smart-pr-review.yaml`, `archon-test-loop-dag.yaml`

The uncommitted change to `scripts/generate-bundled-defaults.ts` fixes a crash caused by these empty files (warns + skips instead of throwing).

### 9.3 `archon-assist.yaml` Fix

The `archon-assist.yaml` file was 0 bytes. The uncommitted change populates it with a 5-line minimal workflow definition.

---

## 10. The Uncommitted Polish Work

All uncommitted changes directly implement **Tasks 1–5** from `docs/plans/2026-04-24-hermes-integration-polish.md`:

| Plan Task | Description | Status |
|-----------|-------------|--------|
| **Task 1** | Fix registry tests for 3 built-in providers | ✅ Implemented (uncommitted) |
| **Task 2** | Remove `hermesBinaryPath` from safe config | ✅ Implemented (uncommitted) |
| **Task 3** | Add dedicated Hermes editor to SettingsPage | ✅ Implemented (uncommitted) |
| **Task 4** | Add Hermes `generateEnvContent` test coverage | ✅ Implemented (uncommitted) |
| **Task 5** | Add Hermes example workflows to bundled defaults | ✅ Implemented (uncommitted + untracked) |
| **Task 6** | Final integration verification | ⬜ Pending — requires test suite run across all packages |

The 2 untracked workflow YAML files (`hermes-local-review.yaml`, `plan-with-claude-implement-with-hermes.yaml`) are the source files for Task 5 — they should be committed alongside the regenerated `bundled-defaults.generated.ts`.

### Nice-to-haves (from polish plan, NOT yet addressed):
- [ ] Workflow Builder supports Hermes provider selection
- [ ] Performance benchmarks (Hermes vs Claude vs Codex) — deferred per original PR issue

---

## 11. Summary of Divergences from Canonical

| Category | Count | Description |
|----------|-------|-------------|
| **New files** | 22 | Hermes provider (15), tests (3), docs (2), mock (1), workflows (2 untracked) |
| **Modified files** | 8 | registry, config-loader, config-types, setup.ts, SettingsPage, deps.ts, index.ts, types.ts |
| **Committed changes** | 5 commits | Feature commits on top of fork base |
| **Uncommitted changes** | 8 files | Polish work from integration plan |
| **Untracked files** | 4 | 2 workflow YAMLs + 2 docs in `docs/` |
| **Files in canonical only** | 0 | (All bridge additions are additive) |
| **Test status** | All green | 157 tests pass (40 registry + 117 hermes) |

### Key Architectural Divergences:
1. **Canonical has NO Hermes code** — the entire provider is bridge-only
2. Bridge adds a **third built-in provider** alongside Claude and Codex
3. Bridge adds **4 environment variable overrides** for Hermes configuration
4. Bridge adds **CLI setup wizard support** for Hermes installation/configuration
5. Bridge adds **Web UI settings editor** for Hermes (pending commit)
6. Bridge adds **2 example workflows** demonstrating Hermes usage (pending commit)
7. Bridge fixes a **security issue** where `hermesBinaryPath` was exposed in safe config

---

*End of forensic inventory. This report is read-only and does not modify any source files.*
