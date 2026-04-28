# V2: Codebase Patterns Verification Report

Date: 2026-04-28
Plan: /home/d/Desktop/Archon-canonical/.hermes/plans/2026-04-28-workflow-yaml-fixes.md
Files verified:

- .archon/workflows/hermes-pr-verifier.yaml (371 lines, 5 bash nodes)
- .archon/workflows/archon-adversarial-fix.yaml (354 lines, 5 bash nodes)
- .archon/workflows/archon-audit-to-pr.yaml (516 lines, 4 bash nodes)

Total bash nodes across 3 files: 14

---

## T1.1: Fix `set -eo pipefail` in all 3 setup nodes (F-002)

**Verdict: PARTIALLY VERIFIED — Plan significantly UNDERSTATES the scope**

Plan claims: "All 3 YAML files, setup node bash blocks" (3 nodes)
Reality: `set -e` (without pipefail) appears in ALL 14 bash nodes across the 3 files.

Evidence — instances of `set -e` (without pipefail):

hermes-pr-verifier.yaml (5 instances):
Line 26: scope node
Line 67: setup node
Line 185: type-check node
Line 204: lint-check node
Line 223: test-gates node

archon-adversarial-fix.yaml (5 instances):
Line 25: parse-audit node
Line 62: setup node
Line 204: type-check node
Line 223: lint-check node
Line 238: test-gates node

archon-audit-to-pr.yaml (1 instance):
Line 290: setup node

Zero instances of `set -eo pipefail` found in any of the 3 files. Confirmed.

Note: archon-audit-to-pr.yaml has 3 other bash nodes (scope line 21, branch-setup line 272, validate line 361) that have NO `set -e` at all — these are also affected but the plan doesn't mention them.

**Plan's Before/After code snippet**: Matches reality (line 67 of hermes-pr-verifier.yaml shows `set -e` followed by `bun install --frozen-lockfile 2>&1 | tail -5`).

**MISSED**: The plan says "3 setup nodes" but there are 11 instances of `set -e` without pipefail, plus 3 bash nodes with no error handling at all (14 total affected).

---

## T1.2: Let validation gates fail naturally (F-003, F-005)

**Verdict: PARTIALLY VERIFIED — Plan's Before snippet for hermes-pr-verifier is correct but INCOMPLETE about archon-adversarial-fix**

### hermes-pr-verifier.yaml — `exit 0` in FAIL branches:

type-check node (lines 191-197):
Line 193: exit 0 (PASS branch)
Line 196: exit 0 # Don't fail the workflow — let the evaluator decide (FAIL branch)
MATCHES plan's Before snippet exactly.

lint-check node (lines 210-216):
Line 212: exit 0 (PASS branch)
Line 215: exit 0 (FAIL branch)
Plan mentions type-check but NOT lint-check or test-gates explicitly.

test-gates node (lines 229-243):
Line 239: exit 0 (PASS branch of full test suite)
Line 242: exit 0 (FAIL branch of full test suite)
Note: hermes provider tests block (lines 229-233) does NOT have exit 0 — it falls through.
Plan doesn't mention test-gates specifically.

### archon-adversarial-fix.yaml — `|| true` and `exit 0`:

type-check node (lines 210-216):
Line 212: exit 0 (PASS)
Line 215: exit 0 (FAIL)
Uses if/fi pattern like hermes-pr-verifier, NOT || true.
Plan's Before snippet for archon-adversarial-fix.yaml claims:
`bun run lint --max-warnings 0 2>&1 || true`
This is CORRECT for the lint-check node (line 229), but the plan only shows one pattern.
The type-check node uses a DIFFERENT pattern (if/fi with exit 0).

lint-check node (lines 228-231):
Line 229: `NODE_OPTIONS="--max-old-space-size=4096" bun run lint --max-warnings 0 2>&1 || true`
Line 231: exit 0
MATCHES plan's Before snippet.

test-gates node (lines 243-251):
Line 244: `bun test packages/providers/src/hermes/ 2>&1 || true`
Line 248: `bun run test 2>&1 || true`
Line 250: exit 0
Plan does NOT show this snippet explicitly.

### archon-audit-to-pr.yaml — validate node (lines 361-392):

validate node:
No `|| true`. No forced `exit 0`. Uses exit code capture pattern:
Line 364: `TC_EXIT=$?` captures exit code
This node DOES let failures propagate via exit code capture, but has no `set -e`.

**Summary of || true / exit 0 occurrences in 3 target files:**

|| true instances:
archon-adversarial-fix.yaml: line 229, 244, 248 (3 instances)
hermes-pr-verifier.yaml: 0 instances
archon-audit-to-pr.yaml: 0 instances

exit 0 instances:
hermes-pr-verifier.yaml: lines 193, 196, 212, 215, 239, 242 (6 instances)
archon-adversarial-fix.yaml: lines 212, 215, 231, 250 (4 instances)
archon-audit-to-pr.yaml: 0 instances

