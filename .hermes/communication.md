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
| CLAUDE-1 | Claude provider bypasses Ollama gateway — auth fails                        | BLOCKED | Debugger A |
| CLAUDE-2 | e2e-claude-smoke uses `model: haiku` instead of `deepseek-v4-pro:cloud`     | DONE    | Debugger A |
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
- `~/.claude/settings.json` — user's actual config (`model: deepseek-v4-pro:cloud`)
- `~/.ollama/config.json` — Ollama integration config (`claude.models: ["deepseek-v4-pro:cloud"]`)
- `~/.claude.json` — Claude Code state (`additionalModelOptionsCache: []`)

**Finding 1:** The Claude provider spawns the CLI via `@anthropic-ai/claude-agent-sdk` `query()`. The SDK accepts `Options.model` and passes it as `--model` to the CLI binary.

**Finding 2:** Ollama v0.20.6 runs an Anthropic-compatible gateway at `http://localhost:11434/v1/messages`. Verified: `curl -s http://localhost:11434/v1/messages` with `deepseek-v4-pro:cloud` model returns valid responses.

**Finding 3:** The Claude Code binary (v2.1.123) **validates model names against its internal known model list** before making any API call. `deepseek-v4-pro:cloud` is rejected with "There's an issue with the selected model. It may not exist or you may not have access to it." This validation cannot be bypassed via:

- `--model` CLI flag ❌
- `ANTHROPIC_MODEL` env var ❌
- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars ❌
- `--settings` with `model_providers`, `availableModels`, `additionalModelOptionsCache` ❌
- `--bare` mode ❌

**Finding 4:** When `ollama launch claude --model deepseek-v4-pro:cloud` works, Ollama must use a mechanism not available through the SDK — likely modifying `~/.claude.json` `additionalModelOptionsCache` before spawning the binary. Strace shows Ollama does NOT write to settings files before launching Claude.

**Finding 5:** The `~/.claude.json` file has `"additionalModelOptionsCache": []` — this is where Ollama likely registers custom models. The provider cannot safely modify this file (it's the user's personal Claude Code state).

### Fix

**Status:** PARTIALLY_DONE — provider improvements made, but BLOCKED by Claude Code binary model validation

**Changes made (3 commits):**

1. **`c3589977`** — `e2e-claude-smoke.yaml`: `model: haiku` → `model: deepseek-v4-pro:cloud`
2. **`e60a0f6f`** — Added `detectAndConfigureOllamaGateway()`: probes `localhost:11434`, sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` env vars
3. **`b778b01c`** — Added `ANTHROPIC_MODEL` env var fallback in model resolution; skip `--model` flag for Ollama gateway (pass via env var instead)

**Provider model resolution now works as:**

1. `requestOptions.model` (workflow YAML) — highest priority
2. `ANTHROPIC_MODEL` env var (Ollama gateway or user shell)
3. `assistantDefaults.model` (provider config)

**Ollama gateway auto-detection:**

- Checks if `ANTHROPIC_BASE_URL` is not already set
- Checks if `ANTHROPIC_MODEL` has `:` in name (Ollama naming convention)
- Probes `http://localhost:11434/api/version` with 2s timeout
- If detected, sets `ANTHROPIC_BASE_URL=http://localhost:11434/v1` and `ANTHROPIC_AUTH_TOKEN=ollama`

### Verification

**Status:** BLOCKED

**Command:** `bun run cli workflow run e2e-claude-smoke --no-worktree`

**Results:**

- Ollama gateway detected: ✅ (`claude.ollama_gateway_detected` log)
- Model set via env: ✅ (`claude.model_set_via_env_for_ollama` log)
- Model validation: ❌ Claude Code binary rejects `deepseek-v4-pro:cloud`
- Error: "There's an issue with the selected model (deepseek-v4-pro:cloud). It may not exist or you may not have access to it."

**Root cause:** Claude Code binary v2.1.123 has internal model validation that rejects non-Anthropic model names. The `ollama launch claude` command uses a mechanism not available through the SDK (likely writing to `~/.claude.json` `additionalModelOptionsCache`).

**Recommended next steps:**

1. Investigate how Ollama populates `additionalModelOptionsCache` in `~/.claude.json`
2. OR: Add provider-level `~/.claude.json` model registration (with backup/restore)
3. OR: Use Claude SDK's `managedSettings` option to register models
4. OR: Report to Anthropic that the SDK should support custom model providers

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
