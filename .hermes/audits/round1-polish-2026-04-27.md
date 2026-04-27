# Polish Audit — Hermes Provider

**Auditor**: Verifier C (polish pass)
**Scope**: packages/providers/src/hermes/ (12 source files, 11 test files)
**Date**: 2026-04-27

---

## Summary

| Category                     | Issues |
| ---------------------------- | ------ |
| JSDoc completeness           | 8      |
| Comment quality              | 2      |
| Import organization          | 4      |
| Code style consistency       | 1      |
| Dead code                    | 0      |
| Error message quality        | 0      |
| Log event naming             | 1      |
| Constant naming              | 3      |
| Type export completeness     | 0      |
| File header consistency      | 5      |
| Quick wins from prior audits | 2      |
| **TOTAL**                    | **26** |

Severity breakdown: 2 high, 8 medium, 16 low.

---

## HIGH — Must Fix

### P1. event-bridge.test.ts: Corrupted test lines (lines 513–523)

The `redactSecrets` test block contains syntactically broken lines that
will cause a parse/runtime error:

```
Line 513: test('redacts OPENAI_API_KEY=*** () => {
Line 514:   expect(redactSecrets('OPENAI_API_KEY=sk-abc...]');
Line 518:   expect(redactSecrets('Authorization: Bearer token1...ion: [REDACTED] token123');
Line 522:   expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant...]');
```

Missing closing quotes and parentheses. These tests cannot pass. If the
test suite currently runs, these blocks are likely being skipped or the
file doesn't compile.

**File**: `event-bridge.test.ts` lines 513–523

### P2. Log event naming inconsistency (event-bridge.ts)

The same file uses two different prefixes for log events:

- `hermes.bridge.*` prefix (7 events): stderr_data, process_exited_nonzero,
  process_terminated_by_signal, process_error, abort_signal_received,
  sigkill_fallback, acp_request_failed
- `acp.*` prefix (8 events): line_buffer_truncated, invalid_json,
  invalid_session_update, unrecognized_session_update, stdin_backpressure_on_abort,
  stdin_write_failed_on_abort, stdin_error, stdin_drain_complete, parse_failed

Recommendation: normalize all events in event-bridge.ts to `hermes.bridge.*`
(e.g. `hermes.bridge.line_buffer_truncated` instead of `acp.line_buffer_truncated`).
The `acp.*` namespace is ambiguous — it could refer to the protocol module or
the bridge module.

**File**: `event-bridge.ts` (lines 116, 124, 132, 156, 172, 269, 272, 324, 330, 139)

---

## MEDIUM — Should Fix

### P3. Node built-in import inconsistency

Three files use bare `'child_process'` and `'path'` instead of prefixed
`'node:child_process'` and `'node:path'`. Other files (binary-resolver.ts,
session-resolver.ts) already use the `node:` prefix. This should be consistent.

| File                  | Import            | Should be              |
| --------------------- | ----------------- | ---------------------- |
| provider.ts:1         | `'child_process'` | `'node:child_process'` |
| event-bridge.ts:1     | `'path'`          | `'node:path'`          |
| event-bridge.ts:3     | `'child_process'` | `'node:child_process'` |
| binary-resolver.ts:13 | `'child_process'` | `'node:child_process'` |

**Fix**: Change all to `node:` prefixed form.

### P4. JSDoc missing on `withFirstEventTimeout` (timeout-utils.ts)

The sole exported function `withFirstEventTimeout` has zero documentation.
No JSDoc, no comments. It's used in provider.ts and has non-obvious
semantics (timer cancellation after first yield, first-event-only timeout).

**File**: `timeout-utils.ts` — add JSDoc explaining the first-event-timeout
semantics and the contract that subsequent events are not time-limited.

### P5. JSDoc missing on `redactSecrets` (event-bridge.ts)

`redactSecrets` is exported but has no JSDoc. It handles sensitive data
redaction — the regex patterns and their rationale deserve documentation.

**File**: `event-bridge.ts:29` — add JSDoc.

### P6. JSDoc missing on `verifyHermesBinary` (binary-resolver.ts)

Exported function with no JSDoc. Should document the timeout behavior
(5000ms), what "verify" means (--version check), and return semantics.

**File**: `binary-resolver.ts:43` — add JSDoc.

### P7. JSDoc missing on `HermesErrorClass` type and `ClassifiedError` interface (error-classifier.ts)

Both exported types lack JSDoc. `HermesErrorClass` should document the
meaning of each variant. `ClassifiedError` should explain `shouldRetry`
semantics and `enrichedMessage` format.

**File**: `error-classifier.ts:1-13` — add JSDoc to both.

### P8. Module-level JSDoc missing on 5 files

Files without module-level documentation header:

| File                  | Has header |
| --------------------- | ---------- |
| index.ts              | ✓          |
| binary-resolver.ts    | ✓          |
| session-resolver.ts   | ✓          |
| acp-protocol.ts       | ✓          |
| registration.ts       | ✗          |
| capabilities.ts       | ✗          |
| config.ts             | ✗          |
| provider.ts           | ✗          |
| event-bridge.ts       | ✗          |
| error-classifier.ts   | ✗          |
| model-ref.ts          | ✗          |
| options-translator.ts | ✗          |
| timeout-utils.ts      | ✗          |

Recommendation: add a one-line `/** ... */` module doc to all files that
lack one. Most important: error-classifier.ts, options-translator.ts,
timeout-utils.ts (these have no documentation at all).

