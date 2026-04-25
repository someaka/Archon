# ACP Migration Finalization Plan

> **For Hermes:** Use subagent-driven-development + executor-verifier-loop skills.
> **Target:** `/home/d/Desktop/Archon-canonical` (GROUND_SOURCE)
> **Base commit:** `fb8f9953` — "feat: add Hermes Agent provider support across CLI and providers"
> **Date:** 2026-04-25

**Goal:** Finish the ACP migration from `hermes chat --quiet --json` to `hermes acp` JSON-RPC 2.0. All core code is written. Remaining work: verify full test suite, fix any regressions, commit.

**Architecture:** 4 verification phases. Each phase has a concrete gate command. Execute phases sequentially. Only Phase 2 (fixes) may need delegation if failures are found.

---

## Current State

**ACP migration code written and passing (93 pass, 9 fail, 1 error):**

- 9 failures = pre-existing `binary-resolver.test.ts` Bun mock.module() issue (NOT ACP-related, documented in port plan)
- All ACP tests green: acp-protocol (6), acp-bridge (5), event-bridge (20), provider (7), options-translator (17), registry (40), model-ref (5)

**Files in working tree (17 changed):**

```
M  .archon/workflows/defaults/hermes-local-review.yaml          (staged)
 M .archon/workflows/defaults/plan-with-claude-...yaml           (unstaged)
 M packages/providers/src/hermes/event-bridge.ts                 (rewritten for ACP)
 M packages/providers/src/hermes/event-bridge.test.ts            (ACP mocks)
 M packages/providers/src/hermes/model-ref.ts                    (isHermesModelCompatible → always true)
 M packages/providers/src/hermes/model-ref.test.ts               (updated reject→accept tests)
 M packages/providers/src/hermes/options-translator.ts           (buildHermesCliArgs removed)
 M packages/providers/src/hermes/options-translator.test.ts      (stale flag tests removed)
 M packages/providers/src/hermes/provider.ts                     (spawns ['acp'])
 M packages/providers/src/hermes/provider.test.ts                (ACP mock format)
 M packages/providers/src/index.ts                               (buildHermesCliArgs removed from exports)
 M packages/providers/src/registry.test.ts                       (isModelCompatible always true)
 M packages/workflows/src/defaults/bundled-defaults.generated.ts (model strings stripped)
?? packages/providers/src/hermes/acp-bridge.ts
?? packages/providers/src/hermes/acp-bridge.test.ts
?? packages/providers/src/hermes/acp-protocol.ts
?? packages/providers/src/hermes/acp-protocol.test.ts
?? .hermes/
```

---

## Phases

### Phase 0: Lint the Providers Package

**Gate:** `bunx eslint packages/providers/ --cache` exits 0, no warnings

Root-level `bun run lint` OOMs (Bun ESLint heap). Run on providers package only.

**Actions:**

- Run `bunx eslint packages/providers/ --cache`
- If warnings: fix them
- If clean: proceed

### Phase 1: Full Test Suite — All Packages

**Gate:** `bun run test` exits 0

This runs `bun --filter '*' test` which splits by package. All packages must pass.

**Actions:**

- Run `bun run test`
- If any test failure outside `packages/providers/src/hermes/binary-resolver.test.ts`: investigate and fix
- The 9 binary-resolver failures are pre-existing (Bun mock.module contamination), not ACP-related

## Known failures to FIX:

- `binary-resolver.test.ts` — 9 failures + 1 error. Preexisting Bun `mock.module()` contamination from port. MUST be fixed — zero tolerance for test failures.

### Phase 2: Fix Any Regressions

Only if Phase 1 finds failures. Dispatch fixer subagent per failing test.

### Phase 3: Full Type Check

**Gate:** `bun run type-check` exits 0

### Phase 4: Final Integration Verification

**Gate:**

- `git diff --stat` shows only expected files
- No temp files, no debug artifacts
- All ACP files present and correct
- `bun test packages/providers/src/hermes/` → 93 pass (9 pre-existing failures OK)
- No stale imports of `buildHermesCliArgs` anywhere
- `grep -r 'buildHermesCliArgs' packages/` returns nothing
- `grep -r 'hermes chat' packages/` returns nothing
- `grep -r 'chat.*--json' packages/` returns nothing in hermes files

---

## Verification Gates Summary

| Phase | Gate Command                              | Expected                                           |
| ----- | ----------------------------------------- | -------------------------------------------------- |
| P0    | `bunx eslint packages/providers/ --cache` | exit 0, 0 warnings                                 |
| P1    | `bun run test`                            | All pass (binary-resolver 9 fail pre-existing, OK) |
| P2    | Fixer delegation                          | Only if P1 finds new failures                      |
| P3    | `bun run type-check`                      | exit 0                                             |
| P4    | `git diff --stat` + grep checks           | Only expected files, no stale imports              |

---

## Dependencies

```
P0 (lint) → P1 (test) → P2 (fix if needed) → P3 (type-check) → P4 (final verify) → COMMIT
```

All phases sequential — each depends on the previous.

---

## Expected Outcome

All phases GREEN → commit all changes with message:

```
feat(providers): migrate Hermes provider from chat --json to ACP JSON-RPC 2.0

Replace text-parsing bridge with structured ACP (Agent Client Protocol)
JSON-RPC 2.0 over stdio via `hermes acp`. ACP handles session lifecycle
natively (initialize → session/new → session/prompt) with streaming
session/update notifications. Remove deprecated buildHermesCliArgs.

- Add acp-protocol.ts: JSON-RPC 2.0 types, builders, parser (6 tests)
- Add acp-bridge.ts: ACP request sequence builder (5 tests)
- Rewrite event-bridge.ts: ACP JSON-RPC handler replacing text buffer
- Update provider.ts: spawn `['acp']` instead of `['chat', '--json']`
- Remove buildHermesCliArgs from options-translator
- Update all tests for ACP mock format
- Update isHermesModelCompatible to always return true (ACP model resolution)
- Strip hardcoded model strings from hermes workflow YAMLs
```
