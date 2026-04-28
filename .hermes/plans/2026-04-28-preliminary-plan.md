# Preliminary Plan — Hermes Provider Fixes

> Date: 2026-04-28
> Status: PRELIMINARY — dispatch to 3 planners

---

## Context

Hermes is currently using mimo-v2.5-pro via xiaomi provider (from ~/.hermes/config.yaml).
But Archon's config.yaml overrides to kimi-k2.6 via opencode-go. This override is the
source of the timeout — kimi-k2.6 is a reasoning model that enters extended thinking,
and the opencode-go proxy has reliability issues (404s, 429s).

The correct behavior: when a workflow does NOT specify a model, Archon should use whatever
Hermes is currently configured with — not override it from Archon's own config.

---

## Issue 1: event-bridge.ts Generator Architecture (CRITICAL)

### Problem

The `bridgeHermesSession` generator in event-bridge.ts does NOT yield intermediate events
until `session/prompt` COMPLETES. Tool calls are queued but blocked until prompt done.
The "first event timeout" degenerates into "full prompt completion timeout."

### Root Cause

event-bridge.ts flow:

1. await initialize
2. await session/new
3. await session/prompt ← BLOCKS until fully done
4. push terminal result to queue
5. push 'done' to queue
6. NOW enter consumer loop and yield from queue

Step 3 blocks for the entire model inference. During this time, session/update notifications
(tool calls, text deltas) are pushed to the queue by the stdout handler, but the generator
can't yield them because it's stuck awaiting the prompt response.

### Fix Direction

The generator must yield from the queue DURING prompt processing, not after. The ACP
protocol sends session/update notifications asynchronously — the generator should consume
them as they arrive, not wait for the prompt to complete.

### Files

- packages/providers/src/hermes/event-bridge.ts (bridgeHermesSession function)
- packages/providers/src/hermes/timeout-utils.ts (withFirstEventTimeout)

### Verification Gate

- Test that tool_call_update events are yielded BEFORE session/prompt completes
- Test that first-event timeout correctly measures time-to-first-yield, not total prompt time

---

## Issue 2: Hermes Config Discovery (CRITICAL)

### Problem

When a workflow uses `provider: hermes` without specifying a model, Archon uses its own
config.yaml override (kimi-k2.6 via opencode-go) instead of asking Hermes what it's
currently using (mimo-v2.5-pro via xiaomi).

### What Should Happen

1. **No model specified in workflow**: Ask Hermes for its current model/provider.
   - Option A: Run `hermes config get model` to read from ~/.hermes/config.yaml
   - Option B: Read ~/.hermes/config.yaml directly (faster, no subprocess)
   - Use whatever Hermes has configured — DO NOT override from Archon config
2. **Model specified in workflow**: Validate it against Hermes's available providers.
   - Read ~/.hermes/config.yaml to get list of configured providers
   - Check the model is reachable via the specified provider
   - Warn if the model/provider combination looks wrong

### What Needs to Change

- provider.ts: When no assistantConfig.model, read from hermes config instead of Archon defaults
- Or: Remove the Archon config override for hermes model — let hermes config be authoritative
- The temp HERMES_HOME creation should only happen when WORKFLOW explicitly specifies a model

### Files

- packages/providers/src/hermes/provider.ts (temp HERMES_HOME creation)
- packages/providers/src/hermes/config.ts (parseHermesConfig)
- packages/workflows/src/dag-executor.ts (assistantConfig resolution)

### Verification Gate

- When workflow has no model, hermes provider reads from ~/.hermes/config.yaml
- When workflow specifies model, temp HERMES_HOME is created with that model
- No silent override from Archon's assistants.hermes config

---

## Issue 3: Workflow Setup Node (HIGH)

### Problem

hermes-pr-verifier.yaml goes straight from scope → validation gates. No bun install step.
Worktrees don't have node_modules. All validation gates fail.

### Reference Pattern

archon-piv-loop.yaml and archon-ralph-dag.yaml have setup nodes:

```yaml
- id: setup
  bash: |
    if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
      bun install --frozen-lockfile 2>&1 | tail -3
    fi
  depends_on: [scope]
  timeout: 300000
```

### Fix

Add setup node to hermes-pr-verifier.yaml. Update type-check, lint-check, test-gates
to depend on both scope and setup.

### Files

- .archon/workflows/hermes-pr-verifier.yaml

### Verification Gate

- Workflow runs type-check, lint, tests successfully in worktree

---

## Issue 4: Review Agents Timeout Investigation (REASSESSED)

### Previous Claim: "opencode-go proxy is flaky"

### Correct Assessment: Investigators did not trace the full resolution chain

The actual model is mimo-v2.5-pro via xiaomi (from hermes config), but Archon overrides
to kimi-k2.6 via opencode-go. The timeout is NOT proxy flakiness — it's:

1. Wrong model being used (reasoning model vs non-reasoning)
2. Generator architecture blocking intermediate events
3. Both compounding: model takes >60s to think, generator can't yield tool calls

### Fix

Once Issues 1 and 2 are fixed, this resolves automatically:

- Correct model (mimo-v2.5-pro) has faster first-token latency
- Generator yields tool calls during processing, not after
- First-event timeout correctly measures time-to-first-chunk

---

## Dispatch Plan

### Planner A — event-bridge.ts Generator Fix

Scope: event-bridge.ts, timeout-utils.ts
Focus: Make generator yield intermediate events during prompt processing
Context: ACP protocol flow, session/update notifications, queue mechanism

### Planner B — Hermes Config Discovery

Scope: provider.ts, config.ts, dag-executor.ts
Focus: When no model specified, read from hermes config. When specified, validate.
Context: ~/.hermes/config.yaml structure, temp HERMES_HOME creation, assistantConfig flow

### Planner C — Workflow Setup Node + Model Validation

Scope: hermes-pr-verifier.yaml, other hermes workflows
Focus: Add bun install step, ensure workflows specify model or defer to hermes config
Context: archon-piv-loop setup node pattern, worktree creation behavior
