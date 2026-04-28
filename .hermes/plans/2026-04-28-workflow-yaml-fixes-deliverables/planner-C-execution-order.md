# PLANNER C: Execution Order + Issue Coverage Matrix

Date: 2026-04-28
Status: FINAL

---

## 1. Issue #1106 Requirements (Reconstructed)

The issue could not be fetched (404). Based on the plan and verifier reports,
the issue is about the hermes-pr-verifier workflow producing a 0/10 verdict
with 21 findings across 3 workflow YAML files. The core requirement is:

"Fix the 21 findings identified by the hermes-pr-verifier workflow assessment
in the 3 Archon workflow YAML files."

This means ALL 21 findings are issue requirements. There is no secondary
requirement unrelated to the YAML files.

---

## 2. Issue Coverage Matrix

Each finding mapped to whether it DIRECTLY addresses an issue requirement
(all 21 are issue requirements, but some are more critical than others):

| Finding | Task | Issue Req? | Category                             | Priority |
| ------- | ---- | ---------- | ------------------------------------ | -------- |
| F-002   | T1.1 | YES        | Core: error handling masked          | P0       |
| F-003   | T1.2 | YES        | Core: gates force exit 0             | P0       |
| F-005   | T1.3 | YES        | Core: gate results unstructured      | P0       |
| F-004   | T4.1 | YES        | Core: trigger allows 25% data        | P0       |
| F-001   | T2.1 | YES        | Security: shell injection            | P1       |
| F-010   | T2.2 | YES        | Security: word splitting             | P1       |
| F-014   | T2.3 | YES        | Security: branch name injection      | P1       |
| F-006   | T1.4 | YES        | Reliability: lint OOM                | P1       |
| F-007   | T1.5 | YES        | Reliability: test empty output       | P1       |
| F-009   | T3.1 | YES        | Reliability: missing set -e          | P1       |
| F-011   | T3.2 | YES        | Reliability: .workdir unvalidated    | P1       |
| F-013   | T3.3 | YES        | Reliability: ARTIFACTS_DIR unguarded | P1       |
| F-021   | T3.4 | YES        | Reliability: pwd→cd no-op            | P1       |
| F-008   | T5.1 | YES        | Safety: git add -A                   | P2       |
| F-016   | T5.3 | YES        | Safety: commit msg injection         | P2       |
| F-017   | T5.4 | YES        | Safety: no remote verification       | P2       |
| F-020   | T5.5 | YES        | Safety: no abort on push fail        | P2       |
| F-015   | T5.2 | YES        | Safety: no timeout on create-pr      | P2       |
| F-019   | T6.3 | YES        | Quality: duplicated setup script     | P3       |
| F-012   | T6.1 | YES        | Quality: review agent fragility      | P3       |
| F-018   | T6.2 | YES        | Quality: default model adequacy      | P3       |

ALL 21 findings are issue requirements. No findings should be removed.

---

## 3. Reprioritized Task List

### P0: Core Gate Pattern (addresses F-002, F-003, F-005, F-004)

These are the ROOT CAUSE findings. The gate pattern masks failures, making
all other findings invisible. Must fix first.

- T1.1: set -eo pipefail in ALL 14 bash nodes (not 3 as original plan said)
- T1.2: Remove || true and forced exit 0 on FAIL branches
- T1.3: Write structured gate results to gate-results.json
- T4.1: Change synthesize trigger to none_failed_min_one_success

### P1: Security & Reliability (addresses F-001, F-006, F-007, F-009, F-010, F-011, F-013, F-014, F-021)

These fix security vulnerabilities and reliability gaps. Must complete before
the workflows can be trusted in production.

- T2.1: Sanitize $ARGUMENTS with allowlist
- T2.2: Quote $TARGET_DIRS iteration
- T2.3: Sanitize branch name
- T1.4: Fix lint OOM (NODE_OPTIONS --max-old-space-size=8192)
- T1.5: Fix test gate empty output (VERIFIER CORRECTION: increase timeout to 600000)
- T3.1: Add set -eo pipefail to branch-setup (subsumed by T1.1 expansion)
- T3.2: Validate .workdir after reading
- T3.3: Guard $ARTIFACTS_DIR (only in 10 nodes that use it, not all 14)
- T3.4: Fix pwd→cd no-op in BOTH scope AND setup nodes (VERIFIER CORRECTION)

