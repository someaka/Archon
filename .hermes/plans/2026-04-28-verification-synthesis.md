# Triple Verification Synthesis — Session Report Verification

> Date: 2026-04-28
> Method: plan-verification-triangulation

---

## Verifier A (Online Docs) — APPROVED with risks

| Claim                                   | Verdict               | Evidence                                                                                                                                         |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| bun:test per-test timeout in batch mode | CONFIRMED (supported) | bun docs confirm `test("name", fn, { timeout: N })`                                                                                              |
| 60s timeout from bun default            | **REFUTED**           | bun default is 5000ms (5s), NOT 60s. Something else imposes the 60s limit.                                                                       |
| Known bun batch timeout bug             | CANNOT_VERIFY         | No GitHub issue found. Possible unreported edge case.                                                                                            |
| ACP isError field name                  | **RISK**              | `isError` is NOT in core ACP StopReason type. It's a Hermes/Archon extension field. Correct for this implementation, not universally applicable. |
| Hermes config shape (nested)            | CONFIRMED             | Docs confirm `model: { default, provider, base_url }`                                                                                            |
| Config precedence                       | CONFIRMED             | CLI > config.yaml > .env > defaults                                                                                                              |

**CRITICAL FINDING:** The 60s timeout is NOT bun's default. Bun default is 5s. The 60s must come from either:

- A CI runner timeout
- A process-level timeout in the test harness
- `setDefaultTimeout()` being called somewhere
- The bun test batch runner imposing a cumulative limit

---

## Verifier B (Codebase Patterns) — NEEDS_WORK

| Claim                    | Verdict           | Evidence                                                                                                      |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Pool key change          | CONFIRMED         | session-pool.ts:36-38 `${cwd}\0${provider ?? ''}\0${model}`                                                   |
| All callers updated      | CONFIRMED         | 4 callers in provider.ts all pass config.provider                                                             |
| Structured config YAML   | CONFIRMED         | provider.ts:236-254, Bun.YAML.stringify correct                                                               |
| event-bridge isError fix | CONFIRMED         | Lines 584-599, defensive === true check                                                                       |
| Test isolation           | **NEEDS_WORK**    | Inline save/restore in test bodies is fragile. No afterEach for env cleanup in HermesProvider describe block. |
| Codebase patterns        | CONFIRMED         | Hermes follows IAgentProvider contract                                                                        |
| Issue packages touched   | PARTIALLY REFUTED | Only providers/ touched, not core/workflows/server/cli/web                                                    |

**CRITICAL FINDINGS:**

1. **Test/code value mismatch:** provider.ts:233 sets HERMES_USE_GLOBAL_AUTH='\*\*\*' but provider.test.ts:987 expects '.toBe('true')'. Either the test is wrong or the code changed without updating the test.
2. **session-pool.test.ts missing:** No test exercises provider-based key isolation at the pool level.
3. **Fragile env cleanup:** Tests use inline save/restore (not afterEach). If `consume()` throws before restore, env leaks to subsequent tests.

---

## Verifier C (Requirements Completeness) — REJECTED (report under-states)

| Category         | Done            | Partial       | Not Done       |
| ---------------- | --------------- | ------------- | -------------- |
| Core Integration | 4/4             | —             | —              |
| Configuration    | 4/4             | —             | —              |
| CLI Setup        | 3/4             | 1/4           | —              |
| Workflows        | 4/4             | —             | —              |
| Testing          | 6/6             | —             | —              |
| Documentation    | 2/5             | 1/5           | 2/5            |
| Nice-to-haves    | 1/4             | —             | 3/4            |
| **TOTAL**        | **24/32 (75%)** | **2/32 (6%)** | **6/32 (19%)** |

**CRITICAL FINDING:** The report has 3 FALSE "NOT STARTED" claims:

1. **CLI setup wizard** — DONE (setup.ts:847, auto-detect, validation all exist)
2. **Documentation** — PARTIALLY DONE (ai-assistants.md has Hermes section, troubleshooting-hermes.md exists)
3. **Cross-package integration tests** — DONE (hermes-integration.test.ts, hermes-e2e.test.ts exist)

The report only reflects THIS SESSION's work, not the overall issue completion status. This is misleading for issue closure assessment.

---

## Cross-Referenced Findings (2+ verifiers agree)

| Finding                                                    | Verifiers | Priority                    |
| ---------------------------------------------------------- | --------- | --------------------------- |
| 60s timeout is NOT bun default (5s)                        | A, B      | CRITICAL                    |
| Test/code value mismatch (globalAuth '\*\*\*' vs 'true')   | B, C      | CRITICAL                    |
| Report under-states issue completion (3 false NOT STARTED) | C         | CRITICAL                    |
| session-pool.test.ts missing provider-parameter tests      | B         | HIGH                        |
| Fragile inline env save/restore (not afterEach)            | B         | HIGH                        |
| isError is extension field, not core ACP                   | A         | LOW (correct for this impl) |

---

## Required Corrections

### CRITICAL (must fix)

1. **Investigate 60s timeout source** — Run test with `bun test --verbose` to see actual timeout mechanism. Check for setDefaultTimeout() calls. Check if bun test batch has a cumulative timeout.
2. **Fix test/code value mismatch** — provider.ts sets '\*\*\*', test expects 'true'. Align them.
3. **Update report** — Correct false "NOT STARTED" claims to reflect actual codebase state.

### HIGH (should fix)

4. **Add provider-parameter tests to session-pool.test.ts** — Test cross-provider key isolation at pool level.
5. **Move inline env save/restore to afterEach** — Prevent env leaks on test failures.

### LOW (document)

6. **Document isError as extension field** — Note in event-bridge.ts that isError is a Hermes/Archon extension, not core ACP.
