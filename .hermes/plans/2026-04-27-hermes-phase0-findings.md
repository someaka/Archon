# Phase 0 — Pre-flight Investigation Findings

Generated: 2026-04-27

## Task 0.1: HERMES_MODEL in ACP mode

**VERDICT: HERMES_MODEL DOES NOT WORK in ACP**

### EVIDENCE

The ACP boot path never reads `HERMES_MODEL` or `HERMES_INFERENCE_MODEL` from
the process environment. The only env-var consumers of these variables are in
`tui_gateway/server.py` (the TUI backend), which is not part of the ACP path.

**Trace through the ACP boot flow:**

1. **`hermes acp`** → `cmd_acp(args)` at `hermes_cli/main.py:9747-9756`
   - Simply calls `acp_adapter.entry.main()` — does not set or forward any env vars.

2. **`acp_adapter/entry.py:main()`** (line 99-122)
   - Calls `_setup_logging()` and `_load_env()` (loads `~/.hermes/.env` for API keys)
   - Creates `HermesACPAgent()` with no model parameter
   - Runs the ACP server

3. **`acp_adapter/server.py:HermesACPAgent.__init__()`** (line 146-149)
   - Creates `SessionManager()` with no model parameter

4. **`acp_adapter/session.py:SessionManager._make_agent()`** (lines 531-595)
   - Reads model from `config.yaml` via `load_config()` (line 548-556)
   - Resolves provider via `resolve_runtime_provider()` (line 576)
   - Constructs `AIAgent(model=model or default_model, ...)` (line 572)
   - **Never calls `os.environ.get('HERMES_MODEL')` or `os.environ.get('HERMES_INFERENCE_MODEL')`**

5. **`hermes_cli/runtime_provider.py`** — zero references to `HERMES_MODEL` or
   `HERMES_INFERENCE_MODEL` (search confirmed 0 matches).

6. **`run_agent.py`** — zero references to `HERMES_INFERENCE_MODEL` or
   `os.environ.*HERMES_MODEL` (search confirmed 0 matches).

7. **`hermes_cli/config.py`** — zero references to `HERMES_MODEL` or
   `HERMES_INFERENCE_MODEL` (search confirmed 0 matches).

**Where HERMES_MODEL IS read (not ACP):**

- `tui_gateway/server.py:565-571` — `_resolve_model()` reads both env vars
  for the TUI backend.
- `hermes_cli/main.py:1071-1073` — `_launch_tui()` sets `HERMES_MODEL` and
  `HERMES_INFERENCE_MODEL` in the child process env when `-m/--model` is passed,
  but only for the TUI launch path.

**How model IS resolved in ACP mode:**

- Default: from `~/.hermes/config.yaml` → `model.default` or `model.provider`
- Per-session override: via ACP `session/new` or `session/set_model` protocol messages
  (server.py lines 500+, `_resolve_model_selection()` at line 232)

### NOTES

- If a user sets `HERMES_MODEL` in their shell environment before running `hermes acp`,
  the env var will be ignored. The model will come from `config.yaml`.
- If a user sets `HERMES_MODEL` in `~/.hermes/.env`, it will be loaded into the process
  environment by `_load_env()`, but still no code reads it for the ACP agent.
- The ACP `session/new` handler in `server.py:379-392` accepts only `cwd` and `mcp_servers`
  from the client — it does not accept a `model` parameter from the client either.
- Model switching in ACP is done via the ACP `set_session_model` message after session creation.
- **Follow-up question:** Should `session.py:_make_agent()` check `os.environ.get('HERMES_MODEL')`
  as a fallback before `config.yaml`? This would allow env-var-based model override consistent
  with the TUI behavior.

## Task 0.2: ACP session/new schema

**VERDICT: session/new DOES NOT accept model**

### ACP_SPEC

The official ACP spec defines `session/new` request params as:

| Field        | Type           | Required | Description                       |
| ------------ | -------------- | -------- | --------------------------------- |
| `_meta`      | object \| null | no       | Reserved metadata (extensibility) |
| `cwd`        | string         | yes      | Working directory (absolute path) |
| `mcpServers` | McpServer[]    | yes      | MCP servers to connect            |

Source: https://agentclientprotocol.com/protocol/session-setup
Source: `acp/schema.py` `NewSessionRequest` class (line 1645-1670)