### P2: Git Safety (addresses F-008, F-015, F-016, F-017, F-020)

These fix git operation safety. Important but not blocking.

- T5.1: Replace git add -A with explicit staging
- T5.2: Add timeout to create-pr (VERIFIER CORRECTION: increase to 300000, not 120000)
- T5.3: Sanitize commit messages
- T5.4: Verify remote before push
- T5.5: Abort create-pr on push failure

### P3: Infrastructure & Quality (addresses F-012, F-018, F-019)

Nice-to-have improvements. Not blocking.

- T6.1: Document review agent fragility (comment only)
- T6.2: Verify default model adequacy (manual check)
- T6.3: Extract shared setup script (VERIFIER CORRECTION: use shell source, not !include)

---

## 4. Recommended Execution Order

### Batch 1: P0 — Gate Pattern Fix (parallel per file)

All 3 files in parallel since they're independent:

Executor E1: hermes-pr-verifier.yaml (5 bash nodes)

- T1.1: set -eo pipefail in scope(L26), setup(L67), type-check(L185), lint-check(L204), test-gates(L223)
- T1.2: Remove exit 0 on FAIL branches in type-check(L196), lint-check(L215), test-gates(L242)
- T1.3: Add structured JSON output after each gate
- T4.1: N/A (no synthesize node in this file)

Executor E2: archon-adversarial-fix.yaml (5 bash nodes)

- T1.1: set -eo pipefail in parse-audit(L25), setup(L62), type-check(L204), lint-check(L223), test-gates(L238)
- T1.2: Remove || true on L229, L244, L248; remove exit 0 on L212, L215, L231, L250
- T1.3: Add structured JSON output after each gate
- T4.1: N/A (no synthesize node in this file)

Executor E3: archon-audit-to-pr.yaml (4 bash nodes)

- T1.1: set -eo pipefail in setup(L290), scope(L21), branch-setup(L272), validate(L361)
- T1.2: N/A (validate node already uses exit code capture, no || true or forced exit 0)
- T1.3: Add structured JSON output after validate gate
- T4.1: Change synthesize trigger from one_success to none_failed_min_one_success (L218)

### GATE 1: Structural Verification

- grep -c 'set -eo pipefail' in each file (expect 5, 5, 4)
- grep -c '|| true' in .archon/workflows/ (expect 0)
- grep -c 'exit 0' in .archon/workflows/ (expect 0, except legitimate cases)
- Validate YAML syntax: bun run cli validate workflows (all 3)

### Batch 2: P1 — Security & Reliability (parallel per file)

Executor E4: hermes-pr-verifier.yaml

- T2.1: Sanitize $ARGUMENTS in scope node (L44-45)
- T3.2: Validate .workdir after reading in setup(L69-70), type-check, lint-check, test-gates
- T3.3: Add ARTIFACTS_DIR guard to all 5 bash nodes
- T1.4: Add NODE_OPTIONS="--max-old-space-size=8192" to lint-check
- T1.5: Increase test-gates timeout to 600000

Executor E5: archon-adversarial-fix.yaml

- T2.1: Sanitize $ARGUMENTS in parse-audit node (L39-40)
- T3.2: Validate .workdir after reading in setup(L64-65), type-check, lint-check, test-gates
- T3.3: Add ARTIFACTS_DIR guard to all 5 bash nodes

Executor E6: archon-audit-to-pr.yaml

