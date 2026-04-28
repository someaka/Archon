# Post-Review Fix Plan — Consolidated from 3 Reviewers + 3 Planners

> Covers every item from all three general reviewer reports.
> Verified by 3 planners against: online docs, codebase patterns, issue requirements.

---

## Items Inventory

### BLOCKING (Reviewer #2 — REQUEST_CHANGES)

| #   | Item                                                     | Source | Priority |
| --- | -------------------------------------------------------- | ------ | -------- |
| B1  | 4 test files missing from CI test script in package.json | R2     | HIGH     |
| B2  | No tests for registration.ts (registerHermesProvider)    | R2     | HIGH     |
| B3  | Protocol version mismatch path untested in event-bridge  | R2     | HIGH     |

### NON-BLOCKING (Reviewer #1 — APPROVE with notes)

| #   | Item                                                | Source | Priority |
| --- | --------------------------------------------------- | ------ | -------- |
| N1  | globalAuth config key parsed but never wired to env | R1     | LOW      |

### NON-BLOCKING (Reviewer #2 — Nice to have)

| #   | Item                                         | Source | Priority |
| --- | -------------------------------------------- | ------ | -------- |
| N2  | normalizeAcpUsage direct unit tests          | R2     | MEDIUM   |
| N3  | SIGKILL fallback escalation test             | R2     | MEDIUM   |
| N4  | assertObjectResult throws on non-object test | R2     | MEDIUM   |
| N5  | Pool stale entry cleanup test                | R2     | MEDIUM   |
| N6  | Pool eviction on failure test                | R2     | MEDIUM   |

### NON-BLOCKING (Reviewer #3 — Future improvement)

| #   | Item                                             | Source | Priority |
| --- | ------------------------------------------------ | ------ | -------- |
| F1  | isHermesModelCompatible catch-all documentation  | R3     | LOW      |
| F2  | session/load support when Hermes CLI supports it | R3     | LOW      |
| F3  | UsageUpdate stabilization tracking               | R3     | LOW      |
| F4  | authenticate method support                      | R3     | LOW      |
| F5  | options-translator.ts consumer verification      | R3     | LOW      |

### BONUS (Planner B — Pre-existing bug)

| #   | Item                                                                | Source | Priority |
| --- | ------------------------------------------------------------------- | ------ | -------- |
| X1  | registry.test.ts stale assertions (sessionResume/mcp: false → true) | PB     | HIGH     |

---

## Execution Plan

### Batch F1: CI + Registration (3 parallel executors) — ~55 min

#### F1.1 — Fix CI test script (B1)

**File:** `packages/providers/package.json`

**Action:** Append 4 missing test files to the EXISTING Hermes test batch on line 21.
Change:

```
bun test src/hermes/config.test.ts src/hermes/model-ref.test.ts src/hermes/options-translator.test.ts src/hermes/session-resolver.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts
```

To:

```
bun test src/hermes/config.test.ts src/hermes/model-ref.test.ts src/hermes/options-translator.test.ts src/hermes/session-resolver.test.ts src/hermes/event-bridge.test.ts src/hermes/provider.test.ts src/hermes/acp-protocol.test.ts src/hermes/error-classifier.test.ts src/hermes/hermes-mcp-reader.test.ts src/hermes/session-pool.test.ts src/hermes/timeout-utils.test.ts
```

binary-resolver.test.ts remains in its own `&& bun test` invocation (uses cache-busting
dynamic imports with mock.module).

**Verify:** `cd packages/providers && bun run test`

---

#### F1.2 — Add registration tests (B2)

**New file:** `packages/providers/src/hermes/registration.test.ts`

**Test approach:** Follow registry.test.ts patterns (clearRegistry in beforeEach,
import from `../registry`). No mock.module() needed — can run in the main batch.

**Tests to write:**

1. `registerHermesProvider registers with correct id and displayName`
   - Call `registerHermesProvider()`, then `getRegistration('hermes')`
   - Assert `id === 'hermes'`, `displayName === 'Hermes Agent (Nous Research)'`, `builtIn === true`
2. `registerHermesProvider is idempotent — does not throw on second call`
   - Call twice, expect no throw
3. `isModelCompatible returns true for any model string`
   - Assert `true` for 'gpt-4', 'claude-opus-4', '', 'hermes:ollama/llama3.1'