There is **no `model` field** in `NewSessionRequest`.

Model selection is handled by a **separate ACP method**: `session/set_model`
(`SetSessionModelRequest` at schema.py line 931-950), which takes:

- `modelId` (string, required) — the model ID to set
- `sessionId` (string, required) — the session to update

### EVIDENCE

**1. Python SDK `NewSessionRequest` (acp/schema.py:1645-1670):**

```python
class NewSessionRequest(BaseModel):
    field_meta: Optional[Dict[str, Any]] = None   # _meta
    cwd: str                                        # required
    mcp_servers: List[Union[HttpMcpServer, SseMcpServer, McpServerStdio]]  # mcpServers
```

No `model` field. Only `cwd` and `mcpServers`.

**2. Hermes Agent server.py `new_session()` handler (lines 379-392):**

```python
async def new_session(
    self,
    cwd: str,
    mcp_servers: list | None = None,
    **kwargs: Any,                    # <-- model would land here if sent, but ignored
) -> NewSessionResponse:
    state = self.session_manager.create_session(cwd=cwd)
    ...
    return NewSessionResponse(
        session_id=state.session_id,
        models=self._build_model_state(state),  # model info is in RESPONSE, not request
    )
```

The handler reads only `cwd` and `mcp_servers`. Any extra params (including a
hypothetical `model`) would be silently captured by `**kwargs` and ignored.

**3. SessionManager.create_session() (session.py:174-192):**

```python
def create_session(self, cwd: str = ".") -> SessionState:
    ...
    agent = self._make_agent(session_id=session_id, cwd=cwd)  # no model param
    state = SessionState(
        session_id=session_id,
        agent=agent,
        cwd=cwd,
        model=getattr(agent, "model", "") or "",  # model comes FROM the agent
        ...
    )
```

Model is populated from the agent's default (which comes from `config.yaml`).

**4. SessionManager.\_make_agent() (session.py:531-595):**

```python
def _make_agent(self, *, session_id, cwd, model=None, ...):
    ...
    kwargs = {
        "model": model or default_model,  # model param only used by fork/restore
        ...
    }
    agent = AIAgent(**kwargs)
```

The `model` kwarg in `_make_agent` is only used when forking or restoring a
session (carrying over the previous model). On initial `create_session()`,
it's called without `model=`, so it falls through to `default_model` from
config.yaml.

**5. Archon event-bridge.ts (lines 386-393):**

```typescript
const sessionReq = createRequest(
  ACP_METHODS.sessionNew,
  {
    cwd: options.cwd,
    mcpServers: [], // no model field sent
  },
  idGen
);
```

Archon sends only `cwd` and `mcpServers`. No model parameter.

**6. ACP `session/set_model` — the correct way to set model (server.py:849-869):**

```python
async def set_session_model(
    self, model_id: str, session_id: str, **kwargs: Any
) -> SetSessionModelResponse | None:
    state = self.session_manager.get_session(session_id)
    if state:
        requested_provider, resolved_model = self._resolve_model_selection(
            model_id, current_provider or "openrouter"
        )
        state.model = resolved_model
        state.agent = self.session_manager._make_agent(
            session_id=session_id, cwd=state.cwd,
            model=resolved_model, requested_provider=requested_provider, ...
        )
```

This is the ACP-protocol way to change model after session creation.

**7. NewSessionResponse (schema.py:2848-2898) — model info flows BACK to client:**

```python
class NewSessionResponse(BaseModel):
    session_id: str                                          # required
    models: Optional[SessionModelState] = None               # UNSTABLE — agent reports available models
    modes: Optional[SessionModeState] = None
    config_options: Optional[List[...]] = None
```

The `models` field in the RESPONSE is how the agent tells the client what
models are available and which is current. This is UNSTABLE/experimental.

### FLOW SUMMARY

```
Client                           Agent (Hermes)
  |                                |
  |-- session/new {cwd, mcpServers} -->
  |                                |  create_session(cwd) → AIAgent(model=config_default)
  |                                |  _build_model_state(state) → SessionModelState
  |<-- {sessionId, models: {...}} -|
  |                                |
  |  (optional, later)             |
  |-- session/set_model {modelId, sessionId} -->
  |                                |  _resolve_model_selection() → new agent with model
  |<-- SetSessionModelResponse ----|
```

### IMPLICATIONS FOR ARCHON

