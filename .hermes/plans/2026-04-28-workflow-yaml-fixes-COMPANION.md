# Companion Document — Workflow YAML Fixes Session

> Created: 2026-04-28
> Purpose: Full context for resuming work after reboot
> Status: READY FOR EXECUTOR DISPATCH

---

## 1. What Happened This Session

### Timeline

1. Ran hermes-pr-verifier workflow → 0/10 verdict, 21 findings
2. Wrote initial plan to fix all 21 findings
3. Dispatched 3 verifiers (V1 requirements, V2 codebase, V3 protocol)
4. V2 found critical discrepancy: plan said "3 nodes" but 14 bash nodes affected
5. Applied 5 verifier corrections to plan
6. Dispatched 3 planners (A issue+docs, B engine source, C execution order)
7. Planner A discovered issue #1106 is about provider integration, not workflow quality
8. Planner B found 3 critical exceptions (validate node, branch-setup pipe, scope .workdir)
9. Applied 6 planner corrections to plan
10. Plan is now VERIFIED + PATCHED with 11 total corrections

### Issue #1106 Clarification

- URL: https://github.com/coleam00/Archon/issues/1106 (NOT nicepkg/Archon — that 404s)
- Title: "Hermes Agent integration"
- Content: Feature request to add Hermes as third AI assistant provider
- The 21 findings are quality improvements to workflows created AS PART of the integration
- Reframe: "hardening Hermes-powered workflows" not "resolving issue #1106"
- Provider integration is already complete (multiple fix(hermes) commits on dev)

---

## 2. Current Plan State

**File:** `.hermes/plans/2026-04-28-workflow-yaml-fixes.md` (~390 lines)

### 21 Findings Addressed

| #     | Finding                             | Task | Priority |
| ----- | ----------------------------------- | ---- | -------- |
| F-001 | Shell injection in $ARGUMENTS       | T2.1 | P1       |
| F-002 | set -e masked by pipes              | T1.1 | P0       |
| F-003 | Gates force exit 0                  | T1.2 | P0       |
| F-004 | one_success trigger allows 25% data | T4.1 | P0       |
| F-005 | Gate results not structured         | T1.3 | P0       |
| F-006 | Lint OOM                            | T1.4 | P1       |
| F-007 | Test gate empty output              | T1.5 | P1       |
| F-008 | git add -A stages everything        | T5.1 | P2       |
| F-009 | branch-setup missing set -e         | T3.1 | P1       |
| F-010 | $TARGET_DIRS word splitting         | T2.2 | P1       |
| F-011 | .workdir not validated              | T3.2 | P1       |
| F-012 | Review agent fragility              | T6.1 | P3       |
| F-013 | $ARTIFACTS_DIR not guarded          | T3.3 | P1       |
| F-014 | Branch name not sanitized           | T2.3 | P1       |
| F-015 | create-pr no timeout                | T5.2 | P2       |
| F-016 | Commit messages not sanitized       | T5.3 | P2       |
| F-017 | No remote verification before push  | T5.4 | P2       |
| F-018 | Default model adequacy              | T6.2 | P3       |
| F-019 | Duplicated setup script             | T6.3 | P3       |
| F-020 | No abort on push failure            | T5.5 | P2       |
| F-021 | pwd → cd no-op                      | T3.4 | P1       |

### 11 Corrections Applied

