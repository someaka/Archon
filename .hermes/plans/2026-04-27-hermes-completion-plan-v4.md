# Hermes Provider — Updated Completion Plan v4 (Post-Audit)

> **Audits incorporated:** code-audit-2026-04-27.md + docs-audit-2026-04-27.md
> **Test baseline:** 126 pass / 0 fail / 157ms. Type-check clean.

## Done (4/17 fix-plan elements + T1)

| ID  | Element                        | File(s)                                           |
| --- | ------------------------------ | ------------------------------------------------- |
| E1  | Honest capability flags        | `capabilities.ts`                                 |
| E3  | process.env type safety        | `session-resolver.ts`                             |
| E14 | Error classifier               | `error-classifier.ts`, `error-classifier.test.ts` |
| T1  | mockSpawn explicit return type | `provider.test.ts`                                |

## Remaining Elements — Prioritized

### P0: Critical (fix first)

| ID  | Element                                            | Files                                                          | Risk   | Notes                                              |
| --- | -------------------------------------------------- | -------------------------------------------------------------- | ------ | -------------------------------------------------- |
| E2  | Delete dead `acp-bridge.ts` + test                 | `acp-bridge.ts`, `acp-bridge.test.ts`                          | Low    | Fast win. No imports found.                        |
| E5  | `session/cancel` as notification (docs compliance) | `event-bridge.ts`                                              | Medium | ACP spec violation. Must use `createNotification`. |
| E4  | ACP request timeout                                | `event-bridge.ts`                                              | Medium | Prevents indefinite hangs. 30s default.            |
| E13 | Wire `withFirstEventTimeout` into provider         | `provider.ts`, `timeout-utils.ts`                              | Medium | Utility exists but unused. Also fix timer leak.    |
| E16 | Pre-flight `verifyHermesBinary` check              | `binary-resolver.ts`, `provider.ts`, `binary-resolver.test.ts` | High   | Binary not validated before spawn.                 |

### P1: High (fix second)

| ID  | Element                                          | Files                                | Risk   |
| --- | ------------------------------------------------ | ------------------------------------ | ------ |
| E6  | Clear `sigkillTimeout` on normal exit            | `event-bridge.ts`                    | Low    |
| E8  | Strict `sessionId` validation                    | `event-bridge.ts`                    | Low    |
| E10 | Replace mutable `nextId` with per-bridge counter | `acp-protocol.ts`, `event-bridge.ts` | Medium |
| E12 | `MAX_LINE_BUFFER_LENGTH`                         | `event-bridge.ts`                    | Low    |

### P2: Medium (fix third)

| ID  | Element                                  | Files                                | Risk           |
| --- | ---------------------------------------- | ------------------------------------ | -------------- |
| E7  | Runtime `SessionUpdateParams` validation | `acp-protocol.ts`, `event-bridge.ts` | Medium         |
| E9  | Extract ACP method constants             | `acp-protocol.ts`, `event-bridge.ts` | Low            |
| E11 | stderr enrichment for crash/abort paths  | `event-bridge.ts`                    | Low            |
| E15 | Subprocess retry loop                    | `provider.ts`                        | High (complex) |
| E17 | Duplicate-exit-event test                | `event-bridge.test.ts`               | Low            |

### P3: Docs compliance (from docs audit)

| ID  | Gap                                                | Files                 |
| --- | -------------------------------------------------- | --------------------- |
| D1  | `session/cancel` as notification                   | `event-bridge.ts`     |
| D2  | Validate `protocolVersion` from InitializeResponse | `event-bridge.ts`     |
| D3  | Absolute `cwd` validation                          | `event-bridge.ts`     |
| D4  | JSON-RPC error codes in classifier                 | `error-classifier.ts` |

## Execution Order

```
Batch 1 (independent files, P0):
  E2  — delete acp-bridge.ts + acp-bridge.test.ts
  E5  — event-bridge.ts: createNotification for session/cancel
  E13 — provider.ts: wire withFirstEventTimeout + fix timer cleanup in timeout-utils.ts

After Batch 1 verifier-green:
  E4  — event-bridge.ts: Promise.race 30s timeout on sendRequest
  E16 — binary-resolver.ts: add verifyHermesBinary; provider.ts: call it

After Batch 2 verifier-green:
  E6  — event-bridge.ts: clear sigkillTimeout on normal exit
  E8  — event-bridge.ts: sessionId strict validation
  E10 — acp-protocol.ts: replace nextId with AcpIdGenerator

Final gate:
  bun test packages/providers/src/hermes/ → 126+ pass, 0 fail
  bun --filter @archon/providers type-check → clean
```

## File Independence Matrix

| File               | Batches                      |
| ------------------ | ---------------------------- |
| acp-bridge.ts      | B1 (delete)                  |
| event-bridge.ts    | B1 (E5), B2 (E4), B3 (E6,E8) |
| provider.ts        | B1 (E13), B2 (E16)           |
| binary-resolver.ts | B2 (E16)                     |
| timeout-utils.ts   | B1 (E13-fix)                 |
| acp-protocol.ts    | B3 (E10)                     |

## Rules (Strict)

1. **One executor per file per batch** — never let two executors modify the same file concurrently
2. **No test changes until source verifier-green**
3. **Max 3 concurrent executors**
4. **Verifiers are always fresh agents** — never reuse executor
5. **Every executor gets exact file path + expected change + verifier gate**
6. **If verifier finds issues, redispatch fresh executor with issues as context**