4. `factory creates a HermesProvider instance`
   - Call `reg.factory()`, assert `getType() === 'hermes'`
5. `capabilities match HERMES_CAPABILITIES constant`
   - Import HERMES_CAPABILITIES, assert equality

**Run:** `bun test src/hermes/registration.test.ts`

---

#### F1.3 — Add protocol version mismatch test (B3)

**File:** `packages/providers/src/hermes/event-bridge.test.ts`

**Test to write:**

```typescript
test('throws on unsupported ACP protocol version', async () => {
  const mock = createAcpMock({ initResult: { protocolVersion: 99 } });
  const bridge = bridgeHermesSession(mock.process, makeBridgeOptions());
  const { error } = await consume(bridge);
  expect(error).toBeDefined();
  expect(error!.message).toContain('protocol version 99');
  expect(error!.message).toContain('not supported');
});
```

**Why this works:** `createAcpMock` (line 135-139) spreads `options.initResult` over
default `{ protocolVersion: 1, ... }`, so `{ protocolVersion: 99 }` overrides it.
The bridge throws at event-bridge.ts line 495-497, caught at line 616, emitted as
terminal error result. The `consume()` helper captures the error.

**Run:** `bun test src/hermes/event-bridge.test.ts`

---

#### F1.4 — Fix stale registry.test.ts assertions (X1)

**File:** `packages/providers/src/registry.test.ts`

**Lines 143-150 and 158-173:** Assert `sessionResume: false, mcp: false` but actual
HERMES_CAPABILITIES has `sessionResume: true, mcp: true`.

**Fix:** Update both test blocks to assert `sessionResume: true, mcp: true, envInjection: true`.

**Run:** `bun test src/registry.test.ts`

---

### Batch F2: Coverage Tests (3 parallel executors) — ~55 min

#### F2.1 — normalizeAcpUsage direct unit tests (N2)

**File:** `packages/providers/src/hermes/event-bridge.test.ts`

**Tests to write:**

1. `normalizeAcpUsage with valid usage returns TokenUsage`
   - Call `normalizeAcpUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })`
   - Assert `{ input: 10, output: 20, total: 30 }`
2. `normalizeAcpUsage with missing total returns partial TokenUsage`
   - Call `normalizeAcpUsage({ inputTokens: 10, outputTokens: 20 })`
   - Assert `{ input: 10, output: 20 }` (no total key)
3. `normalizeAcpUsage with non-number values returns undefined`
   - Call `normalizeAcpUsage({ inputTokens: 'ten', outputTokens: 20 })`
   - Assert `undefined`
4. `normalizeAcpUsage with missing fields returns undefined`
   - Call `normalizeAcpUsage({})`
   - Assert `undefined`

normalizeAcpUsage is exported — direct import works. No mock needed.

---

#### F2.2 — Pool edge case tests (N5, N6)

**File:** `packages/providers/src/hermes/provider.test.ts` (NOT session-pool.test.ts)

The pool's `get()` does NOT check for stale processes — the provider does
(provider.ts lines 171, 203, 215-217). Tests belong in provider.test.ts where
the ACP mock infrastructure already exists.

**Tests to write:**

1. `sendQuery evicts stale pooled session and spawns fresh`
   - Pre-populate pool with mock process that has `exitCode: 99` (already-exited)
   - Call sendQuery with same cwd+model
   - Verify: new spawn happened, stale entry was deleted
2. `sendQuery evicts pool entry on pooled query failure`
   - Pre-populate pool with working mock process
   - Make bridge throw (mock process sends error response)
   - Verify: pool.delete was called (pool.size === 0 after)

**Pattern:** Follow existing "sendQuery reuses pooled session on second call" test.

---

#### F2.3 — SIGKILL fallback test (N3)

**File:** `packages/providers/src/hermes/event-bridge.test.ts`

**Test approach:**

```typescript
test(
  'abort sends SIGTERM then SIGKILL after grace period',
  async () => {
    const acp = createAcpMock();
    const controller = new AbortController();
    const bridge = bridgeHermesSession(acp.process, makeBridgeOptions(), controller.signal);
    const consuming = consume(bridge);
    controller.abort();
    await consuming;
    expect(acp.process.kill).toHaveBeenCalledWith('SIGTERM');
    await new Promise(r => setTimeout(r, 5100));
    expect(acp.process.kill).toHaveBeenCalledWith('SIGKILL');
  },
  { timeout: 10000 }
);
```