**MISSED**: The plan's T1.2 Before snippet only shows the type-check pattern for hermes-pr-verifier and the lint pattern for archon-adversarial-fix. It does not show the test-gates patterns in either file. The plan also doesn't discuss archon-audit-to-pr's validate node at all (though it doesn't have the anti-pattern).

---

## T2.1: Sanitize $ARGUMENTS (F-001)

**Verdict: VERIFIED — But plan understates scope**

Plan claims: "All 3 YAML files, scope/parse nodes"
Reality: $ARGUMENTS is interpolated in bash blocks in all 3 files.

Evidence — $ARGUMENTS in bash blocks (not prompts):

hermes-pr-verifier.yaml:
Line 44: `if [ -n "$ARGUMENTS" ]; then`
Line 45: `echo "$ARGUMENTS"`
(scope node — 1 bash block)

archon-adversarial-fix.yaml:
Line 39: `if [ -n "$ARGUMENTS" ]; then`
Line 40: `echo "$ARGUMENTS" | head -100`
(parse-audit node — 1 bash block)

archon-audit-to-pr.yaml:
Line 23: `echo "User request: $ARGUMENTS"`
Line 27: `REQUEST_LOWER=$(echo "$ARGUMENTS" | tr '[:upper:]' '[:lower:]')`
(scope node — 2 interpolations)

Additionally, $ARGUMENTS appears in prompt blocks (not bash) in:
archon-adversarial-fix.yaml: lines 100, 264, 317 (fix-designer, adversarial-review, final-report)
These are prompt interpolations, not shell injection risks.

**MISSED**: archon-audit-to-pr.yaml line 27 passes $ARGUMENTS through `echo` and `tr` — this is a pipeline that could be exploited with specially crafted input containing shell metacharacters. The plan mentions sanitization but doesn't highlight that archon-audit-to-pr has the MOST dangerous usage (piping through echo into tr and grep).

---

## T2.2: Quote $TARGET_DIRS iteration (F-010)

**Verdict: VERIFIED**

Plan claims: "archon-audit-to-pr.yaml, audit-domain nodes"
Reality: `for dir in $TARGET_DIRS` appears exactly in archon-audit-to-pr.yaml.

Evidence:
Line 52: `for dir in $TARGET_DIRS; do` (FILE INVENTORY section)
Line 61: `for dir in $TARGET_DIRS; do` (SIZE ANALYSIS section)

2 instances, both in the scope node. Plan's Before/After snippet is accurate.

**No MISSED patterns** — this pattern only exists in archon-audit-to-pr.yaml.

---

## T3.3: Guard $ARTIFACTS_DIR (F-013)

**Verdict: VERIFIED — But plan significantly UNDERSTATES the scope**

Plan claims: "All 3 YAML files, every bash node"
Reality: ZERO bash nodes have $ARTIFACTS_DIR guards. The plan is correct about the scope of the problem.

Bash node count and ARTIFACTS_DIR usage:

hermes-pr-verifier.yaml (5 bash nodes, 0 have guards):

- scope (line 24): writes to $ARTIFACTS_DIR (line 29)
- setup (line 65): reads from $ARTIFACTS_DIR (line 69)
- type-check (line 183): reads from $ARTIFACTS_DIR (line 187)
- lint-check (line 202): reads from $ARTIFACTS_DIR (line 206)
- test-gates (line 221): reads from $ARTIFACTS_DIR (line 225)

archon-adversarial-fix.yaml (5 bash nodes, 0 have guards):

- parse-audit (line 23): writes to $ARTIFACTS_DIR (line 28)
- setup (line 60): reads from $ARTIFACTS_DIR (line 64)
- type-check (line 202): reads from $ARTIFACTS_DIR (line 206)
- lint-check (line 221): reads from $ARTIFACTS_DIR (line 225)
- test-gates (line 236): reads from $ARTIFACTS_DIR (line 240)

archon-audit-to-pr.yaml (4 bash nodes, 0 have guards):

- scope (line 21): writes to $ARTIFACTS_DIR (lines 68, 69)
- branch-setup (line 272): reads/writes $ARTIFACTS_DIR (lines 273, 279)
- setup (line 288): does NOT use $ARTIFACTS_DIR
- validate (line 361): does NOT use $ARTIFACTS_DIR

Total: 14 bash nodes, 10 use $ARTIFACTS_DIR, 0 have guards.

**MISSED**: The plan says "every bash node" needs a guard, but 4 nodes (archon-audit-to-pr: setup, validate) don't use $ARTIFACTS_DIR at all. The guard is only needed for the 10 nodes that actually reference it.

---

## T5.1: Replace git add -A with explicit staging (F-008)

**Verdict: VERIFIED**

Plan claims: "archon-adversarial-fix.yaml, archon-audit-to-pr.yaml"
Reality: `git add -A` appears in exactly these 2 files (as instructions in prompt blocks).

