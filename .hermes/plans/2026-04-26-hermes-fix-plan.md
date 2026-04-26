# Hermes Provider Fix Plan — Synthesized from 3 Parallel Audits

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix all critical and high-severity gaps in the Hermes provider, bringing it to parity with Claude/Codex/Pi providers for production use.

**Architecture:** Phase 1 = honest capability flags + dead code removal (fast wins). Phase 2 = timeout + retry + error classification (resilience). Phase 3 = security + code quality (validation, mutable state). Phase 4 = integration tests.

**Tech Stack:** TypeScript, Bun, Archon workflow engine, ACP JSON-RPC 2.0

---

## Context: What the 3 Audits Found

### Audit 1 (Bridge Timeout & Resilience)

- 🔴 P0: No subprocess retry loop
- 🔴 P0: No ACP handshake timeout
- 🔴 P0: No error classification
- 🟡 P1: No first-event timeout
- 🟡 P1: Stderr captured but not used for error enrichment
- 🟡 P1: No spawn pre-flight check
- 🟢 P2: No token/cost emission
- 🟢 P2: No runtime model compatibility check

### Audit 2 (ACP Protocol & Security)

- 🔴 CRITICAL: Untrusted JSON-RPC message parsing (no runtime validation of `SessionUpdateParams`)
- 🔴 HIGH: Mutable module-level `nextId` counter (race condition)
- 🔴 HIGH: No input validation on `sessionId` extraction
- 🟡 MEDIUM: Magic strings / version literals
- 🟡 MEDIUM: `acp-bridge.ts` is dead code (+ its test)
- 🟡 MEDIUM: No retry logic
- 🟡 MEDIUM: No first-event timeout
- 🟡 MEDIUM: `process.env` spread loses type safety
- 🟢 LOW: `createRequest` used for `session/cancel` (should be `createNotification`)
- 🟢 LOW: `sigkillTimeout` not cleared on normal exit
- 🟢 LOW: `lineBuffer` unbounded
- 🟢 LOW: `terminalEmitted` not tested for duplicate prevention
- 🟢 LOW: `INSTALL_INSTRUCTIONS` hardcoded version
- 🟢 LOW: `isHermesModelCompatible` always returns `true`
- ℹ️ INFO: Missing tool chunk support
- ℹ️ INFO: `ContentBlock` union under-utilized
- ℹ️ INFO: Missing `resetAcpIdCounter` edge-case tests
- ℹ️ INFO: `provider.test.ts` mocks `child_process` globally

### Audit 3 (Workflow Engine Integration)

- 🔴 P0: `skills: true` and `fallbackModel: true` declared but NO runtime wiring
- 🔴 P0: No `nodeConfig` translation layer (only `systemPrompt` forwarded)
- 🟡 P1: No retry loop
- 🟡 P1: No first-event timeout
- 🟡 P1: No token/cost/usage metadata on result chunk
- 🟢 P2: No best-effort structured output
- 🟢 P2: No tool call/result chunk mapping
- 🟢 P2: Mock-heavy tests, no real `nodeConfig` integration test

---

## Consolidated Priority Ranking

### 🔴 CRITICAL — Fix First (Production Blockers)

1. **Honest capability flags** — Set `skills: false`, `fallbackModel: false` (1 line, prevents silent feature loss)
2. **Delete dead code** — Remove `acp-bridge.ts` + `acp-bridge.test.ts` (2 files, reduces confusion)
3. **Add ACP request timeout** — Wrap `sendRequest()` in `Promise.race` with 30s timeout (prevents indefinite hangs)
4. **Add first-event timeout** — Wrap `bridgeHermesSession` generator with 60s timeout (prevents the 20-min hang we experienced)
5. **Add subprocess retry loop** — 3 retries with exponential backoff (matches Claude/Codex)
6. **Implement `classifyHermesError`** — Classify rate_limit/auth/crash/unknown (enables smart retry)

### 🟡 HIGH — Fix Second (Reliability & Security)

