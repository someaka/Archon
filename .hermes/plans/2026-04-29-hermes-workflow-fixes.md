# Master Execution Plan — 4 Bug Fixes for Hermes Workflow Integration

> Date: 2026-04-29
> Branch: dev (clean working tree)
> Methodology: executor-verifier-loop (phased, batched, gated)
> Prerequisites: All prior Hermes provider fixes (ConcurrencyLock, HermesAcpClient, handler cleanup, monotonic IDs, pool acquire/release) are COMMITTED

---

## Executive Summary

Four bugs degrade Hermes workflow reliability. Two are Archon-side TypeScript
provider/workflow issues (Bug 1: session pool ignores `context: fresh`, Bug 2:
compression model misroute). Two are Hermes CLI Python issues (Bug 3: context
probe tiers cap at 256K, Bug 4: token estimation overcounts). Bugs 1-2 are
independent of each other and of Bugs 3-4. Bugs 3-4 share a file
(`model_metadata.py`) and should be sequential.

**Critical path**: Bug 1 (blocks accurate session management) → Bug 2 (config)
→ Bugs 3+4 (Python utility fixes) → Final validation.

---

## Bug Inventory

### Bug 1: Session Pool Ignores `context: fresh` (ARCHON — TypeScript)

**Severity**: P0 — Silent correctness violation. Parallel nodes and explicit
`context: fresh` nodes incorrectly reuse pooled sessions.

**Root Cause Chain**:

1. dag-executor.ts:2842-2843 correctly sets `isFresh = true` and `resumeSessionId = undefined`
2. `undefined` resumeSessionId is passed to `provider.sendQuery()`
3. provider.ts:243 calls `pool.acquire(session.cwd, model, config.provider)`
4. Pool returns existing session for same cwd+model+provider — **ignoring fresh intent**
5. The pooled session continues the old conversation instead of starting new

**Key Insight**: `resumeSessionId === undefined` is ambiguous — it means both
"no prior session" and "explicitly fresh (discard prior session)". The provider
needs an explicit signal to bypass pool lookup.

**Files**:

- `packages/providers/src/types.ts` — Add `freshSession?: boolean` to SendQueryOptions
- `packages/providers/src/hermes/provider.ts:243` — Skip pool.acquire when freshSession=true
- `packages/workflows/src/dag-executor.ts:691-694` — Pass freshSession:true when isFresh

**Evidence**:

```
dag-executor.ts:2842  const isFresh = isParallelLayer || node.context === 'fresh';
dag-executor.ts:2843  const resumeSessionId = isFresh ? undefined : lastSequentialSessionId;
provider.ts:243       const pooled = this.pool.acquire(session.cwd, model, config.provider);
session-pool.ts:37    private makeKey(cwd, model, provider) // no fresh dimension
```

---

### Bug 2: Compression Model Uses Wrong Endpoint (HERMES CONFIG)

**Severity**: P1 — Auxiliary operations (compression, context management) route
to wrong provider, causing failures or degraded quality.

**Root Cause Chain**:

1. `~/.hermes/config.yaml` sets:
   ```yaml
   auxiliary:
     compression:
       provider: auto
       model: google/gemini-3-flash-preview
   ```
2. `provider: auto` resolves to the default model's provider (xiaomi, from top-level config)
3. `google/gemini-3-flash-preview` is sent to `https://token-plan-ams.xiaomimimo.com/v1`
4. Xiaomi endpoint doesn't know this model → 404 or wrong model served

**Fix**: Either:

- (A) Set `auxiliary.compression.provider: google` explicitly in config.yaml
- (B) Fix the `auto` resolution in Hermes CLI to detect provider from model prefix

Option A is a config-only fix (immediate). Option B is an upstream Hermes CLI
fix (requires hermes-agent code change). **Do both**: A as immediate fix, B as
upstream contribution.

**Files**:

- `~/.hermes/config.yaml` — Set `auxiliary.compression.provider: google`
- `~/.hermes/hermes-agent/` — (upstream) auto-detect provider from model prefix

---

### Bug 3: Context Probe Tiers Cap at 256K (HERMES CLI — Python)

**Severity**: P1 — Models supporting 1M+ tokens are capped at 256K when
context length metadata isn't available through other resolution paths.

**Root Cause**:

```python
# model_metadata.py:116-123
CONTEXT_PROBE_TIERS = [
    256_000,   # ← Maximum tier. 1M models never see their full context.
    128_000,
    64_000,
    32_000,
    16_000,
    8_000,
]
DEFAULT_FALLBACK_CONTEXT = CONTEXT_PROBE_TIERS[0]  # 256K
```

When `get_model_context_length()` exhausts all resolution paths (cache, endpoint
metadata, models.dev, OpenRouter, Anthropic API, hardcoded defaults), it falls
back to probing. The probe starts at 256K and steps DOWN. Models like
`mimo-v2.5-pro` or `claude-opus-4.6` (1M context) are effectively capped.

**Note**: The `get_model_context_length()` function has a multi-step resolution
chain (13 steps) that should catch most known models before reaching the probe
fallback. The real issue is that `DEFAULT_FALLBACK_CONTEXT = 256K` is too low
for modern 1M-context models.

**Fix**: Add 512K and 1M tiers to CONTEXT_PROBE_TIERS. Raise
DEFAULT_FALLBACK_CONTEXT to 1M.

**Files**:

- `~/.hermes/hermes-agent/agent/model_metadata.py:116-126` — Add tiers, raise default

---

### Bug 4: Token Estimation Overcounts (HERMES CLI — Python)

**Severity**: P2 — Rough token estimates are systematically too high, causing
premature context compression and wasted context budget.

**Root Cause**:

```python
# model_metadata.py:1446-1449
def estimate_messages_tokens_rough(messages):
    total_chars = sum(len(str(msg)) for msg in messages)
    return (total_chars + 3) // 4
```

`str(msg)` on a dict produces Python repr including `{'role': 'user', 'content': 'hello'}`
which is 37 characters for ~7 tokens of actual content. The overhead from dict
syntax, key names, quotes, and whitespace inflates the estimate by 2-4x.

**Evidence**: A message `{"role": "user", "content": "hello world"}` has:

- `len(str(dict))` = 42 chars → 11 tokens (estimate)
- Actual tokens: ~2-3 tokens
- Overcount ratio: ~4x

**Fix**: Extract only the content values, strip structural overhead. Two approaches:

- (A) Only count `msg.get("content", "")` + `msg.get("tool_result", "")` string lengths
- (B) Use tiktoken for accurate counting (heavier dependency)

Option A is pragmatic and dependency-free. Option B is accurate but adds import overhead.

**Files**:

- `~/.hermes/hermes-agent/agent/model_metadata.py:1446-1449` — Fix estimation
- `~/.hermes/hermes-agent/agent/model_metadata.py:1452-1472` — Fix request estimation

---

## Dependency Graph

```
Bug 1 (Archon TS) ──┐
                     ├──→ Final Validation
Bug 2 (Hermes config)┤
                     │
Bug 3 (Python) ──────┤
     │               │
     └──→ Bug 4 ─────┘
```

- **Bug 1** and **Bug 2** are fully independent — can be executed in parallel
- **Bug 3** and **Bug 4** share `model_metadata.py` — must be sequential (Bug 3 first, then Bug 4)
- All 4 bugs are independent of each other at the code level — no cross-bug file dependencies
- All 4 must be fixed before re-running `hermes-pr-verifier` workflow

---

## Phase 1: Bug 1 — Session Pool Ignores `context: fresh`

### Scope

Archon TypeScript provider layer. 3 files, ~15 lines changed.

### Task 1.1: Add `freshSession` to SendQueryOptions

**File**: `packages/providers/src/types.ts`

**Change**: Add optional `freshSession?: boolean` field to `SendQueryOptions` interface
(after line 239, alongside `assistantConfig`).

```typescript
export interface SendQueryOptions extends AgentRequestOptions {
  nodeConfig?: NodeConfig;
  assistantConfig?: Record<string, unknown>;
  /** When true, bypass session pool and start a fresh conversation.
   *  Used by workflow nodes with context: 'fresh' or parallel execution. */
  freshSession?: boolean;
}
```

**Verification**: `grep -n 'freshSession' packages/providers/src/types.ts` → 2+ matches

### Task 1.2: Skip pool lookup when `freshSession: true`

**File**: `packages/providers/src/hermes/provider.ts`

**Change**: In `_sendQueryOnce`, after resolving model (line 240), check
`options?.freshSession` before pool.acquire:

```typescript
// 3. Check session pool — skip when freshSession is requested.
const pooled = options?.freshSession
  ? undefined
  : this.pool.acquire(session.cwd, model, config.provider);
```

**Verification**: `grep -n 'freshSession' packages/providers/src/hermes/provider.ts` → 2+ matches

### Task 1.3: Pass `freshSession` from dag-executor

**File**: `packages/workflows/src/dag-executor.ts`

**Change**: In the `nodeOptionsWithAbort` construction (line 691-695), propagate
`isFresh` into the options:

```typescript
const nodeOptionsWithAbort: SendQueryOptions | undefined = {
  ...nodeOptions,
  abortSignal: nodeAbortController.signal,
  ...(shouldForkSession ? { forkSession: true } : {}),
  ...(isFresh ? { freshSession: true } : {}), // ← NEW
};
```

Note: `isFresh` is computed at line 2842 in the outer function and passed to
`executeNodeInternal`. The change needs to be inside `executeNodeInternal` where
`nodeOptionsWithAbort` is built. Verify that `isFresh` (or equivalent) is
accessible at that scope — it may need to be passed as a parameter.

**Verification**: `grep -n 'freshSession' packages/workflows/src/dag-executor.ts` → 1+ match

### Task 1.4: Add tests

**File**: `packages/providers/src/hermes/session-pool.test.ts` or `provider.test.ts`

**Tests**:

1. Pool.acquire returns session when freshSession is false (existing behavior)
2. Provider skips pool lookup when freshSession=true (new test)
3. Parallel nodes with same cwd+model get independent sessions (integration)

### Gate 1

```
STEP [1]: grep -c 'freshSession' packages/providers/src/types.ts
  Expected: >= 2 (interface field + JSDoc)

STEP [2]: grep -c 'freshSession' packages/providers/src/hermes/provider.ts
  Expected: >= 1

STEP [3]: grep -c 'freshSession' packages/workflows/src/dag-executor.ts
  Expected: >= 1

STEP [4]: bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
  Expected: all pass

STEP [5]: bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
  Expected: all pass

STEP [6]: bun run type-check
  Expected: exit 0
```

**Commit**: `fix(hermes): respect context:fresh by bypassing session pool`

---

## Phase 2: Bug 2 — Compression Model Uses Wrong Endpoint

### Scope

Config-only change. 1 file, 1 line.

### Task 2.1: Fix compression provider in config.yaml

**File**: `~/.hermes/config.yaml`

**Change**: Under `auxiliary.compression`, change `provider: auto` to
`provider: google`:

```yaml
auxiliary:
  compression:
    provider: google # ← was: auto
    model: google/gemini-3-flash-preview
```

**Rationale**: The model `google/gemini-3-flash-preview` requires routing to
Google's API endpoint. `auto` resolves to the default model's provider (xiaomi),
which doesn't serve Google models.

**Verification**: `grep -A2 'compression:' ~/.hermes/config.yaml` shows
`provider: google`

### Task 2.2: Verify compression works

**Manual test**: Start a hermes session with a long conversation to trigger
compression. Verify the compression request reaches the correct endpoint.

**Alternative verification**: Check hermes agent logs for compression API calls:

```bash
grep 'compression' ~/.hermes/logs/agent.log | tail -5
```

### Gate 2

```
STEP [1]: grep -A2 'compression:' ~/.hermes/config.yaml | grep 'provider: google'
  Expected: match found

STEP [2]: python3 -c "
import yaml
with open('$HOME/.hermes/config.yaml') as f:
    cfg = yaml.safe_load(f)
assert cfg['auxiliary']['compression']['provider'] == 'google'
assert cfg['auxiliary']['compression']['model'] == 'google/gemini-3-flash-preview'
print('PASS')
"
  Expected: PASS
```

**No git commit** — this is a user config file, not in the repo.

---

## Phase 3: Bug 3 — Context Probe Tiers Cap at 256K

### Scope

Hermes CLI Python utility. 1 file, ~5 lines changed.

### Task 3.1: Add higher probe tiers

**File**: `~/.hermes/hermes-agent/agent/model_metadata.py`

**Change**: Extend CONTEXT_PROBE_TIERS with 512K and 1M entries:

```python
# model_metadata.py:116-126
CONTEXT_PROBE_TIERS = [
    1_000_000,  # ← NEW: 1M (Claude 4.x, GPT-5.x, large-context models)
    512_000,    # ← NEW: 512K (mid-tier for models between 256K and 1M)
    256_000,
    128_000,
    64_000,
    32_000,
    16_000,
    8_000,
]

DEFAULT_FALLBACK_CONTEXT = CONTEXT_PROBE_TIERS[0]  # Now 1M
```

**Risk assessment**: Raising DEFAULT_FALLBACK_CONTEXT from 256K to 1M means
unknown models will attempt 1M context first. If the model doesn't support it,
the probe will step down. This adds one extra failed probe attempt for models
that cap at 256K or below (minor latency cost on first use, cached after).

**Mitigation**: The probe is only used when ALL other resolution paths fail
(cache, endpoint metadata, models.dev, OpenRouter, Anthropic API, hardcoded
defaults). Most known models are caught before probing. Unknown models with
small contexts will have one extra retry (1M → 512K → 256K → ...).

### Task 3.2: Verify probe tier ordering

**Test**: Ensure tiers are strictly descending and probe stepping works:

```python
# Add to existing tests or verify manually
assert CONTEXT_PROBE_TIERS == sorted(CONTEXT_PROBE_TIERS, reverse=True)
assert get_next_probe_tier(1_000_000) == 512_000
assert get_next_probe_tier(512_000) == 256_000
assert get_next_probe_tier(256_000) == 128_000
assert get_next_probe_tier(8_000) is None
```

### Gate 3

```
STEP [1]: python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import CONTEXT_PROBE_TIERS, DEFAULT_FALLBACK_CONTEXT
assert CONTEXT_PROBE_TIERS[0] == 1_000_000, f'Expected 1M, got {CONTEXT_PROBE_TIERS[0]}'
assert DEFAULT_FALLBACK_CONTEXT == 1_000_000, f'Expected 1M default, got {DEFAULT_FALLBACK_CONTEXT}'
assert len(CONTEXT_PROBE_TIERS) == 8, f'Expected 8 tiers, got {len(CONTEXT_PROBE_TIERS)}'
print('PASS')
"
  Expected: PASS

STEP [2]: python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import get_next_probe_tier
assert get_next_probe_tier(1_000_000) == 512_000
assert get_next_probe_tier(512_000) == 256_000
assert get_next_probe_tier(256_000) == 128_000
assert get_next_probe_tier(8_000) is None
print('PASS')
"
  Expected: PASS

STEP [3]: cd ~/.hermes/hermes-agent && python3 -m pytest tests/test_model_metadata.py -x -q 2>&1 | tail -5
  Expected: all pass (or no such file — check if tests exist)
```

**No git commit** — this is in the Hermes CLI repo, not Archon.

---

## Phase 4: Bug 4 — Token Estimation Overcounts

### Scope

Hermes CLI Python utility. 1 file, ~20 lines changed.

### Task 4.1: Fix `estimate_messages_tokens_rough`

**File**: `~/.hermes/hermes-agent/agent/model_metadata.py`

**Current** (lines 1446-1449):

```python
def estimate_messages_tokens_rough(messages: List[Dict[str, Any]]) -> int:
    """Rough token estimate for a message list (pre-flight only)."""
    total_chars = sum(len(str(msg)) for msg in messages)
    return (total_chars + 3) // 4
```

**Fix**: Extract only content-bearing values, ignore structural overhead:

```python
def estimate_messages_tokens_rough(messages: List[Dict[str, Any]]) -> int:
    """Rough token estimate for a message list (pre-flight only).

    Counts only content text (role messages, tool calls/results) rather
    than Python dict repr which inflates by 2-4x due to structural syntax.
    """
    total_chars = 0
    for msg in messages:
        # Count content text (main message body)
        content = msg.get("content")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            # Multi-part content (text + images)
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    total_chars += len(part["text"])
        # Count tool call arguments
        tool_calls = msg.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                if isinstance(tc, dict):
                    fn = tc.get("function", {})
                    if isinstance(fn.get("arguments"), str):
                        total_chars += len(fn["arguments"])
                    if isinstance(fn.get("name"), str):
                        total_chars += len(fn["name"])
        # Count tool result content
        tool_result = msg.get("tool_result")
        if isinstance(tool_result, str):
            total_chars += len(tool_result)
        # Role name overhead (~4 chars per message: "user", "system", etc.)
        total_chars += 4
    return (total_chars + 3) // 4
```

