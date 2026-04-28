# V1 Requirements Verification Report

> Verifier: V1 (READ-ONLY)
> Plan: /home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-28-workflow-yaml-fixes.md
> Date: 2026-04-28

---

## Per-Finding Status

| Finding | Description                         | Status  | Plan Task            | Evidence                                                         |
| ------- | ----------------------------------- | ------- | -------------------- | ---------------------------------------------------------------- |
| F-001   | Shell injection in $ARGUMENTS       | COVERED | T2.1 (plan L127-147) | YAML: pr-ver L44, adv-fix L39-40, audit-pr L23,27                |
| F-002   | set -e masked by pipes              | COVERED | T1.1 (plan L28-43)   | YAML: pr-ver L26/75, adv-fix L25/70, audit-pr L290/298           |
| F-003   | Gates force exit 0                  | COVERED | T1.2 (plan L45-85)   | YAML: pr-ver L196/215/242, adv-fix L215/229-231/244-250          |
| F-004   | one_success trigger allows 25% data | COVERED | T4.1 (plan L219-223) | YAML: audit-pr L218                                              |
| F-005   | Gate results not structured         | COVERED | T1.3 (plan L87-96)   | All 3 YAMLs: free-form text output                               |
| F-006   | Lint OOM                            | COVERED | T1.4 (plan L98-106)  | YAML: pr-ver lint-check (no NODE_OPTIONS), adv-fix L229 (4096MB) |
| F-007   | Test gate empty output              | COVERED | T1.5 (plan L108-121) | YAML: pr-ver L245 (300s timeout)                                 |
| F-008   | git add -A stages everything        | COVERED | T5.1 (plan L229-233) | YAML: adv-fix L190, audit-pr L346                                |
| F-009   | branch-setup missing set -e         | COVERED | T3.1 (plan L178-181) | YAML: audit-pr L272-280 (no set -e)                              |
| F-010   | $TARGET_DIRS word splitting         | COVERED | T2.2 (plan L149-163) | YAML: audit-pr L52 (for dir in $TARGET_DIRS)                     |
| F-011   | .workdir not validated              | COVERED | T3.2 (plan L183-195) | YAML: pr-ver L69-70, adv-fix L64-65 (no validation)              |
| F-012   | Review agent fragility              | COVERED | T6.1 (plan L260-264) | YAML: pr-ver review nodes                                        |
| F-013   | $ARTIFACTS_DIR not guarded          | COVERED | T3.3 (plan L197-207) | All 3 YAMLs: no guard                                            |
| F-014   | Branch name not sanitized           | COVERED | T2.3 (plan L165-172) | YAML: audit-pr L274                                              |
| F-015   | create-pr no timeout                | COVERED | T5.2 (plan L235-238) | YAML: audit-pr L432 (no timeout)                                 |
| F-016   | Commit messages not sanitized       | COVERED | T5.3 (plan L240-244) | YAML: adv-fix L190, audit-pr L346                                |
| F-017   | No remote verification before push  | COVERED | T5.4 (plan L246-249) | YAML: audit-pr L447                                              |
| F-018   | Default model adequacy              | COVERED | T6.2 (plan L266-269) | No explicit model in YAMLs                                       |
| F-019   | Duplicated setup script             | COVERED | T6.3 (plan L271-296) | All 3 YAMLs: near-identical setup                                |
| F-020   | No abort on push failure            | COVERED | T5.5 (plan L251-254) | YAML: audit-pr L447                                              |
| F-021   | pwd to cd no-op                     | COVERED | T3.4 (plan L209-213) | YAML: audit-pr L292-293                                          |

---

## Detailed Analysis

### F-001: Shell injection in $ARGUMENTS — COVERED

- Plan task T2.1 proposes allowlist-based sanitization with tr -cd
- Fix addresses all 3 YAML files scope/parse nodes
- $ARGUMENTS also in prompt interpolations (adv-fix L100, L264, L317) but those are engine-handled

### F-002: set -e masked by pipes — COVERED

