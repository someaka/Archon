# Hermes Provider — Completion Plan (Post-Compaction Resume)

> **State after context compaction:** T1 (mockSpawn type) and T4 (error-classifier patterns) are verifier-green. T2, T3, and all fix-plan elements below remain open. This plan covers ONLY remaining work.

## Done (verified green)

| ID  | Task                                            | File(s)                                           |
| --- | ----------------------------------------------- | ------------------------------------------------- |
| T1  | mockSpawn explicit `: ChildProcess` return type | `provider.test.ts`                                |
| T4  | EACCES/ENOENT/ENOTDIR → shouldRetry:false       | `error-classifier.ts`, `error-classifier.test.ts` |

## Remaining: Fix Plan Elements (from 2026-04-26-hermes-fix-plan.md)

### E16: Spawn Pre-Flight Check — Add `verifyHermesBinary` to `binary-resolver.ts`

**Mandate:** Add `verifyHermesBinary(binary)` to `binary-resolver.ts`; call it from `provider.ts`; add tests.

**Source changes required:**

1. `packages/providers/src/hermes/binary-resolver.ts`: Add `import { execFile } from 'child_process'`; add `const execFileAsync = promisify(execFile)`; export `async function verifyHermesBinary(binary: string): Promise<boolean>` that runs `${binary} --version` with 5s timeout.
2. `packages/providers/src/hermes/provider.ts`: After `resolveHermesBinary()` call, `await verifyHermesBinary(binary)`; throw with `INSTALL_INSTRUCTIONS` on false.

**Test changes required:** 3. `packages/providers/src/hermes/binary-resolver.test.ts`: Add `describe('verifyHermesBinary', ...)` with success-path (mock `node:child_process` via `mock.module()` BEFORE dynamic import), failure-path (exec error → false), timeout-path (signal timeout).

**Verifier gates:**

- `bun test packages/providers/src/hermes/binary-resolver.test.ts` → PASS
- `bun test packages/providers/src/hermes/provider.test.ts` → PASS
- `bun --filter @archon/providers type-check` → clean

**Dependency:** Must run sequentially — source file changes before test changes.

### E2: Delete `acp-bridge.ts` + `acp-bridge.test.ts` (dead code)

**Mandate:** Remove unused ACP bridge module.

**Files to delete:**

- `packages/providers/src/hermes/acp-bridge.ts`
- `packages/providers/src/hermes/acp-bridge.test.ts`

**Verifier gates:**

- `bun --filter @archon/providers type-check` → clean (no orphaned imports)
- `bun test packages/providers/src/hermes/` → all pass
- `git diff --stat` confirms only those two files removed

### E4: First-Event Timeout (timeout-utils.ts)

**Mandate:** Add `withFirstEventTimeout` to prevent 20-minute hangs.

**Source changes:**

1. `packages/providers/src/hermes/timeout-utils.ts`: Ensure timer is cleaned up on generator win (clearTimeout).
2. `packages/providers/src/hermes/provider.ts`: Wire `withFirstEventTimeout` into bridge call.

**Test changes:** 3. `packages/providers/src/hermes/timeout-utils.test.ts`: Add test for timer cleanup (no unhandled rejection when event arrives before timeout).

**Verifier gates:**

- `bun test packages/providers/src/hermes/timeout-utils.test.ts` → PASS
- `bun test packages/providers/src/hermes/provider.test.ts` → PASS

---

## Execution Rules (Strict — from v3 plan)

1. **One file per executor** — never both source and test in one executor
2. **No test changes until source is verifier-green**
3. **Max 3 concurrent executors** — but only for independent source files
4. **Verifiers must be fresh agents** — never reuse executor instances

---

## Dispatch Order

```
Batch 1 (independent source files):
  E16-src — binary-resolver.ts + provider.ts (verifyHermesBinary + usage)
  E2-src  — delete acp-bridge.ts + acp-bridge.test.ts
  E4-src  — timeout-utils.ts (fix timer cleanup)

After Batch 1 verifier-green:
  E16-test — binary-resolver.test.ts (verifyHermesBinary tests)
  E4-test  — timeout-utils.test.ts (timer cleanup test)

Final gate:
  bun test packages/providers/src/hermes/ → all pass
  bun --filter @archon/providers type-check → clean
```
