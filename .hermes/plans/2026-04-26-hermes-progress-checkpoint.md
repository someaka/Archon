# Hermes Provider Fix Plan — PROGRESS CHECKPOINT

**Date:** 2026-04-26
**Status:** Batch 1 complete, Batch 2-7 pending
**Plan file:** `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-26-hermes-fix-plan.md`

---

## COMPLETED (Batch 1)

### E1: Set Honest Capability Flags ✅

- **File:** `packages/providers/src/hermes/capabilities.ts`
- **Change:** `skills: false`, `fallbackModel: false`
- **Tests updated:** `provider.test.ts` assertions updated
- **Commit:** `fix(hermes): set skills and fallbackModel to false until wired`

### E2: Delete Dead Code (`acp-bridge.ts`) ✅

- **Files deleted:** `packages/providers/src/hermes/acp-bridge.ts`, `acp-bridge.test.ts`
- **package.json updated:** Removed `acp-bridge.test.ts` from test chain
- **Commit:** `chore(hermes): remove dead acp-bridge.ts and its test`

### E3: Fix `process.env` Type Safety ✅

- **File:** `packages/providers/src/hermes/session-resolver.ts`
- **Change:** `Object.fromEntries(Object.entries(process.env).filter(([, v]): v is string => typeof v === 'string'))`
- **Commit:** `fix(hermes): filter undefined values from process.env spread`

---

## PENDING (Batches 2-7)

### Batch 2: Event Bridge Core Fixes (Sequential — all touch event-bridge.ts)

#### E4: Add ACP Request Timeout

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Change:** Wrap `sendRequest()` in `Promise.race` with 30s timeout (env override `ARCHON_HERMES_REQUEST_TIMEOUT_MS`)
- **Test:** Add timeout test in `event-bridge.test.ts`
- **Note:** Must be done before E5-E6 (they touch same file)

#### E5: Use `createNotification` for `session/cancel`

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Change:** Replace `createRequest('session/cancel', ...)` with `createNotification(...)`
- **Test:** Update abort test to assert notification format

#### E6: Clear `sigkillTimeout` on Normal Exit

- **File:** `packages/providers/src/hermes/event-bridge.ts`
- **Change:** Clear timer in `exit` event handler
- **Test:** Add test for abort + normal exit sequence

### Batch 3: Validation & Constants (Sequential — touch acp-protocol.ts + event-bridge.ts)

#### E7: Runtime Validate `SessionUpdateParams`

- **Files:** `acp-protocol.ts` (add `isSessionUpdateParams`), `event-bridge.ts` (use it)
- **Test:** Add validation tests in `acp-protocol.test.ts`

#### E8: Validate `sessionId` After `session/new`

- **File:** `event-bridge.ts`
- **Change:** Assert `typeof sessionId === 'string' && sessionId.length > 0`
- **Test:** Add invalid sessionId test

#### E9: Extract ACP Method Constants

- **Files:** `acp-protocol.ts` (add constants), `event-bridge.ts` (use them)
- **Test:** N/A — refactoring only

### Batch 4: Mutable State & Error Quality

#### E10: Replace Mutable `nextId` with Per-Bridge Counter

- **Files:** `acp-protocol.ts` (add `createAcpIdGenerator`), `event-bridge.ts` (use it)
- **Test:** Update `acp-protocol.test.ts`

#### E11: Enrich Errors with Stderr Context

- **File:** `event-bridge.ts`
- **Change:** Include last 3 stderr lines in error messages
- **Test:** Add stderr enrichment test

#### E12: Add `MAX_LINE_BUFFER_LENGTH`

- **File:** `event-bridge.ts`
- **Change:** 1MB buffer limit with warning chunk on overflow
- **Test:** Add buffer overflow test

### Batch 5: Provider-Level Resilience (Sequential — touch provider.ts + new files)

#### E13: Add First-Event Timeout

- **New file:** `packages/providers/src/hermes/timeout-utils.ts`
- **File:** `provider.ts` (use `withFirstEventTimeout`)
- **Env:** `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` (default 60000)
- **Test:** Add timeout utility test + provider timeout test

#### E14: Implement `classifyHermesError`

- **New file:** `packages/providers/src/hermes/error-classifier.ts`
- **Files:** `provider.ts` (use in retry loop), `event-bridge.ts` (include stderr)
- **Test:** Add classifier tests

#### E15: Add Subprocess Retry Loop

- **File:** `provider.ts`
- **Change:** `MAX_SUBPROCESS_RETRIES = 3`, exponential backoff
- **Test:** Add retry test with mock failing then succeeding spawn

### Batch 6: Spawn Pre-Flight Check

#### E16: Add Spawn Pre-Flight Check

- **File:** `binary-resolver.ts` (add `verifyHermesBinary`)
- **File:** `provider.ts` (use before spawn)
- **Test:** Add verification test

### Batch 7: Tests Only

#### E17: Add Duplicate-Exit-Event Test

- **File:** `event-bridge.test.ts`
- **Test:** Assert `terminalEmitted` prevents double result chunks

---

## FINAL VERIFICATION GATES (After All Batches)

1. `bun run type-check` → PASS
2. `bun run lint` → PASS (zero warnings)
3. `bun test packages/providers/src/hermes/` → All pass
4. `bun run test` → All packages pass
5. `bun run cli validate workflows` → VALID
6. `find packages/providers/src/hermes/ -name "*.tmp"` → 0

---

## LESSONS LEARNED FOR NEXT SESSION

1. **Always delegate edits to subagents** — never do manual edits in controller session (context overfill)
2. **If executor fails, diagnose then dispatch new delegate** briefed with mission + lessons learned
3. **Patch tool may be unreliable** — use `write_file` or delegate to subagent with `patch` tool
4. **Max 3 concurrent executors** — never exceed
5. **Never self-verify** — always use fresh verifier subagent
6. **Context isolation** — each agent gets only its element's scope
7. **Test mandate** — every element must include test addition/modification

---

## AUDIT REPORTS (Available for Reference)

1. `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-26-hermes-bridge-timeout-audit.md`
2. `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-26-hermes-acp-security-audit.md`
3. `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-26-hermes-workflow-integration-audit.md`
4. `/home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-26-hermes-fix-plan.md` (full plan)

---

## GIT STATUS (As of checkpoint)

Branch: `dev`
Commits since start:

- `fix(hermes): set skills and fallbackModel to false until wired`
- `chore(hermes): remove dead acp-bridge.ts and its test`
- `fix(hermes): filter undefined values from process.env spread`

Working tree: clean (all changes committed)