- Plan task T1.1 proposes set -eo pipefail in all 3 setup nodes
- Correct fix: pipefail ensures pipeline exit code is rightmost non-zero

### F-003: Gates force exit 0 — COVERED

- Plan task T1.2 removes || true and forced exit 0 on FAIL branches
- Cross-ref note: Plan L85 says (T3.1) but should say (T4.1) for trigger rule change

### F-004: one_success trigger allows 25% data — COVERED

- Plan task T4.1 changes trigger_rule to none_failed_min_one_success
- Correct: prevents synthesize from running with only 1/4 audit reports

### F-005: Gate results not structured — COVERED

- Plan task T1.3 writes structured JSON to gate-results.json

### F-006: Lint OOM — COVERED

- Plan task T1.4 increases NODE_OPTIONS --max-old-space-size=8192
- pr-verifier currently has NO NODE_OPTIONS (needs to ADD)
- adversarial-fix has 4096MB (needs to INCREASE)

### F-007: Test gate empty output — COVERED

- Plan task T1.5 proposes timeout increase or targeted test runs

### F-008: git add -A stages everything — COVERED

- Plan task T5.1 replaces git add -A with explicit file staging

### F-009: branch-setup missing set -e — COVERED

- Plan task T3.1 adds set -e to branch-setup node

### F-010: $TARGET_DIRS word splitting — COVERED

- Plan task T2.2 uses while IFS= read -r pattern

### F-011: .workdir not validated — COVERED

- Plan task T3.2 adds directory existence check before cd

### F-012: Review agent fragility — COVERED

- Plan task T6.1 adds documentation comment
- Documentation-only fix (acceptable for this finding type)

### F-013: $ARTIFACTS_DIR not guarded — COVERED

- Plan task T3.3 adds guard check at start of each bash block

### F-014: Branch name not sanitized — COVERED

- Plan task T2.3 strips non-alphanumeric from TARGET

### F-015: create-pr no timeout — COVERED

- Plan task T5.2 adds timeout: 120000

### F-016: Commit messages not sanitized — COVERED

- Plan task T5.3 instructs agents to use finding IDs only

### F-017: No remote verification before push — COVERED

- Plan task T5.4 adds remote URL verification

### F-018: Default model adequacy — COVERED

- Plan task T6.2 is a manual verification step

### F-019: Duplicated setup script — COVERED

- Plan task T6.3 extracts shared script to scripts/setup-deps.sh

### F-020: No abort on push failure — COVERED

- Plan task T5.5 instructs agent to abort if git push fails

### F-021: pwd to cd no-op — COVERED

- Plan task T3.4 removes the no-op pattern
- Location note: Plan says scope node but code is in setup node (L287-314)

---

## Issues Found in Plan

### 1. Cross-Reference Error (Minor)

- Plan L85: Says (T3.1) for trigger rule change, should be (T4.1)
- Impact: Executor confusion during implementation
- Severity: LOW

### 2. Location Error for F-021 (Minor)

- Plan L211: Says scope node but pwd-to-cd no-op is in setup node (audit-pr L287-314)
- Impact: Executor may look in wrong node
- Severity: LOW

### 3. F-012 Fix is Documentation-Only (Acceptable)

- Plan L260-264: Only adds a comment about review agent fragility
- No code change to prevent the fragility
- Impact: Fragility remains but is documented
- Severity: LOW (acceptable for this finding type)

---

## CRITICAL GAPS

NONE — All 21 findings have corresponding tasks in the plan.

---

## Overall Assessment

PASS: 21/21 findings covered

The plan comprehensively addresses all 21 findings from the workflow assessment. Each finding has a corresponding task with clear file references, specific code changes (before/after examples), and proper dependency ordering (Phase 1 through Phase 6).

The 3 minor issues identified (cross-reference error, location error, documentation-only fix) do not prevent execution and can be corrected during implementation.

The plan phased execution strategy is sound:

- Phase 1 (gate pattern) is correctly identified as root cause
- Phase 2-3 (injection/validation) build on Phase 1
- Phase 4-6 (triggers/git/infra) are independent

Recommendation: Plan is ready for execution.