7. **Runtime validate `SessionUpdateParams`** — Guard the unsafe `as unknown as` cast (prevents crashes on malformed ACP messages)
8. **Validate `sessionId` after `session/new`** — Assert string + non-empty (prevents undefined sessionId in prompt)
9. **Replace mutable `nextId` with per-bridge counter** — Eliminate race condition risk
10. **Enrich errors with stderr context** — Return `stderrLines` from bridge, append to error messages
11. **Add spawn pre-flight check** — `hermes --version` with 5s timeout, surface `INSTALL_INSTRUCTIONS` on failure

### 🟢 MEDIUM — Fix Third (Code Quality)

12. **Extract ACP method constants** — Replace magic strings with named exports from `acp-protocol.ts`
13. **Fix `process.env` type safety** — Filter undefined values in `session-resolver.ts`
14. **Use `createNotification` for `session/cancel`** — Fix protocol correctness
15. **Clear `sigkillTimeout` on normal exit** — Prevent timer leak
16. **Add `MAX_LINE_BUFFER_LENGTH`** — Prevent unbounded memory growth
17. **Add duplicate-exit-event test** — Verify `terminalEmitted` prevents double result chunks

### ℹ️ LOW / Future — Document or Defer

18. **Emit token/cost usage** — Depends on ACP protocol extension
19. **Best-effort structured output** — Pi pattern: prompt schema injection + JSON parse
20. **Tool call/result chunk mapping** — Depends on ACP protocol extension
21. **Runtime model compatibility check** — Currently always-true is acceptable
22. **Add `nodeConfig` translation** — Future feature, requires ACP protocol extension

---

## Execution Methodology: Executor-Verifier Loop

This plan follows the **executor-verifier loop** skill:

- **Max 3 concurrent executors** (never exceed)
- **Never self-verify**: Each executor's work is validated by a **fresh verifier subagent**
- **Context isolation**: Each agent receives only its element's scope
- **Test mandate**: Every element must include a test addition/modification
- **Rollback on failure**: If an element cannot be fixed after 3 iterations, escalate to user
- **Clean workspace**: No temp files or debug prints left behind

### Dependency Graph & Batch Scheduling

```
Batch 1 (independent, disjoint files):
  E1: Task 1 — capabilities.ts
  E2: Task 2 — delete acp-bridge.ts + test
  E3: Task 13 — session-resolver.ts (process.env filter)

Batch 2 (depends on Batch 1, touches event-bridge.ts):
  E4: Task 3 — ACP request timeout (event-bridge.ts)
  E5: Task 14 — createNotification for session/cancel (event-bridge.ts)
  E6: Task 15 — clear sigkillTimeout (event-bridge.ts)

Batch 3 (depends on Batch 2, touches event-bridge.ts + acp-protocol.ts):
  E7: Task 7 — validate SessionUpdateParams (acp-protocol.ts + event-bridge.ts)
  E8: Task 8 — validate sessionId (event-bridge.ts)
  E9: Task 12 — extract ACP constants (acp-protocol.ts + event-bridge.ts)

Batch 4 (depends on Batch 3, touches event-bridge.ts + provider.ts):
  E10: Task 9 — replace mutable nextId (acp-protocol.ts + event-bridge.ts)
  E11: Task 10 — enrich errors with stderr (event-bridge.ts)
  E12: Task 16 — max line buffer (event-bridge.ts)

Batch 5 (depends on Batch 4, touches provider.ts + new files):
  E13: Task 4 — first-event timeout (new timeout-utils.ts + provider.ts)
  E14: Task 6 — classifyHermesError (new error-classifier.ts + provider.ts + event-bridge.ts)
  E15: Task 5 — subprocess retry loop (provider.ts)

Batch 6 (depends on Batch 5, touches provider.ts + binary-resolver.ts):
  E16: Task 11 — spawn pre-flight check (binary-resolver.ts + provider.ts)

Batch 7 (tests only):
  E17: Task 17 — duplicate-exit-event test (event-bridge.test.ts)
```

**Rule**: Elements within a batch are independent (disjoint files or additive changes). Elements across batches may touch the same files — sequential execution required.

### Verification Gate Template

For each element, the verifier runs:

```bash
# 1. Location check (CRITICAL — prevents wrong-repo false greens)
cd /home/d/Desktop/Archon-canonical && pwd | grep -q "Archon-canonical" || exit 1

# 2. Content check — read the specific modified file
read_file("packages/providers/src/hermes/<file>.ts")

# 3. Test gate — run Hermes tests
bun test packages/providers/src/hermes/

# 4. Type-check gate
bun run type-check

# 5. Lint gate
bun run lint

# 6. No temp files check
find packages/providers/src/hermes/ -name "*.tmp" -o -name "*.debug" | wc -l
# Expected: 0
```

**Verifier mandate**: Read-only assessment. Report GREEN or specific issues. Never modify files.

---

## Phase 1: Fast Wins (Batch 1 — 3 Parallel Executors)

### Element E1: Set Honest Capability Flags

**Objective:** Set `skills: false` and `fallbackModel: false` in `HERMES_CAPABILITIES` until runtime wiring exists.

**Files:**

- Modify: `packages/providers/src/hermes/capabilities.ts`

**Expected Change:**

```typescript
export const HERMES_CAPABILITIES: ProviderCapabilities = {
  skills: false, // was true — no runtime wiring
  mcp: false,
  hooks: false,
  agents: false,
  structuredOutput: false,
  toolRestrictions: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  sandbox: false,
  fallbackModel: false, // was true — no runtime wiring
  envInjection: true,
  sessionResume: false,
};
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/capabilities.test.ts` → PASS
2. `git diff packages/providers/src/hermes/capabilities.ts` shows only the two flag changes

**Test Requirement:** Update `capabilities.test.ts` if it asserts the old values.

---

### Element E2: Delete Dead Code (`acp-bridge.ts` + test)

**Objective:** Remove unused `acp-bridge.ts` and `acp-bridge.test.ts`.

**Files:**

- Delete: `packages/providers/src/hermes/acp-bridge.ts`
- Delete: `packages/providers/src/hermes/acp-bridge.test.ts`

**Pre-Flight Check:**

```bash
grep -r "acp-bridge" packages/providers/src/hermes/ --include="*.ts" | grep -v "acp-bridge.ts"
# Expected: No matches (only self-references)
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/` → All tests pass (acp-bridge tests removed, no regressions)
2. `ls packages/providers/src/hermes/acp-bridge.ts` → File not found

**Test Requirement:** N/A (deletion only)

---

### Element E3: Fix `process.env` Type Safety

**Objective:** Filter undefined values when spreading `process.env`.

**Files:**

- Modify: `packages/providers/src/hermes/session-resolver.ts`

**Expected Change:**

```typescript
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]): v is string => typeof v === 'string')
);
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/session-resolver.test.ts` → PASS
2. `git diff packages/providers/src/hermes/session-resolver.ts` shows only the filter change

**Test Requirement:** Add test asserting `undefined` values are filtered out.

---

## Phase 2: Resilience (Batches 2-5)

### Element E4: Add ACP Request Timeout

**Objective:** Wrap `sendRequest()` in `event-bridge.ts` with a `Promise.race` timeout.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Expected Change:**

```typescript
function sendRequest<T>(req: JsonRpcRequest, timeoutMs = 30000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Hermes ACP request '${req.method}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(req.id, result => {
      clearTimeout(timer);
      resolve(result as T);
    });

    writeLine(serializeMessage(req));
  });
}
```

Update all `sendRequest` calls with appropriate timeouts:

- `sendRequest(initReq, 30000)`
- `sendRequest(sessionReq, 30000)`
- `sendRequest(promptReq, 120000)`

Add env overrides at top of file:

```typescript
const REQUEST_TIMEOUT_MS = Number(process.env.ARCHON_HERMES_REQUEST_TIMEOUT_MS) || 30000;
const PROMPT_TIMEOUT_MS = Number(process.env.ARCHON_HERMES_PROMPT_TIMEOUT_MS) || 120000;
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS (including new timeout test)
2. New test simulates slow response, verifies timeout fires with correct message

**Test Requirement:** Add test that mocks a child process that never responds, asserts `rejects.toThrow(/timed out/)`.

---

### Element E5: Use `createNotification` for `session/cancel`

**Objective:** Fix protocol correctness by using notification instead of request for fire-and-forget cancel.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
const cancelNotif = createNotification('session/cancel', { sessionId });
writeLine(serializeMessage(cancelNotif));
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. Abort signal test still works correctly

**Test Requirement:** Update abort test to assert `createNotification` is used (inspect serialized message).

---

### Element E6: Clear `sigkillTimeout` on Normal Exit

**Objective:** Prevent timer leak when process exits normally after abort.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
childProcess.on('exit', (code, signal) => {
  if (sigkillTimeout) {
    clearTimeout(sigkillTimeout);
    sigkillTimeout = undefined;
  }
  // ... rest of handler
});
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. No timer leaks in abort + normal exit sequence

**Test Requirement:** Add test that emits abort signal then normal exit, asserts no uncaught errors.

---

### Element E7: Runtime Validate `SessionUpdateParams`

**Objective:** Add `isSessionUpdateParams()` type guard to prevent crashes on malformed ACP messages.

**Files:**

- Modify: `packages/providers/src/hermes/acp-protocol.ts`
- Modify: `packages/providers/src/hermes/acp-protocol.test.ts`
- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
export function isSessionUpdateParams(value: unknown): value is SessionUpdateParams {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string') return false;
  if (typeof obj.update !== 'object' || obj.update === null) return false;
  const update = obj.update as Record<string, unknown>;
  if (typeof update.sessionUpdate !== 'string') return false;
  if (update.content !== undefined && update.content !== null) {
    if (typeof update.content !== 'object') return false;
    const content = update.content as Record<string, unknown>;
    if (typeof content.text !== 'string') return false;
  }
  return true;
}
```

Use in `event-bridge.ts`:

```typescript
if (notif.method === 'session/update' && notif.params) {
  if (!isSessionUpdateParams(notif.params)) {
    getLog().warn({ params: notif.params }, 'hermes.invalid_session_update');
    continue;
  }
  const params = notif.params;
  // ... rest of handler
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/acp-protocol.test.ts` → PASS (including new validation tests)
2. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
3. Malformed message test passes (invalid params are skipped, not crashed)

**Test Requirement:** Add tests for `isSessionUpdateParams` with valid, null content, missing fields, and wrong types.

---

### Element E8: Validate `sessionId` After `session/new`

**Objective:** Assert `sessionId` is a non-empty string after extraction.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Expected Change:**

```typescript
sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
if (typeof sessionId !== 'string' || sessionId.length === 0) {
  throw new Error(
    `Hermes ACP session/new returned invalid sessionId: ${JSON.stringify(sessionResp.result)}`
  );
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. Test with invalid sessionId response asserts correct error message

**Test Requirement:** Add test that mocks `session/new` response with `sessionId: null`, asserts `rejects.toThrow(/invalid sessionId/)`.

---

### Element E9: Extract ACP Method Constants

**Objective:** Replace magic strings with named exports from `acp-protocol.ts`.

**Files:**

- Modify: `packages/providers/src/hermes/acp-protocol.ts`
- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
export const JSONRPC_VERSION = '2.0';
export const ACP_METHOD_INIT = 'initialize';
export const ACP_METHOD_SESSION_NEW = 'session/new';
export const ACP_METHOD_SESSION_PROMPT = 'session/prompt';
export const ACP_METHOD_SESSION_CANCEL = 'session/cancel';
export const ACP_NOTIFICATION_SESSION_UPDATE = 'session/update';
export const ACP_AGENT_MESSAGE_CHUNK = 'agent_message_chunk';
export const ACP_AGENT_THOUGHT_CHUNK = 'agent_thought_chunk';
```

Replace all raw method strings in `event-bridge.ts` with constants.

**Verification Gate:**

1. `bun test packages/providers/src/hermes/` → All tests pass
2. `grep -n "'initialize'\|'session/new'\|'session/prompt'" packages/providers/src/hermes/event-bridge.ts` → No raw literals remain

**Test Requirement:** N/A (refactoring only, existing tests cover behavior)

---

### Element E10: Replace Mutable `nextId` with Per-Bridge Counter

**Objective:** Eliminate module-level mutable state by passing an ID generator into `createRequest`.

**Files:**

- Modify: `packages/providers/src/hermes/acp-protocol.ts`
- Modify: `packages/providers/src/hermes/acp-protocol.test.ts`
- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
export interface AcpIdGenerator {
  next(): number;
}

