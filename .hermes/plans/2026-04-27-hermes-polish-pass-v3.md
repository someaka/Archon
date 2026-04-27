# Hermes Provider — Polish Pass Plan v3 (Post-Recovery)

> **Execution method:** Executor-verifier loop. Max 3 concurrent executors. EACH executor touches exactly ONE file. Test changes for a source file run ONLY after that source file is verifier-green.
>
> **Lessons from v2 failure:**
>
> - Executor that modified provider.ts retry loop + provider.test.ts together broke both
> - P3.4 (withRetry migration) was YAGNI and broken — SKIPPED
> - Batch 2 executor modified test expectations without updating source → 10 failures
> - Fix: one-file-per-executor, source-then-test sequencing

---

## Approved Tasks (from v2 audit)

### T1: Fix mockSpawn type in provider.test.ts

**File:** `packages/providers/src/hermes/provider.test.ts`
**Change:** Add `: ChildProcess` return type to mock function on line 17
**Risk:** None — type-only, no runtime change
**Verifier:** `bun --filter @archon/providers type-check` passes for this file

### T2: Fix top-level await in event-bridge.test.ts

**File:** `packages/providers/src/hermes/event-bridge.test.ts`
**Change:** Move dynamic import into `beforeAll`, add to existing imports
**Risk:** Low — import order change only
**Verifier:** `bun --filter @archon/providers type-check` passes for this file

### T3: Strengthen verifyHermesBinary tests in binary-resolver.test.ts

**File:** `packages/providers/src/hermes/binary-resolver.test.ts`
**Change:** Add success-path test mocking execFile to return true
**Risk:** Low — test-only, mocks already used in file
**Verifier:** `bun test packages/providers/src/hermes/binary-resolver.test.ts` passes

### T4: Add error-classifier permission-error patterns

**File:** `packages/providers/src/hermes/error-classifier.ts`
**File:** `packages/providers/src/hermes/error-classifier.test.ts`
**Change:** Add EACCES/ENOENT/ENOTDIR → shouldRetry:false, with tests
**Risk:** Low — additive only, no existing behavior changes
**Verifier:** `bun test packages/providers/src/hermes/error-classifier.test.ts` passes

### T5: Fix env spread type safety in provider.ts (if needed)

**File:** `packages/providers/src/hermes/provider.ts`
**Change:** Check `env: { ...process.env, ...session.env }` for type safety. If issue exists, fix.
**Risk:** Low — may be no-op if types already correct
**Verifier:** `bun --filter @archon/providers type-check` passes

## Skipped Tasks

- P3.2 provider.ts coverage improvements — requires coordinated source+test changes, too risky for subagents
- P3.4 withRetry migration — YAGNI, complex, broken in v2
- P5.3 mock.module shape audit — no evidence of actual bugs (all tests pass)
- Lint OOM investigation — repo-wide issue, not Hermes-specific

## Execution Order

```
Batch 1 (independent, single-file each):
  T1 — provider.test.ts (type fix)
  T2 — event-bridge.test.ts (import order)
  T3 — binary-resolver.test.ts (success-path test)

After T1/T2/T3 verifier-green:
  T4 — error-classifier.ts + test.ts (permission patterns)
  T5 — provider.ts (env spread check)
```

## Rules (Strict)

1. **One file per executor** — never both source and test
2. **No test changes until source is green** — prevents expectation mismatches
3. **Every executor gets explicit file path** — no "find it yourself"
4. **Verifiers run exact command** — no abstract "check it works"
5. **Max 3 concurrent executors** — but only 3 independent files at once
6. **If source file needs change, test updates are separate batch** — after source verifier passes
7. **No retry loop refactoring** — P3.4 permanently skipped
8. **No env var leaking** — no ARCHON_HERMES_RETRY_BASE_DELAY_MS or similar

## Final Gate

```bash
cd /home/d/Desktop/Archon-canonical
bun test packages/providers/src/hermes/
```

Expected: 122+ pass, 0 fail
