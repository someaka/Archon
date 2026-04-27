---
title: Troubleshooting Hermes
description: Common Hermes Agent issues and fixes.
category: reference
area: server
audience: [user]
status: current
sidebar:
  order: 5
---

## Hermes not found

**Symptom:** `Error: spawn hermes ENOENT`

**Fix:**
1. Verify Hermes is installed: `hermes --help`
2. If using a compiled Archon binary, set `HERMES_BINARY_PATH`:
   ```ini
   HERMES_BINARY_PATH=/absolute/path/to/hermes
   ```
3. Or set it in `~/.archon/config.yaml`:
   ```yaml
   assistants:
     hermes:
       hermesBinaryPath: /absolute/path/to/hermes
   ```

## Model not available

**Symptom:** Hermes returns `error: Model not available`

**Fix:**
- **Ollama:** Ensure Ollama is running (`ollama serve`) and the model is pulled (`ollama pull qwen2.5-coder:32b`).
- **OpenRouter:** Verify your `OPENROUTER_API_KEY` is set.
- **OpenAI:** Verify your `OPENAI_API_KEY` is set.

## Connection refused to Ollama

**Symptom:** `error: connect ECONNREFUSED 127.0.0.1:11434`

**Fix:**
```bash
ollama serve
# In another terminal:
ollama pull qwen2.5-coder:32b
```

## Hermes hangs or times out

**Symptom:** Workflow node stays in `running` state indefinitely.

**Fix:**
- Check if the model is too large for your hardware. Try a smaller model (e.g., `qwen2.5-coder:14b`).
- Increase the workflow idle timeout in `.archon/config.yaml`:
  ```yaml
  idleTimeout: 300000  # 5 minutes
  ```

## Provider switching not working

**Symptom:** A node with `provider: hermes` still uses Claude.

**Fix:**
- Verify the workflow YAML syntax:
  ```yaml
  nodes:
    - id: my-node
      provider: hermes
      model: qwen2.5-coder:32b
      prompt: "..."
  ```
- Check that `hermes` is a registered provider: `bun run cli provider list` should show Hermes.

## Binary path validation fails during setup

**Symptom:** `Hermes binary not found at: /path/to/hermes`

**Fix:**
- Provide the absolute path (not relative).
- Ensure the file is executable: `chmod +x /path/to/hermes`.
- Leave the field blank to use PATH lookup instead.

## auth.json not found in per-node model override

**Symptom:** When using per-node model override with a provider that requires OAuth, authentication fails.

**Fix:** The temp HERMES_HOME symlinks auth.json from ~/.hermes/auth.json. Ensure ~/.hermes/auth.json exists. Run `hermes login` to create it.

## HERMES_HOME temp directory issues

**Symptom:** Per-node model override silently falls back to default model.

**Fix:** The temp HERMES_HOME approach is fragile. Ensure ~/.hermes exists with .env, auth.json, and skills/. Check symlink targets with `ls -la /tmp/hermes-*/`.

## HERMES_USE_GLOBAL_AUTH not working

**Symptom:** Set HERMES_USE_GLOBAL_AUTH=true but still getting auth errors.

**Fix:** This env var must be set in the .archon/.env file or system environment, not in ~/.hermes/.env. Verify with `echo $HERMES_USE_GLOBAL_AUTH`.

## Tool events not appearing in workflow logs

**Symptom:** Workflow runs but no tool call information shown.

**Fix:** Hermes sends ACP tool_call_update events. Ensure you're using Archon v0.x.x+ which supports these events. Check that the event-bridge is parsing them.

## OpenRouter rate limiting

**Symptom:** Frequent 429 errors from OpenRouter.

**Fix:** OpenRouter has rate limits per API key. Use a paid plan for higher limits. Add retry logic in your workflow.

## Model format mismatch

**Symptom:** Model not found or provider mismatch errors.

**Fix:** For Ollama, use format `model-name:tag` (e.g., qwen2.5-coder:32b). For OpenRouter, use `openrouter/provider/model` (e.g., openrouter/google/gemini-2.5-flash).

## Session timeout for slow models

**Symptom:** Workflow times out waiting for response from large local models.

**Fix:** Large models (70B+) on consumer hardware may take 2-5 minutes. The default timeout is 5 minutes. For slower hardware, contact support for timeout configuration.
