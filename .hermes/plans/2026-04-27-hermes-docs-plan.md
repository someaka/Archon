# Hermes Provider — Documentation & Installation Fix Plan

> **Execution method:** Executor-verifier loop with distinct subagents. Max 2 concurrent executors (parallel with main polish pass). Each executor's output validated by fresh verifier.
>
> **Scope:** Documentation and installation instruction fixes only. No code behavior changes. No functional modifications to provider.ts, event-bridge.ts, or ACP protocol.

---

## Context

Online Hermes Agent documentation audit (hermes-agent.nousresearch.com) found 5 documentation/installation gaps between upstream recommendations and Archon's install instructions:

| #   | Issue                           | Location                         | Upstream Reality                                                          |
| --- | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| 1   | Outdated install command        | `binary-resolver.ts`             | Says `pip install hermes-cli`; upstream uses `uv pip install -e ".[all]"` |
| 2   | Missing Python 3.11 requirement | `binary-resolver.ts`, setup docs | Upstream requires Python 3.11                                             |
| 3   | Missing Node.js v22 requirement | Install docs                     | Upstream requires Node.js v22 for browser automation                      |
| 4   | Missing `uv` recommendation     | `binary-resolver.ts`             | Upstream strongly recommends `uv` package manager                         |
| 5   | No version gating               | `binary-resolver.ts`             | `verifyHermesBinary()` only checks executable, doesn't parse version      |
| 6   | Windows not documented          | Capabilities/docs                | Upstream doesn't support Windows                                          |

---

## Phase 1: Fix Install Instructions (D1)

### D1.1: Update `binary-resolver.ts` INSTALL_INSTRUCTIONS

**File:** `packages/providers/src/hermes/binary-resolver.ts`

**Current:**

```typescript
const INSTALL_INSTRUCTIONS = `
Hermes binary not found. Install with:
  pip install hermes-cli
Or set HERMES_BINARY_PATH to the binary location.
`;
```

**Fix:** Update to match upstream installation methods:

```typescript
const INSTALL_INSTRUCTIONS = `
Hermes binary not found.

Recommended install (requires Python 3.11 and uv):
  git clone https://github.com/NousResearch/hermes-agent.git
  cd hermes-agent
  uv pip install -e ".[all]"

Alternative (pip):
  pip install hermes-agent

Or set HERMES_BINARY_PATH to the binary location.
`;
```

**Test:** `bun --filter @archon/providers type-check` must pass.

---

### D1.2: Add version check to `verifyHermesBinary()`

**File:** `packages/providers/src/hermes/binary-resolver.ts`

**Current:** Only checks that `hermes --version` exits 0 within 5s.

**Fix:** Parse the version string and warn if below minimum. Minimum version TBD — check upstream for first version with `hermes acp` subcommand. If unknown, add TODO comment instead of hardcoding.

**Options:**

1. Parse `hermes --version` output, compare against `MIN_HERMES_VERSION`
2. If version below minimum, return `false` with enriched error message
3. If version parsing fails (unexpected format), log warning but don't fail (defensive)

**Test:** `bun test packages/providers/src/hermes/binary-resolver.test.ts` must pass. Add test for version parsing.

---

## Phase 2: Update Setup Wizard (D2)

### D2.1: Update `setup.ts` Hermes section

**File:** `packages/cli/src/commands/setup.ts`

**Current:** Collects `HERMES_BINARY_PATH`, `HERMES_MODEL`, `HERMES_PROVIDER`, `HERMES_ENDPOINT`.

**Fix:** Add prompts for:

- Python version check (warn if not 3.11+)
- `uv` availability check (recommend if missing)
- Node.js v22 check (warn if missing)

**Note:** These are advisory checks, not blocking. The provider should work if the binary is present regardless of how it was installed.

**Test:** `bun --filter @archon/cli type-check` must pass.

---

## Phase 3: Add Windows Limitation Note (D3)

### D3.1: Document Windows not supported

**File:** `packages/providers/src/hermes/capabilities.ts` or `packages/providers/src/hermes/provider.ts` comment

**Fix:** Add comment in capabilities or provider: "Hermes Agent upstream does not support Windows. Archon Hermes provider is Linux/macOS only."

**Also:** Add note in any user-facing docs (when docs are written).

**Test:** None needed — comment only.

---

## Phase 4: Final Gate (D4)

### D4.1: Type-check and test

**Commands:**

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check
bun --filter @archon/cli type-check
bun test packages/providers/src/hermes/binary-resolver.test.ts
```

**Expected:** All pass.

---

## Execution Batches

```
Batch 1 (independent):
  D1.1 — Update INSTALL_INSTRUCTIONS in binary-resolver.ts
  D1.2 — Add version check to verifyHermesBinary()

Batch 2 (depends on Batch 1, touches setup.ts):
  D2.1 — Update setup.ts Hermes section

Batch 3 (independent, comment only):
  D3.1 — Add Windows limitation note

Batch 4 (final):
  D4.1 — Type-check and test gate
```

---

## Executor-Verifier Rules

1. **Max 2 concurrent executors** (parallel with main polish pass)
2. **Never self-verify**: Fresh verifier per task
3. **No functional changes**: Only docs, comments, install instructions, version parsing
4. **Test mandate**: D1.2 needs test; others type-check only
5. **Clean workspace**: No temp files

---

## Files Modified (Expected)

| File                                                    | Action                                         |
| ------------------------------------------------------- | ---------------------------------------------- |
| `packages/providers/src/hermes/binary-resolver.ts`      | Update INSTALL_INSTRUCTIONS, add version check |
| `packages/providers/src/hermes/binary-resolver.test.ts` | Add version parsing test                       |
| `packages/cli/src/commands/setup.ts`                    | Add Python/uv/Node.js advisory checks          |
| `packages/providers/src/hermes/capabilities.ts`         | Add Windows limitation comment                 |

---

## Risks

| Risk                                       | Mitigation                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Minimum Hermes version unknown             | Add TODO comment instead of hardcoding; research upstream releases |
| Setup.ts changes break CLI flow            | Keep checks advisory (non-blocking); test setup command manually   |
| Version parsing fails on unexpected format | Defensive: log warning, don't fail                                 |

---

## Relationship to Main Polish Pass

- **Independent**: No file overlap with main polish pass v2
- **Can run in parallel**: Batches don't touch provider.test.ts, event-bridge.test.ts, etc.
- **Lower priority**: If resource constrained, main polish pass takes precedence