### P9. Magic number in `verifyHermesBinary` (binary-resolver.ts:45)

```typescript
await execFileAsync(binary, ['--version'], { timeout: 5000 });
```

`5000` is a magic number. Should be a named constant like
`BINARY_VERIFY_TIMEOUT_MS`.

**File**: `binary-resolver.ts:45`

---

## LOW — Nice to Fix

### P10. Magic number in provider.ts default timeout

```typescript
return 60_000; // line 37
```

Should be a named constant like `DEFAULT_FIRST_EVENT_TIMEOUT_MS = 60_000`.

**File**: `provider.ts:37`

### P11. Magic number for SIGKILL fallback delay (event-bridge.ts:287)

```typescript
}, 5000);
```

Should be a named constant like `SIGKILL_FALLBACK_MS = 5000`.

**File**: `event-bridge.ts:287`

### P12. Extra blank line in event-bridge.ts (line 311)

Double blank line between abort handling closure and `sendRequest` function.

**File**: `event-bridge.ts:311-312` — remove one blank line.

### P13. `MAX_STDERR_LINES` defined inside function body (event-bridge.ts:91)

`MAX_STDERR_LINES = 50` is a constant that should be at module level
alongside `REQUEST_TIMEOUT_MS` and `MAX_LINE_BUFFER_LENGTH`.

**File**: `event-bridge.ts:91` — hoist to module level.

### P14. JSDoc missing on `ACP_METHODS` const (acp-protocol.ts:180)

Exported const object with no JSDoc. Should document the ACP method names.

**File**: `acp-protocol.ts:180`

### P15. JSDoc missing on `isSessionUpdateParams` (acp-protocol.ts:188)

Exported type guard with no JSDoc.

**File**: `acp-protocol.ts:188`

### P16. JSDoc missing on `createAcpIdGenerator` and `AcpIdGenerator` (acp-protocol.ts:48-61)

Exported interface and factory function, no JSDoc.

**File**: `acp-protocol.ts:48-61`

### P17. JSDoc missing on `INSTALL_INSTRUCTIONS` (binary-resolver.ts:26)

Exported constant with multi-line install instructions. Should have a
one-line JSDoc explaining its purpose.

**File**: `binary-resolver.ts:26`

### P18. JSDoc missing on `fileExists` (binary-resolver.ts:22)

Has a `//` comment but not JSDoc. Should be `/** ... */` since it's exported.

**File**: `binary-resolver.ts:21-22`

### P19. `provider.ts` JSDoc says "v1 capabilities are all false"

Line 51-52: "v1 capabilities are all false (see capabilities.ts): sessionResume,
mcp, hooks, skills, agents, toolRestrictions, structuredOutput, ..."

But `envInjection: true`. The word "all" is misleading. Should say
"most capabilities are false" or list the exception.

**File**: `provider.ts:51-52`

### P20. Options-translator.ts has no module-level JSDoc

No file header. Functions are well-documented individually but the module's
purpose (model/endpoint resolution for Hermes CLI args) is not stated at
the top.

**File**: `options-translator.ts`

### P21. `classifyHermesError` JSDoc doesn't document object-style overload

The function supports two calling conventions (legacy array args and object
style). The JSDoc documents rules but not the parameter overloads. Could
benefit from `@param` or `@overload` tags.

**File**: `error-classifier.ts:27`

---

## Quick Wins from Prior Audits

### P22. I19: mcpServers:[] despite capability false — STILL PRESENT

`event-bridge.ts:379` sends `mcpServers: []` in the `session/new` request
even though `mcp: false` in capabilities. This is likely required by the
ACP protocol schema (the field may be mandatory). Harmless (empty array)
but should have a comment explaining why it's sent despite the capability
being false.

**File**: `event-bridge.ts:379` — add comment.

### P23. M23: StructuredOutput comment vs value — RESOLVED (not an issue)

Re-read: the JSDoc on capabilities.ts explains WHY structuredOutput is false.
The comment is informational, not contradictory. No action needed.

---

## Non-Issues Confirmed

- **M12 (Binary resolver naming divergence)**: `resolveHermesBinary` wraps the
  shared `resolveBinaryPath` with Hermes-specific strings. Naming is consistent
  with the Hermes provider namespace. No issue.

- **M17 (Session resume semantics divergence)**: `resumeSessionId` is accepted
  but deliberately ignored, with `void resumeSessionId` and explanatory comments.
  `sessionResume: false` capability is correctly declared. Behavior is by design.

- **Dead code**: None found. No commented-out blocks. No unreachable code.
  No unused imports.

- **Type export completeness**: index.ts exports only the public API surface.
  Internal modules (acp-protocol, error-classifier, etc.) are correctly kept
  internal. No types need to be added to the public API.

---

## Prioritized Action List

1. **P1** — Fix corrupted test lines in event-bridge.test.ts (HIGH, blocks CI)
2. **P2** — Normalize log event prefix to `hermes.bridge.*` in event-bridge.ts (HIGH)
3. **P3** — Add `node:` prefix to bare built-in imports (MEDIUM, 4 files)
4. **P4–P8** — Add missing JSDoc to 8+ exported symbols and 5+ files (MEDIUM)
5. **P9–P11** — Extract magic numbers to named constants (MEDIUM+LOW)
6. **P12–P13** — Minor structural cleanup in event-bridge.ts (LOW)
7. **P14–P21** — Remaining JSDoc and documentation gaps (LOW)
8. **P22** — Add comment explaining mcpServers:[] despite mcp:false (LOW)