- To pass a model at session creation time, Archon **cannot** use `session/new`
  — the ACP spec and Hermes implementation don't accept it.
- Options:
  1. **Send `session/set_model` immediately after `session/new`** — two round-trips,
     but spec-compliant.
  2. **Use `_meta` extensibility** — pass `{_meta: {model: "..."}}` in `session/new`
     and have Hermes check for it. Spec-compliant but requires Hermes-side change.
  3. **Rely on config.yaml** — set model in `~/.hermes/config.yaml` before starting
     the ACP session. Zero code changes, but no per-session override.
- The `models` field in `NewSessionResponse` is UNSTABLE (not part of the spec yet).
  Archon can read it to know what model is active, but shouldn't depend on it.

## Task 0.3: Config.yaml precedence and HERMES_HOME

**VERDICT: Option E VIABLE — HERMES_HOME redirect is a supported, production-grade mechanism**

### PRECEDENCE

Documented precedence (highest → lowest):

1. **CLI arguments** — e.g. `hermes chat --model X` (per-invocation)
2. **`~/.hermes/config.yaml`** — primary config for non-secret settings
3. **`~/.hermes/.env`** — API keys and secrets; also fallback for env vars
4. **Built-in defaults** — hardcoded in `cli.py:load_cli_config()` and `hermes_cli/config.py:DEFAULT_CONFIG`

Source: https://hermes-agent.nousresearch.com/docs/user-guide/configuration#configuration-precedence
Source: `cli.py:300-308` ("Environment variables take precedence over config file values" —
this docstring is misleading; the actual code shows config.yaml wins for non-secret settings,
matching the official docs.)

**Two separate config loaders exist:**

- `cli.py:load_cli_config()` — used by the interactive CLI (`hermes chat`)
- `hermes_cli/config.py:load_config()` — used by the ACP adapter, gateway, and all non-interactive paths

Both respect `HERMES_HOME` via `hermes_constants.py:get_hermes_home()`.

### HERMES_HOME

**EXISTS AND WORKS.** This is a first-class, production-supported mechanism.

`hermes_constants.py:get_hermes_home()` (line 11-17):

```python
def get_hermes_home() -> Path:
    val = os.environ.get("HERMES_HOME", "").strip()
    return Path(val) if val else Path.home() / ".hermes"
```

Every path resolution in Hermes flows through this function:

- `get_config_path()` → `get_hermes_home() / "config.yaml"`
- `get_env_path()` → `get_hermes_home() / ".env"`
- `get_skills_dir()` → `get_hermes_home() / "skills"`
- Logs, sessions, memories, state.db — all under `get_hermes_home()`

**Profiles feature uses the exact same mechanism:** `~/.hermes/profiles/<name>`
is a complete HERMES_HOME directory that gets activated by setting `HERMES_HOME`
to that path. This is documented behavior, not a hack.

### MECHANISM: How to implement Option E

**Exact steps to create a per-session HERMES_HOME with a custom model:**

```bash
# 1. Create temp directory
SESSION_DIR=$(mktemp -d /tmp/hermes-session-XXXXXX)

# 2. Write minimal config.yaml with desired model
cat > "$SESSION_DIR/config.yaml" << 'EOF'
model: "anthropic/claude-sonnet-4"
EOF

# 3. Symlink .env from real HERMES_HOME (for API keys)
ln -s ~/.hermes/.env "$SESSION_DIR/.env"

# 4. Set HERMES_HOME and spawn hermes acp
HERMES_HOME="$SESSION_DIR" hermes acp
```

**What `ensure_hermes_home()` auto-creates (hermes_cli/config.py:300-321):**

- `$HERMES_HOME/cron/`
- `$HERMES_HOME/sessions/`
- `$HERMES_HOME/logs/`
- `$HERMES_HOME/memories/`
- `$HERMES_HOME/SOUL.md` (default content)

These are created on first access — no need to pre-populate them.

**What MUST be present:**

- `config.yaml` — with `model:` key (string or dict format both work)
- `.env` — symlink to real `.env` for API keys (or copy, but symlink is safer)

**What is auto-created / optional:**

