# Hermes Provider — Post-Remediation Fix Plan

> **Source**: 6 verifier reports from 2-round overlapping audit (2026-04-27)
> **Method**: Executor-verifier loop. Max 3 concurrent executors. ONE file per executor.
> Test changes for a source file run ONLY after that source file is verifier-green.

## Audit Sources

| Report                              | Focus                                        | Key Findings                             |
| ----------------------------------- | -------------------------------------------- | ---------------------------------------- |
| verification-code-standards         | CLAUDE.md conventions, lint, type safety     | 3 IMPORTANT, 3 MINOR                     |
| verification-online-docs            | ACP + JSON-RPC 2.0 spec compliance           | 1 CRITICAL, 4 IMPORTANT, 5 MINOR         |
| verification-cross-provider         | Master synthesis cross-check, consistency    | 4 remaining I-items, 3 minor divergences |
| verification-security               | Env handling, credential leakage, redaction  | 2 MEDIUM, 2 LOW                          |
| verification-test-coverage          | New code paths, error paths, edge cases      | 21 untested paths, 6 weak assertions     |
| verification-integration-edge-cases | IAgentProvider contract, protocol edge cases | 4 LOW findings, 2 design notes           |

---

## Execution Rules

1. Max 3 concurrent executors per phase
2. ONE file per executor (source changes only; test changes come after source verifier-green)
3. Every executor gets: exact file path, line numbers, expected change, verification gate
4. Verifiers are always fresh agents — never reuse executors as verifiers
5. If a verifier finds issues, dispatch a fresh executor with the issues as context
6. Between phases: run full `bun test packages/providers/src/hermes/` + `bun --filter @archon/providers type-check`

---

## Phase 1: Critical Bug Fix (1 item)

> Gate: type-check + tests pass

### T1.1 — Fix version negotiation field name (CRITICAL)

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: 344-354
**Issue**: Code checks `protocol_version` (snake_case) but ACP spec uses `protocolVersion` (camelCase). Version negotiation is silently skipped — incompatible protocol versions are never detected.
**Source**: verification-online-docs C1

**Change**:

