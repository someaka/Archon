# DEBUGGER COMMUNICATION LOG

> This file is the coordination hub for parallel debuggers. Each debugger reads this file first, appends their findings, writes their fix status, and investigates their own fix. The file persists as proof of work done.

---

## CURRENT STATE (updated by orchestrator)

**Repo:** `/home/d/Desktop/Archon-canonical`
**Branch:** `dev`
**Date:** 2026-04-30

### Active Issues

| ID       | Issue                                                                       | Status  | Assigned   |
| -------- | --------------------------------------------------------------------------- | ------- | ---------- |
| CLAUDE-1 | Claude provider bypasses Ollama gateway — auth fails                        | OPEN    | Debugger A |
| CLAUDE-2 | e2e-claude-smoke uses `model: haiku` instead of `deepseek-v3-pro:cloud`     | OPEN    | Debugger A |
| PI-1     | e2e-pi-smoke uses `anthropic/claude-haiku-4-5` — wrong model for this setup | DONE    | Debugger B |
| PI-2     | Pi auth.json empty — needs API key for the correct provider                 | DONE    | Debugger B |
| VERIFY   | Re-run all 3 e2e smoke tests after fixes                                    | PENDING | Debugger C |

### User's Actual Setup (DO NOT IGNORE)

- **Claude Code**: Launched via `ollama launch claude --model deepseek-v3-pro:cloud` (custom Ollama v0.20.6 gateway)
- **Ollama gateway**: Handles auth (`ANTHROPIC_AUTH_TOKEN=ollama`), translates Anthropic API → DeepSeek cloud
- **Config**: `~/.claude/settings.json` has `model: deepseek-v3-pro:cloud`
- **Env vars**: `ANTHROPIC_MODEL=deepseek-v3-pro:cloud`, `CLAUDE_CODE_EFFORT_LEVEL=max`
- **Pi**: Uses `opencode-go/kimi-k2.6` (NOT anthropic models)
- **Hermes**: Uses `mimo-v2.5-pro` via xiaomi endpoint — WORKS FINE
- **NO Anthropic products** — never assume API keys, subscriptions, or claude.ai auth

### Already Fixed This Session (commits on dev)

| Commit          | Fix                                                                   |
| --------------- | --------------------------------------------------------------------- |
| `92a5f93e`      | Pi: surface `errorMessage` from SDK in result chunk                   |
| binary-resolver | Dev mode: remove early return so env vars + autodetect work           |
| `cf425ee5`      | Test: update binary-resolver test for dev-mode autodetect             |
| `d87b2b31`      | Claude: don't treat `stop_sequence` with `subtype:'success'` as error |
| dag-executor    | Handle thinking chunks for stagger gate signaling                     |

---

## DEBUGGER A — Claude Provider + Ollama Integration

### Investigation

**Started:** 2026-04-30 01:55 UTC

Reading files:

- `packages/providers/src/claude/provider.ts` — how CLI is spawned
- `packages/providers/src/claude/config.ts` — config options
- `packages/providers/src/claude/options-translator.ts` — CLI args
- `~/.claude/settings.json` — user's actual config
- `~/.ollama/config.json` — Ollama integration config

**Finding 1:** The Claude provider spawns the CLI via `@anthropic-ai/claude-agent-sdk` `query()`. The SDK accepts `Options.model` and passes it as `--model` to the CLI binary. No Ollama gateway routing.

**Finding 2:** When `ollama launch claude` is used, Ollama sets env vars (`ANTHROPIC_MODEL`, `ANTHROPIC_AUTH_TOKEN=ollama`) and launches the CLI. The CLI reads these and routes through Ollama's gateway. When Archon spawns directly, these env vars are NOT set.

**Finding 3:** The fix needs to either:

- (a) Set `ANTHROPIC_MODEL` and `ANTHROPIC_AUTH_TOKEN` env vars before spawning, OR
- (b) Pass `model: deepseek-v3-pro:cloud` via the workflow YAML, OR
- (c) Read `~/.claude/settings.json` to pick up the user's model config

### Fix

**Status:** IN_PROGRESS

<!-- Debugger A: write your fix details here -->

### Verification

**Status:** PENDING

<!-- Debugger A: write verification results here after fix -->

---

## DEBUGGER B — Pi Provider Smoke Test

### Investigation

**Started:** 2026-04-30 01:55 UTC

Reading files:

- `.archon/workflows/test-workflows/e2e-pi-smoke.yaml` — workflow definition
- `packages/providers/src/community/pi/provider.ts` — model resolution
- `~/.pi/agent/auth.json` — Pi auth state

**Finding 1:** `e2e-pi-smoke.yaml` hardcodes `model: anthropic/claude-haiku-4-5`. This requires `ANTHROPIC_API_KEY` which is not set. The user uses `opencode-go/kimi-k2.6` for Pi.

**Finding 2:** `~/.pi/agent/auth.json` is `{}` (empty). No stored credentials.

**Finding 3:** The Pi provider resolves model from: `requestOptions.model ?? piConfig.model`. The workflow YAML sets it directly.

### Fix

**Status:** DONE

**Fix:** Changed `model: anthropic/claude-haiku-4-5` → `model: opencode-go/kimi-k2.6` in `.archon/workflows/test-workflows/e2e-pi-smoke.yaml`.

**Why it works:** The Pi provider maps `opencode-go` → `OPENCODE_API_KEY` env var (line 89 of `provider.ts`). The key was already set in the environment. No auth.json changes needed — the env var override (`setRuntimeApiKey`) takes precedence.

**Commit:** `1b81283e` — `fix(e2e-pi-smoke): use opencode-go/kimi-k2.6 instead of anthropic/claude-haiku-4-5`

**Non-blocking note:** Pi logs `pi.extensions_reload_failed` ("paths[0] must be type string") when extensions are enabled with the shim resource loader. This is cosmetic — the smoke test doesn't need extensions.

### Verification

**Status:** DONE

**Command:** `bun run cli workflow run e2e-pi-smoke --no-worktree`

**Results:**

- Exit code: 0 ✅
- Model used: `opencode-go/kimi-k2.6` ✅
- Model response: `4` (correct answer to "What is 2+2?") ✅
- Assert node: `PASS: simple='4'` ✅
- Duration: 3.9s (simple node) ✅
- Workflow completed successfully ✅

---

## DEBUGGER C — End-to-End Verification

### Investigation

**Status:** PENDING — waits for Debugger A and B to complete

<!-- Debugger C: run all 3 e2e smoke tests after fixes, report results -->

### Verification

**Status:** PENDING

---

## APPENDIX: How to Use This File

1. **Read this file first** when starting
2. **Append your findings** under your section (don't overwrite others)
3. **Update your Status** fields: OPEN → IN_PROGRESS → DONE
4. **After fixing**, run your verification and write results
5. **If your fix reveals new issues**, add them to the Active Issues table
6. **Never delete** other debugger's entries — only append

### Status Values

- `OPEN` — not started
- `IN_PROGRESS` — actively working
- `DONE` — completed and verified
- `BLOCKED` — needs input from another debugger or orchestrator
