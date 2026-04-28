# Hermes Parallel Execution — Companion Document

> Date: 2026-04-28
> Master Plan: .hermes/plans/2026-04-28-hermes-master-plan.md
> Phase 1 Detail: .hermes/plans/2026-04-28-phase1-detailed-execution.md

This document contains all extra context, code templates, risk register,
and detailed specifications that don't fit in the master plan.

---

## A. Code Templates

### A.1 ConcurrencyLock (packages/providers/src/hermes/concurrency-lock.ts)

```typescript
export class ConcurrencyLock {
  private currentCount = 0;
  private readonly maxConcurrency: number;
  private readonly waitQueue: Array<() => void> = [];

  constructor(config?: { maxConcurrency?: number }) {
    const envVal = process.env.ARCHON_HERMES_MAX_CONCURRENCY;
    const parsed = envVal ? Number(envVal) : undefined;
    this.maxConcurrency =
      config?.maxConcurrency ??
      (Number.isFinite(parsed) && (parsed as number) > 0 ? (parsed as number) : 1);
  }

  async acquire(): Promise<void> {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return;
    }
    return new Promise<void>(resolve => {
      this.waitQueue.push(() => {
        this.currentCount++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.currentCount <= 0) return; // underflow guard
    this.currentCount--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  get active(): number {
    return this.currentCount;
  }
  get pending(): number {
    return this.waitQueue.length;
  }
}
```

### A.2 Provider Integration Pattern (provider.ts)

```typescript
// Module-level (after imports):
import { ConcurrencyLock } from './concurrency-lock';
import { classifyHermesError } from './error-classifier';

const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const defaultConcurrencyLock = new ConcurrencyLock();

// In HermesProvider class:
constructor(
  private pool: HermesSessionPool = defaultSessionPool,
  private lock: ConcurrencyLock = defaultConcurrencyLock
) {}

async *sendQuery(...): AsyncGenerator<MessageChunk> {
  await this.lock.acquire();
  try {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (options?.abortSignal?.aborted) throw new Error('Query aborted');
      try {
        yield* this._sendQueryOnce(prompt, cwd, resumeSessionId, options);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const classified = classifyHermesError(error.message);
        if (!classified.shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) throw error;
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs }, 'hermes.retrying_query');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = error;
      }
    }
    throw lastError ?? new Error('Hermes query failed after retries');
  } finally {
    this.lock.release();
  }
}
```

### A.3 HermesAcpClient (packages/providers/src/hermes/acp-client.ts)

Encapsulates child process + ACP protocol + handler management.
Key methods: init(), initWithSessionId(), prompt(), dispose(), isAlive().
Exposes childProcess getter for backward-compatible pool migration.

---

## B. Risk Register

| Risk                                                        | Impact | Mitigation                                                                              |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| provider.ts merge conflict between Phase 2 and 3            | High   | Phase 3 applied ON TOP of Phase 2. \_sendQueryOnce extraction creates clean seam.       |
| HermesAcpClient.init() double-prompt                        | Medium | Use empty prompt for init, or refactor to separate init bridge from prompt bridge.      |
| event-bridge.ts handler leak not addressed in Phase 3       | Medium | Verify Phase 1 Gate 1 passes before starting Phase 3.                                   |
| session-pool.test.ts needs updates for PooledSession change | Low    | Update mockChildProcess to mock HermesAcpClient. Add mockHermesClient() helper.         |
| state.db contention persists even with ConcurrencyLock      | Low    | Lock serializes at Archon level. If single process still hangs, investigate Hermes CLI. |

---

## C. File Overlap Matrix

| File                | B1              | B2                    | B3           | B4          | Resolution       |
| ------------------- | --------------- | --------------------- | ------------ | ----------- | ---------------- |
| event-bridge.ts     | handlers        | —                     | —            | —           | B1 only          |
| acp-protocol.ts     | ID counter      | —                     | —            | —           | B1 only          |
| session-pool.ts     | inUse           | —                     | AcpClient    | —           | Sequential B1→B3 |
| provider.ts         | acquire/release | ConcurrencyLock+retry | AcpClient    | diagnostics | Sequential all   |
| concurrency-lock.ts | —               | CREATE                | —            | —           | B2 only          |
| acp-client.ts       | —               | —                     | CREATE       | —           | B3 only          |
| error-classifier.ts | —               | —                     | —            | wire        | B4 only          |
| timeout-utils.ts    | —               | —                     | —            | diagnostics | B4 only          |
| package.json        | —               | add test ref          | add test ref | —           | Sequential B2→B3 |

---

## D. Gate Verifier Specifications

### Gate 0 (Prerequisites — before any batch)

```
STEP [1]: bun test packages/providers/src/hermes/ --timeout 60000
  Expected: all pass, 0 failures

STEP [2]: git status --short packages/providers/src/hermes/
  Expected: no uncommitted changes

STEP [3]: bun run type-check
  Expected: exit 0
```

