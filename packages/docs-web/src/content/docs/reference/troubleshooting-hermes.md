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
