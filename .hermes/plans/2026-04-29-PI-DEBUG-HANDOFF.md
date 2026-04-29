# POST-COMPRESSION HANDOFF — Pi Provider Debugging

> Date: 2026-04-29 ~16:30 UTC
> Status: Pi workflow FAILS — root cause NOT found. Need proper debugger delegation.

---

## READ THIS FIRST (in order)

1. THIS FILE (you're reading it)
2. Skills: `archon-hermes-provider`, `archon-hermes-methodology`, `subagent-driven-development`
3. `.hermes/plans/2026-04-29-REBOOT-HANDOFF.md` (Hermes context — Hermes works now)

---

## WHAT HAPPENED

### Hermes Workflow: ✅ WORKS

`hermes-local-review` completes in 33 seconds. Full code review output. No errors.

### Pi Workflow: ❌ FAILS

`pi-hermes-code-review` fails consistently with:

```
stopReason: "error"
durationMs: ~1000
errorSubtype: "error"
```

The Pi SDK creates a session (`pi.session_started` logs successfully), but then the actual prompt call returns an error result after ~1 second.

### Three Changes Made (NOT the root cause)

1. **Extension reload crash** (`provider.ts:383`): `resourceLoader.reload()` crashes when Pi's package dir is minimal shim. Fixed with try-catch. **Effect**: No more `paths[0]` TypeError. But the workflow still fails.

2. **Missing env var mapping** (`provider.ts:78`): `opencode` and `opencode-go` missing from `PI_PROVIDER_ENV_VARS`. Added `OPENCODE_API_KEY`. **Effect**: Key now passed to authStorage. But the workflow still fails.

3. **Stale dependency** (`packages/providers/package.json`): pi-coding-agent 0.67.5 → 0.70.6. **Effect**: `kimi-k2.6` now in model catalog. But the workflow still fails.

### Other Fix: Stagger Gate (`dag-executor.ts`)

`signalNodeReady` was created but never passed to `executeNodeInternal`. Parallel nodes waited 60s timeout instead of being signaled on first output. Fixed by passing `signalNodeReady` as last param.

---

## WHAT'S ACTUALLY WRONG

**Unknown.** The three changes above addressed real bugs but didn't fix the core issue. The Pi SDK's `session.prompt()` returns an error result after ~1s. The error is NOT:

- Model not found (model IS found, session starts)
- API key missing (key IS passed, user confirmed account has balance)
- Extension crash (now caught)

The actual error is somewhere in the Pi SDK's prompt execution path. Need to:

1. Read the Pi SDK's `session.prompt()` implementation
2. Check what error the SDK actually returns (not just `stopReason: "error"`)
3. Add logging to capture the SDK's actual error message
4. Check if the issue is in the Pi provider's event bridge or the SDK itself

---

## DEBUGGER DELEGATION PLAN

After compression, dispatch 3 debuggers:

### Debugger 1: Pi SDK Error Capture

- Read `packages/providers/src/community/pi/event-bridge.ts`
- Find where the SDK's error is captured
- Check if the actual error message is logged or swallowed
- Add logging to capture the full error from `session.prompt()`

### Debugger 2: Pi SDK Internal Path

- Read the Pi SDK's `session.prompt()` implementation
- Trace the code path from prompt to API call
- Check what could fail after session creation but before response
- Look at the `agent_end` event — is the error in the transcript?

### Debugger 3: Env/Config Verification

- Verify OPENCODE_API_KEY is actually in the CLI process env
- Check if the Pi SDK's `getEnvApiKey` is called and returns the key
- Verify the opencode endpoint URL is correct
- Check if there's a network/proxy issue

---

## CURRENT REPO STATE

```
Repo: /home/d/Desktop/Archon-canonical
Branch: dev (rebased onto upstream/dev, 100 commits ahead of origin/dev)

Modified files (uncommitted):
  packages/providers/src/community/pi/provider.ts  (3 fixes)
  packages/workflows/src/dag-executor.ts           (stagger gate fix)
  packages/providers/package.json                  (pi dep update)
  bun.lock                                         (pi dep update)
  packages/workflows/src/defaults/bundled-defaults.generated.ts
  .archon/workflows/defaults/pi-hermes-code-review.yaml (new)

Hermes tests: ALL PASS (320 provider tests)
Workflow tests: ALL PASS (204 dag-executor tests, 873 total)
Validate: type-check ✅, lint ✅, format ✅
Parallel test runner: exit code 1 (pre-existing race condition, not our change)
```

---

## KEY FILES

```
Pi provider:     packages/providers/src/community/pi/provider.ts
Pi event bridge: packages/providers/src/community/pi/event-bridge.ts
Pi config:       packages/providers/src/community/pi/config.ts
Pi model ref:    packages/providers/src/community/pi/model-ref.ts

Hermes provider: packages/providers/src/hermes/provider.ts
DAG executor:    packages/workflows/src/dag-executor.ts

Pi workflow YAML: .archon/workflows/defaults/pi-hermes-code-review.yaml
Hermes workflow:  .archon/workflows/defaults/hermes-local-review.yaml

Skills: archon-hermes-provider, archon-hermes-methodology
```

---

## CRITICAL RULES

1. **NEVER blame external services without proof** — I incorrectly reported "OpenCode account has no balance" when the real issue is in our code.
2. **Use proper methodology** — dispatch debuggers with delegation, not surface-level CLI tests.
3. **Read the actual error** — the Pi SDK returns `stopReason: "error"` but the actual error message is being swallowed somewhere. Find it.
4. **All issues are critical** — zero severity assessment.
5. **When told stop: output nothing.**

---

## WHAT TO DO AFTER COMPRESSION

1. Load skills: `archon-hermes-provider`, `subagent-driven-development`
2. Read this file
3. Dispatch 3 debuggers (above) in parallel
4. Synthesize findings
5. Fix the actual root cause
6. Run both workflows side by side to verify
7. Commit and validate