### Task 4.2: Fix `estimate_request_tokens_rough`

**File**: `~/.hermes/hermes-agent/agent/model_metadata.py`

**Current** (lines 1452-1472):

```python
def estimate_request_tokens_rough(messages, *, system_prompt="", tools=None):
    total_chars = 0
    if system_prompt:
        total_chars += len(system_prompt)
    if messages:
        total_chars += sum(len(str(msg)) for msg in messages)
    if tools:
        total_chars += len(str(tools))
    return (total_chars + 3) // 4
```

**Fix**: Use the corrected message estimation + better tool estimation:

```python
def estimate_request_tokens_rough(
    messages: List[Dict[str, Any]],
    *,
    system_prompt: str = "",
    tools: Optional[List[Dict[str, Any]]] = None,
) -> int:
    """Rough token estimate for a full chat-completions request.

    Uses content-level character counting for messages (avoids dict repr
    inflation). Tool schemas use str() since they're JSON Schema objects
    where key names are part of the actual prompt payload.
    """
    total_chars = 0
    if system_prompt:
        total_chars += len(system_prompt)
    if messages:
        total_chars += sum(
            _estimate_single_message_chars(msg) for msg in messages
        )
    if tools:
        # Tool schemas are sent as JSON — str() is roughly accurate since
        # the key names and structure ARE part of the tokenized payload.
        total_chars += len(str(tools))
    return (total_chars + 3) // 4


def _estimate_single_message_chars(msg: Dict[str, Any]) -> int:
    """Estimate character count for a single message (content only)."""
    chars = 4  # role name overhead
    content = msg.get("content")
    if isinstance(content, str):
        chars += len(content)
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                chars += len(part["text"])
    tool_calls = msg.get("tool_calls")
    if isinstance(tool_calls, list):
        for tc in tool_calls:
            if isinstance(tc, dict):
                fn = tc.get("function", {})
                if isinstance(fn.get("arguments"), str):
                    chars += len(fn["arguments"])
                if isinstance(fn.get("name"), str):
                    chars += len(fn["name"])
    tool_result = msg.get("tool_result")
    if isinstance(tool_result, str):
        chars += len(tool_result)
    return chars
```

### Task 4.3: Add tests

**File**: `~/.hermes/hermes-agent/tests/test_model_metadata.py` (or existing test file)

**Tests**:

1. Simple user message: `{"role": "user", "content": "hello"}` → ~2 tokens (not 11)
2. Multi-turn conversation with tool calls → reasonable estimate
3. Empty message list → 0
4. Message with list content (multi-part) → counts text parts only

### Gate 4

```
STEP [1]: python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import estimate_messages_tokens_rough
# Old: len(str({'role':'user','content':'hello'})) // 4 = 37//4 = 9
# New: should be ~2-3 tokens
result = estimate_messages_tokens_rough([{'role': 'user', 'content': 'hello'}])
assert result < 5, f'Expected <5 tokens, got {result}'
assert result > 0, f'Expected >0 tokens, got {result}'
print(f'PASS: {result} tokens')
"
  Expected: PASS (2-3 tokens)

STEP [2]: python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import estimate_messages_tokens_rough
msgs = [
    {'role': 'system', 'content': 'You are a helpful assistant.'},
    {'role': 'user', 'content': 'What is 2+2?'},
    {'role': 'assistant', 'content': '4'},
]
result = estimate_messages_tokens_rough(msgs)
assert result < 20, f'Expected <20 tokens, got {result}'
assert result > 5, f'Expected >5 tokens, got {result}'
print(f'PASS: {result} tokens')
"
  Expected: PASS (8-15 tokens)

STEP [3]: python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import estimate_messages_tokens_rough
assert estimate_messages_tokens_rough([]) == 0
print('PASS: empty list = 0')
"
  Expected: PASS

STEP [4]: cd ~/.hermes/hermes-agent && python3 -m pytest tests/test_model_metadata.py -x -q 2>&1 | tail -5
  Expected: all pass (or no such file — check if tests exist)
```

**No git commit** — this is in the Hermes CLI repo, not Archon.

---

## Phase 5: Final Validation

### Comprehensive Verification