export function createAcpIdGenerator(start = 1): AcpIdGenerator {
  let id = start;
  return { next: () => id++ };
}

export function createRequest(
  method: string,
  params?: Record<string, unknown>,
  idGen?: AcpIdGenerator
): JsonRpcRequest {
  return { jsonrpc: '2.0', id: idGen?.next() ?? 1, method, params };
}
```

Use in `event-bridge.ts`:

```typescript
const idGen = createAcpIdGenerator();
const initReq = createRequest(ACP_METHOD_INIT, { ... }, idGen);
const sessionReq = createRequest(ACP_METHOD_SESSION_NEW, {}, idGen);
const promptReq = createRequest(ACP_METHOD_SESSION_PROMPT, { ... }, idGen);
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/acp-protocol.test.ts` → PASS
2. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
3. IDs are sequential within a bridge session

**Test Requirement:** Update `acp-protocol.test.ts` to use `createAcpIdGenerator`, add test for sequential IDs.

---

### Element E11: Enrich Errors with Stderr Context

**Objective:** Return `stderrLines` from bridge and append to error messages.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Expected Change:**

```typescript
function buildErrorMessage(base: string, stderrLines: string[]): string {
  if (stderrLines.length === 0) return base;
  const context = stderrLines.slice(-3).join('; ');
  return `${base} (stderr: ${context})`;
}
```

Use in error/exit handlers to include last 3 stderr lines in thrown errors.

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. Error messages include stderr context

**Test Requirement:** Add test that mocks stderr output, asserts error message contains stderr context.

---

### Element E12: Add `MAX_LINE_BUFFER_LENGTH`

**Objective:** Prevent unbounded memory growth from malicious/buggy Hermes output.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.ts`
- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Expected Change:**