- T2.1: Sanitize $ARGUMENTS in scope node (L23, L27 — MOST DANGEROUS USAGE)
- T2.2: Fix $TARGET_DIRS word splitting in scope node (L52, L61)
- T2.3: Sanitize branch name in branch-setup node (L274)
- T3.2: Validate .workdir after reading (scope, setup nodes)
- T3.3: Add ARTIFACTS_DIR guard to scope and branch-setup nodes (2 of 4 use it)
- T3.4: Fix pwd→cd no-op in BOTH scope(L292-293) AND setup(L292-293) nodes

### GATE 2: Security & Reliability Verification

- grep -c 'tr -cd' in .archon/workflows/ (expect >= 3 for ARGUMENTS sanitization)
- grep -c 'while IFS= read' in archon-audit-to-pr.yaml (expect >= 2)
- grep -c 'NODE_OPTIONS' in hermes-pr-verifier.yaml (expect >= 1)
- Verify no unquoted $ARGUMENTS in bash blocks
- Verify ARTIFACTS_DIR guard in all nodes that use it

### Batch 3: P2 — Git Safety (single executor, sequential)

Executor E7:

- T5.1: Replace git add -A in archon-adversarial-fix.yaml (L190) and archon-audit-to-pr.yaml (L346, L424)
- T5.2: Add timeout: 300000 to archon-audit-to-pr.yaml create-pr node (L432)
- T5.3: Sanitize commit message instructions in prompts
- T5.4: Add remote URL verification in archon-audit-to-pr.yaml create-pr prompt
- T5.5: Add abort-on-push-failure instruction in archon-audit-to-pr.yaml create-pr prompt

### GATE 3: Git Safety Verification

- grep -c 'git add -A' in .archon/workflows/ (expect 0)
- Verify timeout: 300000 on create-pr node
- Verify remote verification and abort instructions in prompts

### Batch 4: P3 — Infrastructure & Quality

Executor E8:

- T6.1: Add documentation comment about review agent fragility
- T6.2: Document model verification (manual step)
- T6.3: Extract shared setup script to .archon/workflows/scripts/setup-deps.sh
  Use shell `source` (NOT !include) — V3 confirmed !include is unsupported

### GATE 4: Final Verification

- All 21 findings addressed
- All YAML files valid
- Shared script exists and is sourced correctly
- No anti-patterns remaining (|| true, exit 0, git add -A, unquoted $ARGUMENTS)

---

## 5. Scope Adjustments

### No findings to remove

All 21 findings are legitimate issues in the workflow YAML files.

### No findings to add

The verifiers identified 5 additional patterns (M1-M5 in V2) but all are
subsumed by existing tasks:

- M1 (missing set -e entirely): Covered by T1.1 expansion to 14 nodes
- M2 (inconsistent WORKDIR): Covered by T3.4
- M3 (validate node no set -e): Covered by T1.1 expansion
- M4 (prompt $ARGUMENTS): Not a shell injection risk, low priority
- M5 (line counts accurate): No action needed

### Verifier corrections applied (5 total):

1. T1.1 expanded: 3 nodes → 14 nodes (from V2)
2. L85 cross-ref: T3.1 → T4.1 (from V1)
3. T3.4 location: scope AND setup nodes (from V2)
4. T6.3 mechanism: shell source, not !include (from V3)
5. T5.2 timeout: 120000 → 300000 (from V3, default is 120000 so need higher)

---

## 6. Final Execution Strategy with Gates

```
BATCH 1 (P0): 3 parallel executors → 3 files × gate pattern fix
    ↓
GATE 1: structural grep + YAML validation
    ↓
BATCH 2 (P1): 3 parallel executors → 3 files × security/reliability
    ↓
GATE 2: security pattern verification
    ↓
BATCH 3 (P2): 1 sequential executor → git safety across 2 files
    ↓
GATE 3: git safety verification
    ↓
BATCH 4 (P3): 1 sequential executor → infrastructure cleanup
    ↓
GATE 4: final comprehensive verification
```

Total: 4 batches, 4 gates, 8 executor slots (some reused).
Estimated scope: ~200 line changes across 3 files + 1 new file.

Critical path: Batch 1 → Gate 1 → Batch 2 → Gate 2
The remaining batches are independent and can proceed once Gate 2 passes.
