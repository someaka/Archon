# Hermes Port Plan — Archon-canonical

> **Target:** `/home/d/Desktop/Archon-canonical` (fresh clone of `coleam00/Archon`, dev branch, `91226735`)
> **Sources:** `Archon-upstream` (`feature/hermes-provider`, HEAD `41c452c`) + `Archon-hermes-bridge` (`main`, HEAD `5c29d65`)
> **Methodology:** Subagent-driven with executor-verifier-loop
> **Date:** 2026-04-24

---

## Situation

Three repos existed:
1. **Archon-upstream** — local clone of `coleam00/Archon` on `feature/hermes-provider`. Has Hermes provider COMMITTED (7+ commits) + 6 uncommitted changes (with bugs).
2. **Archon-hermes-bridge** — fork from `someaka/Archon-hermes-bridge`. Has Hermes provider COMMITTED (5 earlier commits) + 8 uncommitted polish changes (Tasks 1-5) + 2 untracked workflow YAMLs.
3. **Archon-canonical** — NEW fresh clone of latest `coleam00/Archon` dev (`91226735`). Has ZERO Hermes code. This is the sole source of truth going forward.

Both source repos contain the Hermes feature. The bridge has additional polish work not in upstream. Upstream has newer commits (credential gate, server boot tests) not in bridge.

## Port Strategy

Port ALL Hermes features to canonical in dependency order. Source from whichever repo has the most complete/correct version. Never write to the old repos — only to canonical.

## Port Units

### P0: Hermes Provider Core (committed from upstream)
**Source:** Archon-upstream (committed code on `feature/hermes-provider`)
**Files to create:**
```
packages/providers/src/hermes/index.ts
packages/providers/src/hermes/provider.ts
packages/providers/src/hermes/registration.ts
packages/providers/src/hermes/capabilities.ts
packages/providers/src/hermes/config.ts
packages/providers/src/hermes/model-ref.ts
packages/providers/src/hermes/options-translator.ts
packages/providers/src/hermes/event-bridge.ts
packages/providers/src/hermes/binary-resolver.ts
packages/providers/src/hermes/session-resolver.ts
packages/providers/src/hermes/config.test.ts
packages/providers/src/hermes/provider.test.ts
packages/providers/src/hermes/model-ref.test.ts
packages/providers/src/hermes/options-translator.test.ts
packages/providers/src/hermes/event-bridge.test.ts
packages/providers/src/hermes/binary-resolver.test.ts
packages/providers/src/hermes/session-resolver.test.ts
packages/providers/src/test/mocks/hermes-cli.mock.ts
```
**Files to modify:**
- `packages/providers/src/types.ts` — add `HermesProviderDefaults` interface
- `packages/providers/src/registry.ts` — add `registerHermesProvider()` call in `registerBuiltinProviders()`
- `packages/providers/src/index.ts` — add Hermes re-exports
**Verification:** `bun test packages/providers/src/hermes/` — 117 pass, 0 fail

### P1: Config Integration (committed)
**Source:** Archon-upstream (committed)
**Files to modify:**
- `packages/core/src/config/config-types.ts` — add `hermes` to `AssistantProviderId` and `AssistantDefaults`
- `packages/core/src/config/config-loader.ts` — add `SAFE_ASSISTANT_FIELDS.hermes` + `HERMES_*` env overrides
**Verification:** `bun test packages/core/` config-loader tests pass

### P2: Server Credential Gate (committed from upstream)
**Source:** Archon-upstream (committed)
**Files to create:**
- `packages/server/src/credentials.ts`
- `packages/server/src/credentials.test.ts`
- `packages/server/src/boot-e2e.test.ts` (if not already present)
**Note:** Check if canonical's server already has credential gate — if so, merge Hermes into it.
**Verification:** `bun test packages/server/src/credentials.test.ts` passes

### P3: CLI Setup Wizard (committed from bridge)
**Source:** Archon-hermes-bridge (committed, commit `6da30c5`)
**Files to modify:**
- `packages/cli/src/commands/setup.ts` — add `collectHermesConfig()`, `HERMES_INSTALL_INSTRUCTIONS`, Hermes binary validation, Hermes in default assistant selector, `HERMES_*` env output
**Verification:** `bun test packages/cli/src/commands/setup.test.ts` — existing tests pass

### P4: Web UI Settings (committed from bridge + polish from Task 3)
**Source:** Archon-hermes-bridge
**Files to modify:**
- `packages/web/src/routes/SettingsPage.tsx` — add Hermes editor block (model input, provider select, endpoint input)
**Verification:** `grep "hermes-model\|hermes-provider\|hermes-endpoint" packages/web/src/routes/SettingsPage.tsx` — 3 matches found

### P5: Workflow Engine + Tests (committed from bridge)
**Source:** Archon-hermes-bridge (committed)
**Files to create:**
- `packages/workflows/src/hermes-integration.test.ts`
- `packages/workflows/src/hermes-e2e.test.ts`
**Files to modify:**
- `packages/workflows/src/deps.ts` — add `hermes: HermesProviderDefaults` to `WorkflowConfig.assistants`
- `packages/workflows/package.json` — add hermes test scripts to test commands (do NOT port version regression)
**Verification:** `bun test packages/workflows/src/hermes-integration.test.ts` — 2 pass; `bun test packages/workflows/src/hermes-e2e.test.ts` — 1 pass