### Gate 1 (after Batch 1: handler cleanup + ID counter + pool acquire/release)

```
STEP [1]: grep -c "removeListener" packages/providers/src/hermes/event-bridge.ts
  Expected: >= 4

STEP [2]: grep -c "globalAcpIdCounter" packages/providers/src/hermes/acp-protocol.ts
  Expected: >= 1

STEP [3]: grep -c "acquire\|release\|inUse" packages/providers/src/hermes/session-pool.ts
  Expected: >= 3

STEP [4]: bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
  Expected: all pass

STEP [5]: bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
  Expected: all pass

STEP [6]: bun test packages/providers/src/hermes/acp-protocol.test.ts --timeout 30000
  Expected: all pass

STEP [7]: bun run type-check
  Expected: exit 0
```

### Gate 2 (after Batch 2: ConcurrencyLock + provider integration)

```
STEP [1]: grep -c "export class ConcurrencyLock" packages/providers/src/hermes/concurrency-lock.ts
  Expected: 1

STEP [2]: grep -c "lock.acquire\|lock.release" packages/providers/src/hermes/provider.ts
  Expected: >= 2

STEP [3]: grep -c "MAX_SUBPROCESS_RETRIES\|shouldRetry" packages/providers/src/hermes/provider.ts
  Expected: >= 2

STEP [4]: grep -c "concurrency-lock.test.ts" packages/providers/package.json
  Expected: 1

STEP [5]: bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
  Expected: all pass

STEP [6]: bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
  Expected: all pass

STEP [7]: bun run type-check
  Expected: exit 0
```

### Gate 3 (after Batch 3: HermesAcpClient + provider refactor)

```
STEP [1]: grep -c "export class HermesAcpClient" packages/providers/src/hermes/acp-client.ts
  Expected: 1

STEP [2]: grep -c "client: HermesAcpClient" packages/providers/src/hermes/session-pool.ts
  Expected: 1

STEP [3]: grep -c "childProcess: ChildProcess" packages/providers/src/hermes/session-pool.ts
  Expected: 0

STEP [4]: grep -c "new HermesAcpClient" packages/providers/src/hermes/provider.ts
  Expected: >= 1

STEP [5]: grep -c "spawn(hermesBinary" packages/providers/src/hermes/provider.ts
  Expected: 0

STEP [6]: grep -c "lock.acquire\|lock.release" packages/providers/src/hermes/provider.ts
  Expected: >= 2 (preserved from Phase 2)

STEP [7]: bun test packages/providers/src/hermes/ --timeout 60000
  Expected: all pass

STEP [8]: bun run type-check
  Expected: exit 0

STEP [9]: bun run lint
  Expected: 0 warnings
```

### Gate 4 (after Batch 4: retry + diagnostics + cleanup)

```
STEP [1]: bun run validate
  Expected: exit 0 (type-check + lint + format + tests all pass)

STEP [2]: bun run cli workflow run e2e-hermes-smoke --no-worktree
  Expected: HERMES_SMOKE_OK in output

STEP [3]: bun run cli workflow run hermes-pr-verifier --no-worktree
  Expected: completes without hang (may have findings, but no hang)
```

---

## E. Test Registration

New test files to add to packages/providers/package.json test script:

- `src/hermes/concurrency-lock.test.ts` (Batch 2)
- `src/hermes/acp-client.test.ts` (Batch 3)

Add to the existing hermes test chain (same bun invocation for mock.module isolation).

---

## F. Commit Convention

```
fix(hermes): <bug fix description>
feat(hermes): <new feature description>
refactor(hermes): <refactor description>
test(hermes): <test addition description>
chore(hermes): <cleanup/maintenance>
```

All commits on dev branch. Never commit to main.
Each commit must pass type-check independently (safe bisect).

---

## G. Verification Commands Quick Reference

```bash
# Type-check
bun run type-check

# Lint
bun run lint

# Format
bun run format:check

# Tests (per-file)
bun test packages/providers/src/hermes/event-bridge.test.ts --timeout 30000
bun test packages/providers/src/hermes/session-pool.test.ts --timeout 30000
bun test packages/providers/src/hermes/provider.test.ts --timeout 60000
bun test packages/providers/src/hermes/concurrency-lock.test.ts --timeout 30000
bun test packages/providers/src/hermes/acp-client.test.ts --timeout 30000
bun test packages/providers/src/hermes/acp-protocol.test.ts --timeout 30000
bun test packages/providers/src/hermes/error-classifier.test.ts --timeout 30000

# Full validate
bun run validate

# E2E
bun run cli workflow run e2e-hermes-smoke --no-worktree
bun run cli workflow run hermes-pr-verifier --no-worktree
```