```typescript
const MAX_LINE_BUFFER_LENGTH = 1024 * 1024; // 1 MB

// In stdout handler:
if (lineBuffer.length > MAX_LINE_BUFFER_LENGTH) {
  getLog().warn({ bufferLength: lineBuffer.length }, 'hermes.line_buffer_overflow');
  lineBuffer = '';
  queue.push({
    kind: 'chunk',
    chunk: { type: 'system', content: 'Warning: Hermes output line exceeded maximum length' },
  });
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. Buffer overflow test passes

**Test Requirement:** Add test that feeds oversized line without newline, asserts buffer is reset and warning chunk is emitted.

---

### Element E13: Add First-Event Timeout

**Objective:** Wrap the `bridgeHermesSession` generator in `provider.ts` with a first-event timeout.

**Files:**

- Create: `packages/providers/src/hermes/timeout-utils.ts`
- Create: `packages/providers/src/hermes/timeout-utils.test.ts`
- Modify: `packages/providers/src/hermes/provider.ts`
- Modify: `packages/providers/src/hermes/provider.test.ts`

**Expected Change:**

```typescript
// timeout-utils.ts
export async function* withFirstEventTimeout<T>(
  gen: AsyncGenerator<T>,
  timeoutMs: number,
  context: string
): AsyncGenerator<T> {
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Hermes subprocess produced no output within ${timeoutMs}ms (${context})`));
    }, timeoutMs);
  });

  let first = true;
  for await (const item of gen) {
    if (first) {
      first = false;
    }
    yield item;
  }
}
```

Use in `provider.ts`:

```typescript
const FIRST_EVENT_TIMEOUT_MS = Number(process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS) || 60000;

async *sendQuery(...) {
  const bridge = bridgeHermesSession(child, message, session, abortSignal);
  yield* withFirstEventTimeout(bridge, FIRST_EVENT_TIMEOUT_MS, 'first ACP event');
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/timeout-utils.test.ts` → PASS
2. `bun test packages/providers/src/hermes/provider.test.ts` → PASS (including new timeout test)
3. Hanging child process test asserts `rejects.toThrow(/no output within/)`

**Test Requirement:** Add test for `withFirstEventTimeout` utility, add test in `provider.test.ts` with hanging mock child.

---

### Element E14: Implement `classifyHermesError`

**Objective:** Create error classification function for Hermes subprocess errors.

**Files:**

- Create: `packages/providers/src/hermes/error-classifier.ts`
- Create: `packages/providers/src/hermes/error-classifier.test.ts`
- Modify: `packages/providers/src/hermes/provider.ts`
- Modify: `packages/providers/src/hermes/event-bridge.ts`

**Expected Change:**

```typescript
// error-classifier.ts
export type HermesErrorClass = 'rate_limit' | 'auth' | 'crash' | 'unknown';

export interface ClassifiedError {
  errorClass: HermesErrorClass;
  shouldRetry: boolean;
  enrichedMessage: string;
}

export function classifyHermesError(
  message: string,
  stderrLines: string[],
  exitCode: number | null
): ClassifiedError {
  const stderr = stderrLines.join('\n').toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('429') ||
    stderr.includes('rate limit')
  ) {
    return {
      errorClass: 'rate_limit',
      shouldRetry: true,
      enrichedMessage: `Hermes rate limit: ${message}`,
    };
  }
  if (
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('invalid api key') ||
    stderr.includes('unauthorized')
  ) {
    return {
      errorClass: 'auth',
      shouldRetry: false,
      enrichedMessage: `Hermes auth error: ${message}`,
    };
  }
  if (
    (exitCode !== 0 && exitCode !== null) ||
    lowerMessage.includes('panic') ||
    stderr.includes('panic')
  ) {
    return {
      errorClass: 'crash',
      shouldRetry: true,
      enrichedMessage: `Hermes crash (exit ${exitCode}): ${message}`,
    };
  }
  if (lowerMessage.includes('timed out') || lowerMessage.includes('timeout')) {
    return {
      errorClass: 'rate_limit',
      shouldRetry: true,
      enrichedMessage: `Hermes timeout: ${message}`,
    };
  }
  return { errorClass: 'unknown', shouldRetry: false, enrichedMessage: `Hermes error: ${message}` };
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/error-classifier.test.ts` → PASS
2. Classifier correctly identifies rate_limit, auth, crash, timeout, unknown

**Test Requirement:** Add tests for each error class and edge cases.

---

### Element E15: Add Subprocess Retry Loop

**Objective:** Wrap `spawn` + `bridgeHermesSession` in a retry loop with exponential backoff.

**Files:**

- Modify: `packages/providers/src/hermes/provider.ts`
- Modify: `packages/providers/src/hermes/provider.test.ts`

**Expected Change:**

```typescript
const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

async *sendQuery(message, options) {
  const log = getLog();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn({ attempt, delayMs: delay }, 'hermes.retrying_subprocess');
        await new Promise(r => setTimeout(r, delay));
      }

      const binary = resolveHermesBinary(this.config);
      if (!binary) {
        throw new Error(`Hermes binary not found. ${INSTALL_INSTRUCTIONS}`);
      }

      const session = resolveHermesSession(options);
      const child = spawn(binary, ['acp'], {
        cwd: session.cwd,
        env: { ...process.env, ...session.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.unref();

      const bridge = bridgeHermesSession(child, message, session, options?.abortSignal);
      yield* withFirstEventTimeout(bridge, FIRST_EVENT_TIMEOUT_MS, 'first ACP event');
      return;

    } catch (err) {
      const error = err as Error;
      const { errorClass, shouldRetry } = classifyHermesError(error.message, [], 0);

      if (!shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) {
        log.error({ err: error, attempt, errorClass }, 'hermes.query_failed');
        throw error;
      }

      lastError = error;
      log.warn({ err: error, attempt, errorClass }, 'hermes.subprocess_error_retrying');
    }
  }

  throw lastError ?? new Error('Hermes query failed after retries');
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/provider.test.ts` → PASS (including new retry test)
2. Retry test asserts 2 spawns for transient failure, 1 for success

**Test Requirement:** Add test that mocks first spawn failing with EPIPE, second spawn succeeding.

---

### Element E16: Add Spawn Pre-Flight Check

**Objective:** Verify `hermes --version` works before first use, surface install instructions on failure.

**Files:**

- Modify: `packages/providers/src/hermes/binary-resolver.ts`
- Modify: `packages/providers/src/hermes/binary-resolver.test.ts`
- Modify: `packages/providers/src/hermes/provider.ts`

**Expected Change:**

```typescript
// binary-resolver.ts
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function verifyHermesBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
```

Use in `provider.ts`:

```typescript
const binary = resolveHermesBinary(this.config);
if (!binary) {
  throw new Error(`Hermes binary not found. ${INSTALL_INSTRUCTIONS}`);
}

const isValid = await verifyHermesBinary(binary);
if (!isValid) {
  throw new Error(
    `Hermes binary '${binary}' is not executable or not working. ${INSTALL_INSTRUCTIONS}`
  );
}
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/binary-resolver.test.ts` → PASS
2. `bun test packages/providers/src/hermes/provider.test.ts` → PASS
3. Pre-flight failure test asserts install instructions in error message

**Test Requirement:** Add test for `verifyHermesBinary` with mock `execFile`.

---

## Phase 3: Tests (Batch 7)

### Element E17: Add Duplicate-Exit-Event Test

**Objective:** Verify `terminalEmitted` prevents double result chunks.

**Files:**

- Modify: `packages/providers/src/hermes/event-bridge.test.ts`

**Expected Change:**

```typescript
test('emits only one terminal result on error then exit', async () => {
  const mockChild = createMockChildProcess();
  const gen = bridgeHermesSession(mockChild, { type: 'text', text: 'hello' });

  mockChild.stderr.emit('data', Buffer.from('error text\n'));
  mockChild.emit('error', new Error('spawn error'));
  mockChild.emit('exit', 1, null);

  const chunks = [];
  for await (const chunk of gen) chunks.push(chunk);

  const resultChunks = chunks.filter(c => c.type === 'result');
  expect(resultChunks.length).toBe(1);
});
```

**Verification Gate:**

1. `bun test packages/providers/src/hermes/event-bridge.test.ts` → PASS
2. Duplicate event test passes

**Test Requirement:** N/A (this IS the test)

---

## Phase 4: Verification Gates (After All Batches Complete)

### Final Gate 1: Type Check

```bash
cd /home/d/Desktop/Archon-canonical && bun run type-check
```

Expected: PASS (no errors)

### Final Gate 2: Lint

```bash
cd /home/d/Desktop/Archon-canonical && bun run lint
```

Expected: PASS (zero warnings)

### Final Gate 3: Hermes Tests

```bash
cd /home/d/Desktop/Archon-canonical && bun test packages/providers/src/hermes/
```

Expected: All tests pass

### Final Gate 4: Full Test Suite

```bash
cd /home/d/Desktop/Archon-canonical && bun run test
```

Expected: All packages pass

### Final Gate 5: Workflow Validation

```bash
cd /home/d/Desktop/Archon-canonical && bun run cli validate workflows
```

Expected: VALID

### Final Gate 6: No Temp Files

```bash
cd /home/d/Desktop/Archon-canonical && find packages/providers/src/hermes/ -name "*.tmp" -o -name "*.debug" -o -name "test_*.py" | wc -l
```

Expected: 0

---

## Execution Rules

1. **Max 3 concurrent executors** at any time
2. **Never self-verify**: Each executor's work is validated by a fresh verifier subagent
3. **Context isolation**: Each agent receives only its element's scope and file paths
4. **Test mandate**: Every element must include a test addition or modification
5. **Rollback on failure**: If an element cannot be fixed after 3 executor-verifier iterations, escalate to user
6. **Clean workspace**: No temp files, debug prints, or half-finished changes
7. **Absolute paths**: All file references use absolute paths to prevent wrong-repo issues
8. **Location check**: Every verifier gate starts with `pwd | grep -q "Archon-canonical"`

---

## Principles

- **DRY:** Timeout utility is shared, error classifier is reusable
- **YAGNI:** No `nodeConfig` translation yet (requires ACP protocol extension)
- **TDD:** Every element includes a test
- **Fail Fast:** Timeouts throw clear errors with diagnostic info
- **No Regressions:** All existing tests must still pass

---

## Remember

```
Fresh subagent per task
Two-stage review every time
Spec compliance FIRST
Code quality SECOND
Never skip reviews
Catch issues early
```