1. T1.1: 3 nodes → 13 nodes (validate excluded — captures exit codes)
2. T1.1: branch-setup needs || true on cat pipe (graceful fallback)
3. T1.2: KEEP exit 0 on validate node (it REPORTS, doesn't GATE)
4. T2.1: blocklist not allowlist (allowlist strips / from paths)
5. T3.4: scope node needs .workdir write added
6. L85: cross-ref T3.1 → T4.1
7. T3.4: no-op in BOTH scope AND setup nodes
8. T6.3: shell source, not !include (Archon engine doesn't support !include)
9. T5.2: timeout 300000 (not 120000 which is engine default)
10. Issue #1106 = provider integration, not workflow quality
11. Execution strategy: 4 batches, 4 gates, P0→P3 priority

---

## 3. Execution Strategy (Ready to Go)

```
BATCH 1 (P0 — Gate Pattern Fix): 3 parallel executors
  E1: hermes-pr-verifier.yaml — 5 bash nodes: set -eo pipefail + remove exit 0 on FAIL
  E2: archon-adversarial-fix.yaml — 5 bash nodes: set -eo pipefail + remove || true + exit 0
  E3: archon-audit-to-pr.yaml — 3 bash nodes (NOT validate): set -eo pipefail + trigger rule
  → GATE 1: structural grep + YAML validation

BATCH 2 (P1 — Security & Reliability): 3 parallel executors
  E4: hermes-pr-verifier.yaml — sanitize $ARGUMENTS + workdir + guards + OOM + timeout
  E5: archon-adversarial-fix.yaml — sanitize $ARGUMENTS + workdir + guards
  E6: archon-audit-to-pr.yaml — sanitize + $TARGET_DIRS + branch name + .workdir + no-op
  → GATE 2: security pattern verification

BATCH 3 (P2 — Git Safety): 1 sequential executor
  E7: git add -A → explicit staging + timeout + commit sanitization + remote verify
  → GATE 3: git safety verification

BATCH 4 (P3 — Infrastructure): 1 sequential executor
  E8: Shared setup script + documentation
  → GATE 4: final comprehensive verification
```

---

## 4. Files Affected

| File                                            | Bash Nodes | Changes                                                                   |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `.archon/workflows/hermes-pr-verifier.yaml`     | 5          | T1.1, T1.2, T1.4, T1.5, T2.1, T3.2, T3.3                                  |
| `.archon/workflows/archon-adversarial-fix.yaml` | 5          | T1.1, T1.2, T2.1, T3.2, T3.3, T5.1, T5.3                                  |
| `.archon/workflows/archon-audit-to-pr.yaml`     | 4          | T1.1 (3 nodes), T2.1, T2.2, T2.3, T3.1, T3.2, T3.3, T3.4, T4.1, T5.1-T5.5 |
| `.archon/workflows/scripts/setup-deps.sh`       | NEW        | T6.3 shared setup script                                                  |

---

## 5. Key Technical Facts (Verified Against Source)

### Archon Workflow Engine

- Bash nodes: `execFileAsync('bash', ['-c', script])` — dag-executor.ts:1273
- Auto env vars: ARTIFACTS_DIR, LOG_DIR, BASE_BRANCH + process.env — dag-executor.ts:1264-1270
- $ARGUMENTS: text-substituted BEFORE bash execution, NOT auto-quoted — executor-shared.ts:312
- $nodeId.output: auto shell-quoted when substituted into bash — executor-shared.ts:312
- Default timeout: 120,000ms — dag-executor.ts:1201
- No !include support: Bun.YAML.parse has no custom tags — loader.ts:28-30
- Trigger rules: all_success (default), one_success, none_failed_min_one_success, all_done — dag-node.ts:24-29

### Planner B Exceptions (Critical)

1. **validate node** (archon-audit-to-pr.yaml): Must NOT get `set -eo pipefail`. Designed to capture exit codes from ALL checks. KEEP exit 0.
2. **branch-setup node**: Needs `|| true` on cat pipe: `TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n' || true)`
3. **scope node** (archon-audit-to-pr.yaml): Must add `echo "$(pwd)" > "$ARTIFACTS_DIR/.workdir"` — currently missing, shared setup script needs it.
4. **$ARGUMENTS sanitization**: Use blocklist `tr -d ';\|&$`<>(){}[]!\\'`not allowlist`tr -cd`— allowlist strips`/` from file paths.

### Verification Commands

```bash
# After Batch 1:
grep -c 'set -eo pipefail' .archon/workflows/hermes-pr-verifier.yaml    # expect 5
grep -c 'set -eo pipefail' .archon/workflows/archon-adversarial-fix.yaml # expect 5
grep -c 'set -eo pipefail' .archon/workflows/archon-audit-to-pr.yaml    # expect 3 (NOT 4)
grep -c '|| true' .archon/workflows/  # expect 0
bun run cli validate workflows hermes-pr-verifier
bun run cli validate workflows archon-adversarial-fix
bun run cli validate workflows archon-audit-to-pr

# After Batch 2:
grep -rn 'tr -d' .archon/workflows/  # verify sanitization present
grep -rn 'while IFS= read' .archon/workflows/archon-audit-to-pr.yaml  # expect >= 2
grep -c 'NODE_OPTIONS' .archon/workflows/hermes-pr-verifier.yaml  # expect >= 1

# After Batch 3:
grep -c 'git add -A' .archon/workflows/  # expect 0

# Final:
bun run type-check
bun run lint
```

---

## 6. Deliverables from Verification Rounds

| File | Content |
| ---- | ------- |

All in `.hermes/plans/2026-04-28-workflow-yaml-fixes-deliverables/`:

| File                             | Content                                                |
| -------------------------------- | ------------------------------------------------------ |
| `verifier-v1-requirements.md`    | V1: 21/21 findings covered, 3 minor issues             |
| `verifier-v2-codebase.md`        | V2: T1.1 scope understated (14 not 3), missed patterns |
| `verifier-v3-protocol.md`        | V3: 10/11 accurate, T6.3 !include WRONG                |
| `planner-A-hermes-docs.md`       | Issue #1106 analysis, Hermes docs, gap analysis        |
| `planner-B-codebase-patterns.md` | Engine source verification, 6 corrections              |
| `planner-C-execution-order.md`   | Reprioritized P0→P3, 4-batch strategy                  |

---

## 7. Skills Updated This Session

| Skill                       | Update                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `archon-hermes-methodology` | Added workflow YAML hardening section, planner B exceptions, 11 corrections, session history                               |
| `archon-hermes-methodology` | Added Lessons Learned section: event-bridge race, config discovery, workflow YAML patterns, gate timeout, per-node cleanup |

---

## 8. Mnemosyne Memories Saved

| ID               | Content                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| 2e6bb13936c56803 | Workflow YAML hardening plan status + execution strategy                   |
| 91751303f9418231 | Issue #1106 clarification (coleam00 not nicepkg)                           |
| 2d4d9f7e5b14b9cf | Planner B exceptions (validate, branch-setup, scope, sanitization)         |
| a5d67aada3eb8261 | Archon workflow engine internals (bash execution, env vars, trigger rules) |

---

## 9. Resume Instructions

When you come back:

1. Read this companion doc: `.hermes/plans/2026-04-28-workflow-yaml-fixes-COMPANION.md`
2. Read the plan: `.hermes/plans/2026-04-28-workflow-yaml-fixes.md`
3. Load skill: `archon-hermes-methodology`
4. Say "roll out" or "dispatch batch 1" to start executors
5. The methodology skill has the full pipeline and all corrections baked in

The plan is VERIFIED + PATCHED. All 11 corrections applied. Ready for executor dispatch.

---

## 10. Git State

- **Branch:** dev
- **Latest commits:** 15c1f200, 486c528d, b1da1479, 4966606e, 63357b9c, e8fa9db5, 1440fb5c, d060f412
- **259 Hermes tests pass** (unit + live)
- **Type-check clean**
- **No uncommitted changes to workflow YAML files yet** (executors will make the changes)