### P6: Documentation
**Source:** Archon-upstream (committed)
**Files to create:**
- `packages/docs-web/src/content/docs/reference/troubleshooting-hermes.md`
**Files to modify:**
- `.env.example` — add Hermes section (5 env vars)
**Verification:** Files exist with meaningful content

### P7: Registry Tests Polish (Task 1 — uncommitted from bridge)
**Source:** Archon-hermes-bridge (uncommitted working tree)
**Files to modify:**
- `packages/providers/src/registry.test.ts` — update counts 2→3, add 5 Hermes test blocks
- `packages/providers/src/registry.ts` — JSDoc "(Claude, Codex)" → "(Claude, Codex, Hermes)"
**Verification:** `bun test packages/providers/src/registry.test.ts` — 40 pass, 0 fail

### P8: Security Fix — hermesBinaryPath (Task 2 — uncommitted from bridge)
**Source:** Archon-hermes-bridge (uncommitted)
**Files to modify:**
- `packages/core/src/config/config-loader.ts` — remove `'hermesBinaryPath'` from `SAFE_ASSISTANT_FIELDS.hermes`
**Verification:** `grep "hermesBinaryPath" packages/core/src/config/config-loader.ts` — only in env-override section, NOT in SAFE_ASSISTANT_FIELDS

### P9: CLI Setup Tests (Task 4 — uncommitted from bridge)
**Source:** Archon-hermes-bridge (uncommitted)
**Files to modify:**
- `packages/cli/src/commands/setup.test.ts` — add 2 Hermes `generateEnvContent` test cases
**Verification:** `bun test packages/cli/src/commands/setup.test.ts` — tests include Hermes coverage, 0 fail

### P10: Hermes Example Workflows + Bundle Fix (Task 5 — uncommitted from bridge)
**Source:** Archon-hermes-bridge (uncommitted + untracked)
**Files to create:**
- `.archon/workflows/defaults/hermes-local-review.yaml`
- `.archon/workflows/defaults/plan-with-claude-implement-with-hermes.yaml`
**Files to modify:**
- `scripts/generate-bundled-defaults.ts` — throw→warn+continue for empty files
- `packages/workflows/src/defaults/bundled-defaults.generated.ts` — add 2 Hermes entries
**Verification:** `grep "hermes-local-review" packages/workflows/src/defaults/bundled-defaults.generated.ts` — match found

### P11: Final Integration Verification
**Actions:**
1. Run full test suite: `bun test packages/providers/`, `bun test packages/core/`, `bun test packages/cli/`, `bun test packages/workflows/`, `bun test packages/server/`
2. Verify zero regressions from canonical baseline
3. Clean working tree check
**Verification:** All tests pass across all packages

---

## Dependency Graph

```
P0 (provider core) ─────────────────────────────────────────────┐
  ├──► P1 (config) ──► P2 (server credential gate)                │
  ├──► P3 (CLI setup) ──► P9 (CLI tests)                         │
  ├──► P4 (web UI)                                                │
  ├──► P5 (workflow engine)                                       │
  ├──► P6 (docs)                                                  │
  └──► P7 (registry tests) ──► P8 (security fix)                  │
                                                                  │
P10 (workflows + bundle fix) ── depends on P0 (YAML reads hermes)│
                                                                  │
P11 (final verification) ── depends on ALL                        │
```

**Batches:**
- **Batch 1** (parallel): P0 (provider core) — must complete first
- **Batch 2** (parallel): P1, P3, P4, P5, P6 — all depend on P0, independent of each other
- **Batch 3** (parallel): P7, P8, P9, P10 — depend on respective batch-2 units
- **Batch 4** (sequential): P2 (server) — may need careful merging with canonical server code
- **Batch 5** (final): P11 — run everything

---

## Known Issues to Avoid Porting

1. **`ollama` missing from `HERMES_CLI_PROVIDERS`** (upstream uncommitted) — FIX before porting: add `'ollama'` to the whitelist
2. **Version regression** `0.3.9→0.3.6` in `packages/workflows/package.json` (upstream uncommitted) — DO NOT PORT
3. **Empty `.md` stub files** in `.archon/commands/defaults/` — same in both repos, not a porting issue
4. **`binary-resolver.test.ts` 9 failures** — pre-existing mock.module() + dynamic import Bun bug, not regressions

---

## Verification Gate Commands

| Gate | Command | Expected |
|------|---------|----------|
| G0 | `bun test packages/providers/src/hermes/` | 117 pass, 0 fail |
| G1 | `bun test packages/core/` (config-loader) | No new failures |
| G2 | `bun test packages/server/src/credentials.test.ts` | Pass |
| G3 | `bun test packages/cli/src/commands/setup.test.ts` | Hermes tests pass |
| G4 | `grep "hermes-model" packages/web/src/routes/SettingsPage.tsx` | Match |
| G5 | `bun test packages/workflows/src/hermes-integration.test.ts` | 2 pass |
| G6 | `bun test packages/providers/src/registry.test.ts` | 40 pass, 0 fail |
| G7 | `grep "hermesBinaryPath" packages/core/src/config/config-loader.ts` | Only in env-override |
| G8 | `grep "hermes-local-review" packages/workflows/src/defaults/bundled-defaults.generated.ts` | Match |

---

## Methodology

- **Max 3 concurrent executors** per batch
- **Fresh verifier** per completed unit — never self-verify
- **Location assertion** in every verifier gate (`pwd` must match `/home/d/Desktop/Archon-canonical`)
- **3 remediation iterations max** per unit, escalate on failure
- **All writes go to `/home/d/Desktop/Archon-canonical` only** — NEVER modify source repos
