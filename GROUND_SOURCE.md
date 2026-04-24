# GROUND SOURCE — Archon Canonical Repository

> **This is the sole source of truth for the Archon project.**
> Written: 2026-04-24

## Canonical Repository

**Path:** `/home/d/Desktop/Archon-canonical`
**Remote:** `https://github.com/coleam00/Archon.git`
**Branch:** `dev`
**Base commit:** `91226735` (latest upstream dev as of 2026-04-24)

## Deprecated Repositories — DO NOT USE

The following repositories exist on this machine but are **DEPRECATED**. All work has been ported to `Archon-canonical`. These exist only for historical reference:

| Path                                   | Remote                         | Status                                                                                                                             |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/home/d/Desktop/Archon-upstream`      | `coleam00/Archon`              | **DEPRECATED** — stale clone on `feature/hermes-provider` branch. Has Hermes provider (committed) + uncommitted changes with bugs. |
| `/home/d/Desktop/Archon-hermes-bridge` | `someaka/Archon-hermes-bridge` | **DEPRECATED** — fork with Hermes provider (committed) + polish work (uncommitted). All ported to canonical.                       |

## What Was Ported (2026-04-24)

The full Hermes Agent integration was ported from the deprecated repos to canonical:

- **P0:** Hermes Provider Core (15 files, `packages/providers/src/hermes/`)
- **P1:** Config Integration (env overrides, safe fields)
- **P2:** Server Credential Gate (Hermes satisfies boot requirements)
- **P3:** CLI Setup Wizard (collectHermesConfig, binary validation)
- **P4:** Web UI Settings Editor (Hermes model/provider/endpoint inputs)
- **P5:** Workflow Engine Integration (deps.ts, integration + E2E tests)
- **P6:** Documentation (troubleshooting guide, .env.example)
- **P7:** Registry Tests Polish (3rd built-in provider assertions)
- **P8:** Security Fix (hermesBinaryPath removed from safe config)
- **P9:** CLI Setup Tests (generateEnvContent Hermes coverage)
- **P10:** Hermes Example Workflows + Bundle Generator Fix

## Original PR

- **Issue #1106:** Hermes Agent integration (feature request)
- **Issue #1120:** Add Hermes Agent as AI provider option
- **Repository:** `coleam00/Archon`

## Rules

1. **All new work goes to `Archon-canonical`.** Never modify the deprecated repos.
2. **This file is the ground source marker.** If you find yourself working in a different directory, STOP and verify.
3. **Delete the deprecated repos** after confirming canonical is complete and committed.