Evidence:
archon-adversarial-fix.yaml line 190:
`git add -A && git commit -m "fix(hermes): F-XXX — description"`
(in implement-fixes prompt)

archon-audit-to-pr.yaml line 346:
`6. Commit: \`git add -A && git commit -m "fix(audit): [task description]"\``
(in implement-fixes prompt)

archon-audit-to-pr.yaml line 424:
`- Commit each fix: \`git add -A && git commit -m "fix(audit): [description]"\``
(in fix-validation-failures prompt)

hermes-pr-verifier.yaml: 0 instances. Correct — it's a read-only verifier.

**No MISSED patterns** — git add -A only exists in the 2 files the plan identified.

---

## Additional MISSED PATTERNS

### M1: Missing `set -e` entirely (no error handling at all)

3 bash nodes have NO `set -e` whatsoever:

archon-audit-to-pr.yaml:

- scope node (line 21): No shebang, no set -e. Runs grep, find, echo pipelines.
- branch-setup node (line 272): No shebang, no set -e. Runs git checkout -b.
- validate node (line 361): No shebang, no set -e. Runs bun commands and captures exit codes.

The plan's T3.1 mentions adding `set -e` to branch-setup but does NOT mention the scope or validate nodes.

### M2: Inconsistent WORKDIR patterns

hermes-pr-verifier.yaml:

- scope (line 28): `WORKDIR="$(pwd)"` then writes to .workdir
- setup/type-check/lint-check/test-gates: reads from .workdir via `cat`

archon-adversarial-fix.yaml:

- parse-audit (line 27): `WORKDIR="$(pwd)"` then writes to .workdir
- setup/type-check/lint-check/test-gates: reads from .workdir via `cat`

archon-audit-to-pr.yaml:

- scope (line 292): `WORKDIR="$(pwd)"` then `cd "$WORKDIR"` (NO-OP — T3.4 covers this)
- branch-setup (line 272): Does NOT set WORKDIR at all
- setup (line 292): `WORKDIR="$(pwd)"` then `cd "$WORKDIR"` (NO-OP)

Plan's T3.4 mentions the no-op in scope but MISSES the same no-op in setup node (line 292-293).

### M3: archon-audit-to-pr.yaml validate node runs commands without `set -e`

The validate node (line 361) runs `bun run type-check 2>&1`, `bun run lint 2>&1`, etc.
It captures exit codes with `$?`, but without `set -e`, if a command is NOT FOUND (e.g., bun not installed), the script will continue silently. The plan doesn't discuss this node's error handling.

### M4: Prompt-based $ARGUMENTS in archon-adversarial-fix.yaml

$ARGUMENTS appears in 3 prompt blocks (lines 100, 264, 317) that are fed to LLM agents.
While not a shell injection risk, these are unsanitized user input passed to LLM prompts,
which could enable prompt injection attacks. The plan only discusses shell sanitization.

### M5: The plan's file line counts are accurate

Plan claims:

- hermes-pr-verifier.yaml: 371 lines → VERIFIED (371)
- archon-adversarial-fix.yaml: 354 lines → VERIFIED (354)
- archon-audit-to-pr.yaml: 516 lines → VERIFIED (516)

---

## Summary Table

| Task | Verdict            | Key Discrepancy                                                                                                          |
| ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| T1.1 | PARTIALLY VERIFIED | Plan says 3 nodes; actually 14 bash nodes affected (11 with set -e, 3 with no error handling)                            |
| T1.2 | PARTIALLY VERIFIED | Before snippets correct for shown examples; plan omits test-gates patterns and archon-adversarial-fix type-check pattern |
| T2.1 | VERIFIED           | All 3 files confirmed; archon-audit-to-pr has most dangerous usage (pipe to tr/grep)                                     |
| T2.2 | VERIFIED           | 2 instances in archon-audit-to-pr.yaml scope node, exact match                                                           |
| T3.3 | VERIFIED           | 0/14 bash nodes have guards; plan scope correct but says "every node" when only 10/14 use ARTIFACTS_DIR                  |
| T5.1 | VERIFIED           | Exactly 2 files (3 instances total), exact match                                                                         |

## Overall Assessment

The plan's technical direction is CORRECT — all identified anti-patterns exist in the codebase.
However, the plan SIGNIFICANTLY UNDERSTATES the scope of T1.1 (set -e without pipefail).
The plan claims "3 setup nodes" need the fix, but ALL 14 bash nodes across the 3 files are affected.
This means the execution strategy (Batch 1, 3 parallel executors) will need to touch more nodes
than the plan suggests, but the fix is mechanical (find-replace `set -e` → `set -eo pipefail`).

The Before/After code snippets shown in the plan are accurate representations of the actual code.
No snippets were found to be fabricated or mismatched.

Risk: MEDIUM — The plan is directionally correct but an executor following it literally would
fix only 3/14 bash nodes for T1.1, leaving 11 nodes unfixed.