**Note:** Makes test suite ~5s slower. Use separate `describe` block with longer timeout.

---

### Batch F3: Wiring + Documentation (2 parallel executors) — ~15 min

#### F3.1 — Wire globalAuth to env (N1)

**File:** `packages/providers/src/hermes/provider.ts`

**Action:** After line 228 (`const modelEnv: Record<string, string> = {};`), add:

```typescript
// Archon convention: HERMES_USE_GLOBAL_AUTH signals the Hermes ACP subprocess
// to use globally configured auth (from `hermes login`) instead of per-session
// credentials. Not an official Hermes env var — Archon-specific for Docker/CI.
if (config.globalAuth) {
  modelEnv.HERMES_USE_GLOBAL_AUTH = 'true';
}
```

This works because `modelEnv` is spread into spawn env at line 270:
`env: { ...session.env, ...modelEnv }`.

**Test:** In provider.test.ts, pass `globalAuth: true` in assistantConfig and assert
spawn options env contains `HERMES_USE_GLOBAL_AUTH: 'true'`.

**Verify:** `bun test packages/providers/src/hermes/provider.test.ts`

---

#### F3.2 — Document catch-all behavior (F1)

**File:** `packages/providers/src/hermes/model-ref.ts`

**Action:** The existing doc comment (lines 69-79) is already good. EXTEND it with
the `inferProviderFromModel()` implication — do NOT replace:

```typescript
/**
 * Registry-level `isModelCompatible` check.
 *
 * Always returns true — Hermes CLI resolves its own model and provider
 * from ~/.hermes/config.yaml at runtime. Archon's workflow loader should
 * not gatekeep models that Hermes itself can handle.
 *
 * This makes Hermes the fallback provider in `inferProviderFromModel()` for
 * any model not matching Claude or Codex patterns. Users can always set
 * `provider:` explicitly to override inference.
 *
 * The model string is passed through to `resolveHermesModel`, which falls
 * back to the configured HERMES_MODEL env var when the modelRef doesn't
 * match the "hermes:" prefix format.
 */
```

---

## Dependency Matrix

| Task | Parallel With    | Blocks | Blocked By |
| ---- | ---------------- | ------ | ---------- |
| F1.1 | F1.2, F1.3, F1.4 | —      | —          |
| F1.2 | F1.1, F1.3, F1.4 | —      | —          |
| F1.3 | F1.1, F1.2, F1.4 | —      | —          |
| F1.4 | F1.1, F1.2, F1.3 | —      | —          |
| F2.1 | F2.2, F2.3       | —      | —          |
| F2.2 | F2.1, F2.3       | —      | —          |
| F2.3 | F2.1, F2.2       | —      | —          |
| F3.1 | F3.2             | —      | —          |
| F3.2 | F3.1             | —      | —          |

All tasks are independent — fully parallel within batches.

---

## Summary

| Category             | Count  | Status                 |
| -------------------- | ------ | ---------------------- |
| Blocking (B1-B3)     | 3      | All addressed          |
| Non-blocking (N1-N6) | 6      | All addressed          |
| Future (F1-F5)       | 5      | 2 addressed, 3 tracked |
| Bonus (X1)           | 1      | Addressed              |
| **Total**            | **15** |                        |

**New tests:** ~15
**Files modified:** 5 (package.json, provider.ts, event-bridge.test.ts, registry.test.ts, model-ref.ts)
**New files:** 1 (registration.test.ts)
**Estimated total effort:** ~2 hours

---

## Issue #1106 Closure Status

This plan addresses the **providers package** scope only. Full issue closure requires:

| Work Stream                        | Package                 | Status                                |
| ---------------------------------- | ----------------------- | ------------------------------------- |
| Provider implementation            | providers/              | DONE (this plan fixes remaining gaps) |
| CLI setup wizard                   | cli/                    | NOT STARTED — separate work           |
| Documentation                      | docs-web/               | NOT STARTED — separate work           |
| Cross-package integration tests    | workflows/ + providers/ | NOT STARTED — separate work           |
| Nice-to-haves (Web UI, benchmarks) | web/                    | NOT STARTED — separate work           |