```
STEP [1]: cd /home/d/Desktop/Archon-canonical

STEP [2]: bun run type-check
  Expected: exit 0

STEP [3]: bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
  Expected: all pass

STEP [4]: bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
  Expected: all pass

STEP [5]: bun test packages/providers/src/hermes/ --timeout 60000
  Expected: all pass (use explicit file list from package.json, NOT directory mode)

STEP [6]: Verify Bug 1 fix: freshSession bypasses pool
  grep -rn 'freshSession' packages/providers/src/ packages/workflows/src/
  Expected: matches in types.ts, provider.ts, dag-executor.ts

STEP [7]: Verify Bug 2 fix: compression provider
  grep -A2 'compression:' ~/.hermes/config.yaml
  Expected: provider: google

STEP [8]: Verify Bug 3 fix: probe tiers
  python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import CONTEXT_PROBE_TIERS
print(CONTEXT_PROBE_TIERS)
assert CONTEXT_PROBE_TIERS[0] == 1_000_000
"
  Expected: [1000000, 512000, 256000, ...]

STEP [9]: Verify Bug 4 fix: token estimation
  python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from agent.model_metadata import estimate_messages_tokens_rough
r = estimate_messages_tokens_rough([{'role':'user','content':'hello'}])
print(f'Tokens: {r}')
assert r < 5
"
  Expected: Tokens: 2-3
```

### E2E Smoke Test

```bash
# After all fixes, run the hermes workflow smoke test
bun run cli workflow run e2e-hermes-smoke --no-worktree
# Expected: completes in ~15s

# Run the parallel verifier workflow (the original failing case)
bun run cli workflow run hermes-pr-verifier --no-worktree
# Expected: completes without hang (was hanging before Bug 1 fix)
```

---

## Commit Plan

| Phase | Commit | Message                                                        | Repo   |
| ----- | ------ | -------------------------------------------------------------- | ------ |
| 1     | 1      | `fix(hermes): respect context:fresh by bypassing session pool` | Archon |
| 2     | —      | Config change (no commit — user config)                        | —      |
| 3     | —      | Python change (no commit — hermes-agent repo)                  | —      |
| 4     | —      | Python change (no commit — hermes-agent repo)                  | —      |
| 5     | —      | Validation only                                                | —      |

**Only Bug 1 produces a git commit** in the Archon repo. Bugs 2-4 modify
external files (config.yaml, hermes-agent Python code) that are not in the
Archon git repository.

---

## Execution Summary

```
PHASE 1: Bug 1 (Archon TS) ── 3 files, ~15 lines ── GATE 1
    │
    ├──→ PHASE 2: Bug 2 (config) ── 1 file, 1 line ── GATE 2
    │         (parallel with Phase 1)
    │
    └──→ PHASE 3: Bug 3 (Python tiers) ── 1 file, ~5 lines ── GATE 3
              │
              └──→ PHASE 4: Bug 4 (Python tokens) ── 1 file, ~20 lines ── GATE 4
                        │
                        └──→ PHASE 5: Final Validation
```

**Optimal parallel dispatch**: Phases 1 and 2 can run simultaneously (different
codebases). Phases 3 and 4 are sequential (same file). Phase 5 waits for all.

---

## Risk Register

| Risk                                                                     | Probability | Impact | Mitigation                                            |
| ------------------------------------------------------------------------ | ----------- | ------ | ----------------------------------------------------- |
| Bug 1: isFresh not in scope at nodeOptionsWithAbort construction         | Medium      | Medium | Pass isFresh as parameter to executeNodeInternal      |
| Bug 2: google provider needs API key in .env                             | Low         | Low    | Verify GOOGLE_API_KEY or GEMINI_API_KEY exists        |
| Bug 3: Raising default to 1M causes extra probe retries for small models | Low         | Low    | Probe is cached after first use; only 2 extra steps   |
| Bug 4: New estimation breaks existing compression thresholds             | Medium      | Medium | Lower estimates = less premature compression = better |
| Bug 4: Tool result content structure varies across providers             | Low         | Low    | Defensive isinstance checks in estimation             |

---

## Out of Scope

- Upstream Hermes CLI auto-detection of provider from model prefix (Bug 2 option B)
- tiktoken-based accurate token counting (Bug 4 option B)
- state.db contention fix (addressed by existing ConcurrencyLock)
- @agentclientprotocol/sdk migration (deferred P2)
- Cross-provider session management changes
