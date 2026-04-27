# Hermes Provider — Per-Node Model Selection

> Preliminary first draft. Plan for making Hermes provider respect per-node model overrides.

## Preamble

one of the standards of archon is being able to specify which model acts at each node, our hermes for archon code must respect that, this is paramount

---

## Current State

### What already works

The dag-executor correctly resolves the model per node:

```
workflow → provider: hermes, model: (from config)
  node A → provider: hermes (inherited), model: kimi-k2.6 (node override)
  node B → provider: hermes (inherited), model: qwen2.5-coder (node override)
```

`resolveNodeProviderAndModel()` in `dag-executor.ts` (line 344-351):

- `node.model` takes priority over workflow model
- Model flows into `SendQueryOptions.model`

`provider.ts` (line 111-115) — our recent fix:

- When `options.model` is present, sets `HERMES_MODEL` env var
- When `options.model` is absent, Hermes uses its own default

### What fails

`hermes acp` has no `--model` flag. The ACP adapter entry point does not read `HERMES_MODEL` from the environment. So even though we set it, the ACP session uses whatever model Hermes was last configured with — the per-node override is silently ignored.

Evidence:

```
$ hermes acp --help
usage: hermes acp [-h] [--accept-hooks]
options:
  -h, --help      show this help message and exit
  --accept-hooks  Auto-approve unseen shell hooks

No --model flag. No --provider flag.
```

The `hermes chat -m MODEL` path works because it reads `HERMES_INFERENCE_MODEL` env var and applies the override before the conversation loop starts. But `hermes acp` never does this — it just starts the ACP server which uses the configured default model from `config.yaml`.

### What we need

A way to tell `hermes acp`: "for this session, use model X". The per-node model from the workflow YAML must reach the Hermes subprocess and override the default model for that invocation.

---

## Options (to investigate)

### Option A: HERMES_MODEL env var in the subprocess

`hermes_cli/main.py` lines 1048-1049 set both `HERMES_MODEL` and `HERMES_INFERENCE_MODEL` in the child process env for `chat -m`. The ACP adapter path may or may not read these. Need to trace:

1. Does the ACP `initialize` handler read env to override the model?
2. Does the ACP `session/new` handler read env to override the model?
3. Does the agent spawned by ACP read `HERMES_MODEL` / `HERMES_INFERENCE_MODEL`?

If Hermes upstream supports `HERMES_INFERENCE_MODEL` in ACP mode, we just fix our env var name. If not, we need to add support upstream.

### Option B: ACP custom initialize params

The ACP `initialize` request can carry `clientInfo` and `clientCapabilities`. Could we add a model hint to `initialize` params that the ACP adapter respects?

### Option C: Environment variable passthrough

Set `HERMES_INFERENCE_MODEL` alongside `HERMES_MODEL` in the spawn env. The Hermes CLI main entry reads `HERMES_INFERENCE_MODEL` and uses it globally for the subprocess lifecycle.

### Option D: Upstream Hermes fix

Add `--model` flag to `hermes acp` so clients can pass a per-session model override. The ACP adapter would apply it to each session spawned under that ACP server.

---

## Investigation needed

Phase 1 — upstream code trace:

1. Read `hermes_cli/main.py` lines 1040-1055 for how `HERMES_MODEL`/`HERMES_INFERENCE_MODEL` are used
2. Read `acp_adapter/server.py` for how the ACP server picks up the model
3. Trace from `hermes acp` to `run_agent.py` — does env override reach the agent?
4. Verify whether setting `HERMES_INFERENCE_MODEL` in the spawn env would fix it immediately

Phase 2 — if env var works:

- Change `provider.ts` to set `HERMES_INFERENCE_MODEL` instead of (or in addition to) `HERMES_MODEL`
- Add test in `provider.test.ts`: verify that `options.model` is passed via env when spawning

Phase 3 — if upstream change needed:

- Submit PR to Hermes Agent to add `--model` flag to `hermes acp`
- Once merged, update our provider to pass `--model` as a CLI arg
- Fallback: continue using env var until upstream merges

---

## Files to modify

| File                                             | Change                                           |
| ------------------------------------------------ | ------------------------------------------------ |
| `packages/providers/src/hermes/provider.ts`      | Fix modelEnv to use correct env var name         |
| `packages/providers/src/hermes/provider.test.ts` | Add test for model propagation via env           |
| `packages/providers/src/hermes/event-bridge.ts`  | (if needed) pass model hint in initialize params |

---

## Verification gate

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check    # exit 0
bun test packages/providers/src/hermes/       # 172+ pass, 0 fail
bun run lint --filter @archon/providers       # max-warnings 0

# Integration test: run a workflow with node-level model override
hermes-local-review with --model kimi-k2.6
# Verify in hermes logs that kimi-k2.6 was used, not the default
```