```typescript
// BEFORE (line 344-348):
if (
  'result' in initResp &&
  typeof (initResp.result as Record<string, unknown>).protocol_version === 'number'
) {
  const protoVersion = (initResp.result as Record<string, unknown>).protocol_version as number;

// AFTER:
if (
  'result' in initResp &&
  typeof (initResp.result as Record<string, unknown>).protocolVersion === 'number'
) {
  const protoVersion = (initResp.result as Record<string, unknown>).protocolVersion as number;
```

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/`

---

## Phase 2: Code Quality + Security (6 items, 3 parallel batches)

> Gate: type-check + lint (0 warnings) + tests pass

### Batch 2A (3 parallel, independent files)

### T2.1 — Fix `any` usage in binary-resolver.test.ts

**File**: `packages/providers/src/hermes/binary-resolver.test.ts`
**Lines**: 113, 123, 132, 141, 143
**Issue**: 6 un-justified `any` usages would fail `--max-warnings 0`
**Source**: verification-code-standards IMPORTANT-1

**Changes**:

- Line 113: `mockExecFile: (...args: any[]) => any` → `mockExecFile: (...args: unknown[]) => unknown`
- Lines 123/132/141: `options: any, callback: any` → `options: ExecFileOptions | null | undefined, callback: (error: Error | null, stdout: string, stderr: string) => void` (import `ExecFileOptions` from `child_process`)
- Line 143: `(err as any).killed = true` → `const typedErr = err as Error & { killed?: boolean }; typedErr.killed = true;`

**Verify**: `cd packages/providers && npx eslint src/hermes/binary-resolver.test.ts --max-warnings 0`

### T2.2 — Remove unused `sig` variable in event-bridge.test.ts

**File**: `packages/providers/src/hermes/event-bridge.test.ts`
**Line**: ~165
**Issue**: `sig` computed but never used — triggers `no-unused-vars`
**Source**: verification-code-standards IMPORTANT-2

**Change**: Remove the `const sig = ...` line. The code below uses `signal` directly.

**Verify**: `cd packages/providers && npx eslint src/hermes/event-bridge.test.ts --max-warnings 0`

### T2.3 — Remove unused `sig` variable in provider.test.ts

**File**: `packages/providers/src/hermes/provider.test.ts`
**Line**: ~129
**Issue**: Same as T2.2
**Source**: verification-code-standards IMPORTANT-2

**Change**: Remove the `const sig = ...` line.

**Verify**: `cd packages/providers && npx eslint src/hermes/provider.test.ts --max-warnings 0`

### Batch 2B (3 parallel, independent files)

### T2.4 — Fix unchecked `as string` cast in event-bridge.ts

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: 367-370
**Issue**: `sessionId = (...).sessionId as string` — asserts string before validation
**Source**: verification-code-standards IMPORTANT-3

**Change**:

```typescript
// BEFORE:
if ('result' in sessionResp) {
  sessionId = (sessionResp.result as Record<string, unknown>).sessionId as string;
}
if (!sessionId || typeof sessionId !== 'string' || sessionId.length === 0) {

// AFTER:
if ('result' in sessionResp) {
  const result = sessionResp.result as Record<string, unknown>;
  if (typeof result.sessionId === 'string') {
    sessionId = result.sessionId;
  }
}
if (!sessionId) {
```

Also fix the `stopReason` cast (lines 392-395):

```typescript
// BEFORE:
? ((promptResp.result as Record<string, unknown>).stopReason as string)
// AFTER:
? ((promptResp.result as Record<string, unknown>).stopReason as string | undefined)
```

**Verify**: `bun --filter @archon/providers type-check`

### T2.5 — Fix redundant process.env re-spread in provider.ts

**File**: `packages/providers/src/hermes/provider.ts`
**Line**: ~131
**Issue**: `env: { ...process.env, ...session.env }` — `session.env` already contains all of process.env. Re-spread re-introduces `undefined` values.
**Source**: verification-cross-provider I18, verification-security H5

**Change**: `env: { ...process.env, ...session.env }` → `env: session.env`

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/provider.test.ts`

### T2.6 — Strengthen redactSecrets() pattern coverage

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: 29-33
**Issue**: Misses prefixed env vars like `OPENAI_API_KEY=xxx`, `Authorization:` headers, `AWS_SECRET_ACCESS_KEY=xxx`
**Source**: verification-security H2

**Change**: Extend the regex to catch env-var prefixed patterns:

```typescript
function redactSecrets(text: string): string {
  return text
    .replace(/\b(key|token|api_key|password|secret|auth)\b=\S+/gi, '$1=[REDACTED]')
    .replace(/"(key|token|api_key|password|secret|auth)":\s*"[^"]*/gi, '"$1":"[REDACTED]')
    .replace(
      /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GITHUB_TOKEN|NPM_TOKEN|DATABASE_URL|POSTGRES_PASSWORD)=\S+/gi,
      '$1=[REDACTED]'
    )
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]');
}
```

**Verify**: `bun --filter @archon/providers type-check`

### Phase 2 Gate

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check
bun test packages/providers/src/hermes/
cd packages/providers && npx eslint src/ --max-warnings 0
```

---

## Phase 3: Protocol Compliance (3 items, 3 parallel)

> Gate: type-check + tests pass

### T3.1 — Widen `id` type to `string | number` for JSON-RPC 2.0 compliance

**File**: `packages/providers/src/hermes/acp-protocol.ts`
**Lines**: 17-18 (JsonRpcRequest), 24-25 (JsonRpcSuccess), 31-32 (JsonRpcError), 119, 125 (parseMessage)
**Issue**: JSON-RPC 2.0 spec allows `id` to be String, Number, or NULL. Current code restricts to `number`.
**Source**: verification-online-docs I1

**Changes**:

- Interfaces: `id: number` → `id: string | number` in JsonRpcRequest, JsonRpcSuccess, JsonRpcError
- createRequest: `idGenerator.next()` returns `number` — keep as-is (requests always use numeric ids)
- parseMessage: `typeof record.id !== 'number'` → `typeof record.id !== 'number' && typeof record.id !== 'string'`
- Also update `AcpIdGenerator.next()` return type and `pendingRequestId` type in event-bridge.ts

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/`

### T3.2 — Send explicit default clientCapabilities

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Line**: ~338
**Issue**: Sends `clientCapabilities: {}` — spec defines explicit defaults
**Source**: verification-online-docs I4

**Change**:

```typescript
clientCapabilities: {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
},
```

**Verify**: `bun --filter @archon/providers type-check`

### T3.3 — Log unrecognized session/update types

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: 158-168
**Issue**: Unknown `sessionUpdate` types are silently dropped. Per ACP spec, new types may be added.
**Source**: verification-online-docs M2

**Change**: Add an `else` clause after the `agent_thought_chunk` check:

```typescript
} else {
  getLog().debug({ sessionUpdate: update.sessionUpdate }, 'acp.unrecognized_session_update');
}
```

**Verify**: `bun --filter @archon/providers type-check`

---

## Phase 4: Test Coverage (7 items, batched by file dependency)

> Gate: 135+ tests pass, 0 fail

### Batch 4A (3 parallel, independent test files)

### T4.1 — Add redactSecrets() direct tests

**File**: `packages/providers/src/hermes/event-bridge.test.ts` (add to existing describe block)
**Issue**: Security-sensitive function has ZERO test coverage
**Source**: verification-test-coverage P0-1

**Tests to add**:

```typescript
describe('redactSecrets', () => {
  // Import or access redactSecrets — may need to export it for testing
  // OR test indirectly via stderr handling in bridge tests

  test('redacts key= pattern', () => { ... });
  test('redacts api_key in JSON', () => { ... });
  test('redacts Authorization header', () => { ... });
  test('redacts OPENAI_API_KEY= pattern', () => { ... });
  test('preserves non-secret content', () => { ... });
});
```

Note: `redactSecrets` is currently a private function. Either export it for testing or test indirectly by verifying stderr output in bridge error chunks is redacted.

**Verify**: `bun test packages/providers/src/hermes/event-bridge.test.ts`

### T4.2 — Add statSync error path tests in session-resolver

**File**: `packages/providers/src/hermes/session-resolver.test.ts`
**Issue**: ENOENT and not-a-directory error paths untested
**Source**: verification-test-coverage P1-5

**Tests to add**:

```typescript
test('throws when cwd does not exist', () => {
  expect(() => resolveHermesSession({ cwd: '/nonexistent/path/xyz' })).toThrow('does not exist');
});

test('throws when cwd is a file, not a directory', () => {
  // Use a known file path, e.g., /etc/hosts
  expect(() => resolveHermesSession({ cwd: '/etc/hosts' })).toThrow('not a directory');
});
```

**Verify**: `bun test packages/providers/src/hermes/session-resolver.test.ts`

### T4.3 — Add AcpIdGenerator wrap test

**File**: `packages/providers/src/hermes/acp-protocol.test.ts`
**Issue**: MAX_SAFE_INTEGER wraparound untested
**Source**: verification-test-coverage P2-11

**Test to add**:

```typescript
test('AcpIdGenerator wraps at MAX_SAFE_INTEGER', () => {
  const gen = createAcpIdGenerator(Number.MAX_SAFE_INTEGER);
  const lastId = gen.next(); // MAX_SAFE_INTEGER
  const wrappedId = gen.next(); // should be 1
  expect(lastId).toBe(Number.MAX_SAFE_INTEGER);
  expect(wrappedId).toBe(1);
});
```

**Verify**: `bun test packages/providers/src/hermes/acp-protocol.test.ts`

### Batch 4B (2 parallel, independent test files)

### T4.4 — Add parseMessage edge case tests

**File**: `packages/providers/src/hermes/acp-protocol.test.ts`
**Issue**: Empty string, whitespace, null error object untested
**Source**: verification-test-coverage P2-9

**Tests to add**:

```typescript
test('parseMessage returns null for empty string', () => {
  expect(parseMessage('')).toBeNull();
});

test('parseMessage returns null for whitespace-only', () => {
  expect(parseMessage('   ')).toBeNull();
});

test('parseMessage returns null for error with null error object', () => {
  expect(parseMessage('{"jsonrpc":"2.0","id":1,"error":null}')).toBeNull();
});

test('parseMessage accepts notification with no params', () => {
  const msg = parseMessage('{"jsonrpc":"2.0","method":"session/update"}');
  expect(msg).not.toBeNull();
  if (msg && 'method' in msg) {
    expect(msg.method).toBe('session/update');
    expect(msg.params).toBeUndefined();
  }
});
```

**Verify**: `bun test packages/providers/src/hermes/acp-protocol.test.ts`

### T4.5 — Add MAX_TIMEOUT_MS cap test

**File**: `packages/providers/src/hermes/provider.test.ts`
**Issue**: getFirstEventTimeoutMs() cap behavior untested
**Source**: verification-test-coverage P1-4

**Test approach**: Since `getFirstEventTimeoutMs` is not exported, test indirectly by setting `process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` and verifying the provider behavior, or export the function for direct testing.

**Verify**: `bun test packages/providers/src/hermes/provider.test.ts`

### Batch 4C (assertion strengthening, 2 files)

### T4.6 — Strengthen event-bridge test assertions

**File**: `packages/providers/src/hermes/event-bridge.test.ts`
**Issue**: Error tests check `isError: true` but don't validate error messages
**Source**: verification-test-coverage P3

**Changes**:

- Non-zero exit test: assert `errors[0]` contains `'exited with code 1'`
- Crash test: assert `errors[0]` contains `'Failed to run Hermes ACP'`
- stderr test: assert stderr line appears in error message

**Verify**: `bun test packages/providers/src/hermes/event-bridge.test.ts`

### T4.7 — Strengthen provider test assertions

**File**: `packages/providers/src/hermes/provider.test.ts`
**Issue**: Spawn failure test doesn't validate error message
**Source**: verification-test-coverage P3

**Change**: Assert error message contains expected spawn failure text.

**Verify**: `bun test packages/providers/src/hermes/provider.test.ts`

### Phase 4 Gate

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check
bun test packages/providers/src/hermes/
# Expected: 135+ pass, 0 fail
```

---

## Phase 5: Integration Edge Cases (4 items, batched)

> Gate: type-check + tests pass

### Batch 5A (3 parallel, different files)

### T5.1 — Handle process exit code 0 with pending request

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: 204-227
**Issue**: Exit with code 0 while request is pending causes 30-second timeout delay
**Source**: verification-integration-edge-cases Finding 1

**Change**: In the exit handler, after the `code !== 0` block, add a check for pending requests:

```typescript
} else {
  // Clean exit (code 0 or null) — reject any pending request to avoid timeout delay
  rejectPending('Hermes ACP process exited unexpectedly');
}
```

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/event-bridge.test.ts`

### T5.2 — Add error handler on childProcess.stdin

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: ~307 (in sendRequest, after stdin null check)
**Issue**: No error handler on stdin — EPIPE could cause unhandled error crash
**Source**: verification-integration-edge-cases Finding 3

**Change**: After confirming stdin exists, add an error handler:

```typescript
if (!childProcess.stdin) {
  reject(new Error('Hermes ACP child process stdin is not available'));
  return;
}
childProcess.stdin.on('error', err => {
  getLog().debug({ err }, 'acp.stdin_error');
});
```

**Verify**: `bun --filter @archon/providers type-check`

### T5.3 — Fix timer leak in withFirstEventTimeout

**File**: `packages/providers/src/hermes/timeout-utils.ts`
**Lines**: 15-20
**Issue**: When gen.next() rejects, clearTimeout is never reached — timer leaks for timeoutMs duration
**Source**: verification-integration-edge-cases Finding 4

**Change**: Wrap the first `await` in try/finally:

```typescript
// BEFORE:
while (true) {
  const result = await Promise.race([gen.next(), timer]);
  clearTimeout(timerHandle);
  // ...

// AFTER:
while (true) {
  let result;
  try {
    result = await Promise.race([gen.next(), timer]);
  } finally {
    clearTimeout(timerHandle);
  }
  // ...
```

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/timeout-utils.test.ts`

### Batch 5B (after 5A verifier-green)

### T5.4 — Add abort check before ACP requests

**File**: `packages/providers/src/hermes/event-bridge.ts`
**Lines**: ~332 (before `// 1. Initialize`)
**Issue**: ACP requests run unnecessarily after abortSignal has already fired
**Source**: verification-integration-edge-cases Finding 2

**Change**: Add early abort check:

```typescript
// ── Send ACP requests sequentially ─────────────────────────────────────
const idGen = createAcpIdGenerator();

// If already aborted, skip ACP requests — onAbort() already handled cleanup
if (abortSignal?.aborted) {
  // Consumer will see the terminal chunk from onAbort() and exit
  return;
}
```

Note: This requires the generator function to check before entering the try block. The `return` exits the generator, and the consumer loop will drain the queue (which already has the terminal chunk from onAbort).

**Verify**: `bun --filter @archon/providers type-check && bun test packages/providers/src/hermes/event-bridge.test.ts`

### Phase 5 Gate

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check
bun test packages/providers/src/hermes/
```

---

## Final Gate (all phases complete)

```bash
cd /home/d/Desktop/Archon-canonical
bun --filter @archon/providers type-check    # exit 0
bun test packages/providers/src/hermes/       # 135+ pass, 0 fail
cd packages/providers && npx eslint src/ --max-warnings 0  # 0 errors, 0 warnings
```

---

## Summary

| Phase | Items | Focus                                                       | Dependencies  |
| ----- | ----- | ----------------------------------------------------------- | ------------- |
| 1     | 1     | Critical bug: version negotiation field name                | None          |
| 2     | 6     | Code quality + security (lint, types, redaction, env)       | Phase 1 green |
| 3     | 3     | Protocol compliance (id type, capabilities, logging)        | Phase 2 green |
| 4     | 7     | Test coverage (new paths, edge cases, assertions)           | Phase 3 green |
| 5     | 4     | Integration edge cases (exit handling, stdin, timer, abort) | Phase 4 green |

**Total: 21 items across 5 phases**

### Not In Scope (tracked separately)

- I3 (Online Docs): Missing `authenticate` method — requires Hermes CLI auth support first
- I17 (Cross-Provider): Config resolvers not wired into spawn — separate feature work
- I6 (Cross-Provider): No retry loop in Hermes sendQuery — separate feature work
- M4-M10 (Cross-Provider): Shared utility extraction across all providers — separate refactoring
- C1 (Test Batching): Test runner configuration for mock isolation — separate infrastructure

---

_Generated from 6 verifier reports, 2-round overlapping audit, 2026-04-27_