- `state.db` — created per-session (sessions don't persist, which is fine)
- `SOUL.md` — auto-generated with default content
- All subdirectories (`cron/`, `sessions/`, `logs/`, `memories/`)

**Archon integration point:** `session-resolver.ts:resolveHermesSession()` already
merges `process.env` with caller-provided env overrides. Adding `HERMES_HOME` to
the env override is trivial:

```typescript
// In resolveHermesSession or the caller:
env.HERMES_HOME = sessionDir; // temp dir with custom config.yaml
```

**config.yaml supports both formats:**

```yaml
# String format (new):
model: "anthropic/claude-sonnet-4"

# Dict format (old, more control):
model:
  default: "anthropic/claude-sonnet-4"
  provider: anthropic
  base_url: ""
```

**Environment variable substitution** works in config.yaml:

```yaml
model: ${HERMES_INFERENCE_MODEL}
```

This means we could also just set a shell env var and use substitution,
but the HERMES_HOME approach is cleaner for per-session isolation.

### RISKS

1. **Missing .env = no API keys.** If symlink is broken or .env doesn't exist,
   the agent will have no credentials. Mitigation: symlink, not copy.

2. **SOUL.md gets auto-generated.** Each temp session gets a fresh default
   SOUL.md. This is acceptable for per-node model selection but means custom
   SOUL.md content won't carry over unless symlinked too.

3. **state.db is isolated.** Each temp HERMES_HOME gets its own state.db.
   Sessions won't persist across restarts. This is fine for Archon's use case
   (Archon holds conversation history, not Hermes).

4. **No shared skills directory.** Skills in `~/.hermes/skills/` won't be
   available. Mitigation: symlink the skills directory too:
   `ln -s ~/.hermes/skills "$SESSION_DIR/skills"`

5. **Race condition on cleanup.** If multiple sessions share the same temp
   dir pattern, cleanup must be per-session. Using `mktemp -d` handles this.

6. **Config.yaml `${VAR}` expansion** depends on env vars being set. If
   config.yaml references `${OPENROUTER_API_KEY}`, it resolves from the
   process environment (which inherits from the real .env via dotenv loading).
   With symlinked .env, this works correctly.

7. **`auth.json` not in temp dir.** OAuth credentials (Nous Portal, etc.)
   live in `~/.hermes/auth.json`. If the model requires OAuth auth, the
   temp dir needs a symlink. Mitigation: `ln -s ~/.hermes/auth.json "$SESSION_DIR/"`

8. **Model validation happens at ACP session creation time**, not at config
   load time. An invalid model in config.yaml won't error until the first
   prompt is sent.

---

## DECISION

**DECISION: Option E — HERMES_HOME redirect with temp config.yaml**

### Justification

All three investigation tasks converge on Option E as the best path:

1. **Task 0.1** confirmed HERMES_MODEL env var is DEAD in ACP mode — the boot path
   never reads it. Option A is eliminated.

2. **Task 0.2** confirmed session/new does NOT accept model. The ACP spec defines
   session/set_model as a separate method (2 round-trips). Option B (pass model in
   session/new) is eliminated. session/set_model is viable but costs an extra round-trip.

3. **Task 0.3** confirmed HERMES_HOME is a first-class production mechanism used by
   Hermes's own profiles feature. config.yaml takes precedence over env vars. The
   temp dir needs: config.yaml + .env symlink + optional skills symlink.

### Implementation path

- Create temp HERMES_HOME directory per sendQuery() call
- Write config.yaml with `model: <options.model>`
- Symlink ~/.hermes/.env for API keys
- Symlink ~/.hermes/skills for skill access
- Set HERMES_HOME in spawn env
- Clean up temp dir on process exit

### Fallback

If HERMES_HOME approach has unexpected issues, fall back to session/set_model
(ACP method after session/new, 2 round-trips, spec-compliant).

### COMPARISON WITH ALTERNATIVES

| Approach                            | Round-trips | Spec-compliant   | Per-session model |
| ----------------------------------- | ----------- | ---------------- | ----------------- |
| Option E: HERMES_HOME redirect      | 0 (pre-set) | Yes              | Yes               |
| session/set_model after session/new | 2           | Yes              | Yes               |
| \_meta extensibility in session/new | 1           | Yes (extensible) | Yes               |
| Config mutation (race-prone)        | 0           | Yes              | No (global)       |

**Option E is the winner for per-session model selection** because:

- Zero additional round-trips (model is set before ACP starts)
- Full isolation (no global state mutation)
- Uses Hermes's own profiles infrastructure
- No Hermes code changes required
