# Plan — Workflow YAML Fixes (21 Findings)

> Source: hermes-pr-verifier workflow assessment (0/10, 21 findings)
> Date: 2026-04-28
> Status: DRAFT — pending verifier/executor dispatch

---

## Summary

The hermes-pr-verifier workflow ran to completion and produced a 0/10 verdict with 21 findings.
The hermes agents successfully identified architectural issues in the 3 workflow YAML files.
This plan addresses all 21 findings in dependency order.

## Files Affected

- `.archon/workflows/hermes-pr-verifier.yaml` (371 lines)
- `.archon/workflows/archon-adversarial-fix.yaml` (354 lines)
- `.archon/workflows/archon-audit-to-pr.yaml` (516 lines)

---

## Phase 1: Gate Pattern Fix (F-002, F-003, F-005, F-010) — ROOT CAUSE

**Why first:** The gate pattern is the root cause of most findings. Fixing it cascades
into F-003, F-005, F-006, F-007, and F-012.

### T1.1: Fix `set -eo pipefail` in ALL 14 bash nodes (F-002)

**Files:** All 3 YAML files, ALL bash nodes (not just setup)
**Change:** `set -e` → `set -eo pipefail`
**Why:** `set -e` only checks the last command in a pipeline. `tail -5` always exits 0.
With `pipefail`, the pipeline exit code is the rightmost command with a non-zero exit.

**Affected nodes (14 total):**

- hermes-pr-verifier.yaml: scope(L26), setup(L67), type-check(L185), lint-check(L204), test-gates(L223)
- archon-adversarial-fix.yaml: parse-audit(L25), setup(L62), type-check(L204), lint-check(L223), test-gates(L238)
- archon-audit-to-pr.yaml: setup(L290) — has `set -e`
- archon-audit-to-pr.yaml: scope(L21), branch-setup(L272), validate(L361) — have NO `set -e` at all, add `set -eo pipefail`

**VERIFIER CORRECTION:** Original plan said "3 setup nodes". V2 found ALL 14 bash nodes
are affected (11 have `set -e` without pipefail, 3 have no error handling at all).

**PLANNER B EXCEPTIONS:**

- EXCLUDE validate node (archon-audit-to-pr.yaml L361) — it's designed to capture exit codes
  from all checks. Adding `set -eo pipefail` would exit at first failure, preventing
  subsequent checks from running and the summary from being printed.
- branch-setup node (archon-audit-to-pr.yaml L272): Add `|| true` on the cat pipe line
  for graceful fallback when .audit-target file doesn't exist:
  `TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n' || true)`

**ACTUAL AFFECTED NODES: 13** (14 minus validate node)

```yaml
# Before:
set -e
bun install --frozen-lockfile 2>&1 | tail -5

# After:
set -eo pipefail
bun install --frozen-lockfile 2>&1 | tail -5
```

### T1.2: Let validation gates fail naturally (F-003, F-005)

**Files:** All 3 YAML files, validation gate bash blocks
**Change:** Remove `|| true` and forced `exit 0` on FAIL branches. Let bash nodes
exit non-zero when checks fail. Downstream nodes use `trigger_rule: all_done`
which already handles failed state.

```yaml
# Before (hermes-pr-verifier.yaml):
if bun run type-check 2>&1; then
  echo "PASS: type-check"
  exit 0
else
  echo "FAIL: type-check"
  exit 0  # Don't fail the workflow
fi

# After:
if bun run type-check 2>&1; then
  echo "PASS: type-check"
else
  echo "FAIL: type-check"
  exit 1
fi
```

```yaml
# Before (archon-adversarial-fix.yaml):
bun run lint --max-warnings 0 2>&1 || true
echo "DONE: lint"
exit 0

# After:
bun run lint --max-warnings 0 2>&1
echo "EXIT_CODE: $?"
```

**Impact on trigger rules:**

- evaluate node (hermes-pr-verifier): already uses `trigger_rule: all_done` — handles failed state
- adversarial-review (archon-adversarial-fix): uses `trigger_rule: all_done` — handles failed state
- synthesize (archon-audit-to-pr): uses `trigger_rule: one_success` — must change to `none_failed_min_one_success` (T4.1)

**PLANNER B EXCEPTION — validate node (archon-audit-to-pr.yaml):**
The validate node is NOT a gate. It runs ALL checks and reports results via VALIDATION_STATUS.
KEEP `exit 0` at the end. Downstream fix-validation-failures reads the output and decides.
Do NOT remove `exit 0` from this node.

### T1.3: Write structured gate results (F-005 enhancement)

**Files:** All 3 YAML files, validation gate bash blocks
**Change:** Write gate results as structured JSON to `$ARTIFACTS_DIR/gate-results.json`
so downstream nodes can read results deterministically instead of parsing free-form text.

```bash
# At the end of each gate:
echo "{\"gate\":\"type-check\",\"passed\":$([ $TC_EXIT -eq 0 ] && echo true || echo false),\"exitCode\":$TC_EXIT}" >> "$ARTIFACTS_DIR/gate-results.json"
```

### T1.4: Lint gate OOM fix (F-006)

**File:** hermes-pr-verifier.yaml, lint-check node
**Change:** Increase `NODE_OPTIONS --max-old-space-size` or run lint with explicit heap.
The current value may be insufficient for the full codebase.

```yaml
NODE_OPTIONS="--max-old-space-size=8192" bun run lint --max-warnings 0 2>&1
```

### T1.5: Test gate empty output fix (F-007)

**File:** hermes-pr-verifier.yaml, test-gates node
**Change:** Ensure test gate produces verifiable output. The current 5-min timeout may
be too short for the full test suite. Increase timeout or split into targeted test runs.

```yaml
# Option A: Increase timeout
timeout: 600000  # 10 min

# Option B: Run targeted tests first, then full suite
bun test packages/providers/src/hermes/ 2>&1 | tail -20
bun run test 2>&1 | tail -30
```

---

## Phase 2: Shell Injection & Input Sanitization (F-001, F-010, F-014)

### T2.1: Sanitize $ARGUMENTS (F-001)

**Files:** All 3 YAML files, scope/parse nodes
**Change:** Strip shell metacharacters from $ARGUMENTS before any shell interpolation.
Use allowlist-based matching instead of regex.

```bash
# At the start of each bash block that uses $ARGUMENTS:
if [ -n "$ARGUMENTS" ]; then
  # Strip shell metacharacters (blocklist, not allowlist — allowlist strips / from paths)
  SAFE_ARGUMENTS=$(printf '%s' "$ARGUMENTS" | tr -d ';\|&$`<>(){}[]!\\' | head -c 500)
else
  SAFE_ARGUMENTS=""
fi

# Use case statement instead of regex matching:
case "$SAFE_ARGUMENTS" in
  *provider*|*providers*) TARGET="providers" ;;
  *workflow*|*workflows*) TARGET="workflows" ;;
  *) TARGET="general" ;;
esac
```

### T2.2: Quote $TARGET_DIRS iteration (F-010)

**File:** archon-audit-to-pr.yaml, audit-domain nodes
**Change:** Use `while IFS= read -r` instead of `for dir in $TARGET_DIRS`

```bash
# Before:
for dir in $TARGET_DIRS; do

# After:
echo "$TARGET_DIRS" > "$ARTIFACTS_DIR/.audit-target-dirs"
while IFS= read -r dir; do
  ...
done < "$ARTIFACTS_DIR/.audit-target-dirs"
```

### T2.3: Sanitize branch name (F-014)

**File:** archon-audit-to-pr.yaml, branch-setup node
**Change:** Strip non-alphanumeric characters from TARGET before using in branch name

```bash
TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n' | tr -cd 'a-zA-Z0-9-')
```

---

## Phase 3: Error Handling & Validation (F-009, F-011, F-013, F-021)

### T3.1: Add `set -e` to branch-setup (F-009)

**File:** archon-audit-to-pr.yaml, branch-setup node
**Change:** Add `set -e` at the top of the bash block

### T3.2: Validate .workdir after reading (F-011)

**Files:** All 3 YAML files, nodes that read .workdir
**Change:** Check path exists and is a directory before `cd`

```bash
WORKDIR="$(cat "$ARTIFACTS_DIR/.workdir")"
if [ ! -d "$WORKDIR" ]; then
  echo "ERROR: Invalid workdir: $WORKDIR"
  exit 1
fi
cd "$WORKDIR"
```

### T3.3: Guard $ARTIFACTS_DIR (F-013)

**Files:** All 3 YAML files, every bash node
**Change:** Check $ARTIFACTS_DIR is set and exists at the start of each bash block

```bash
if [ -z "$ARTIFACTS_DIR" ] || [ ! -d "$ARTIFACTS_DIR" ]; then
  echo "ERROR: ARTIFACTS_DIR is not set or does not exist"
  exit 1
fi
```

### T3.4: Fix pwd → cd no-op (F-021)

**File:** archon-audit-to-pr.yaml, scope node (L292-293) AND setup node (L292-293)
**Change:** Remove the no-op `WORKDIR="$(pwd)" && cd "$WORKDIR"` in BOTH nodes.
Use the same pattern as other files: save to `$ARTIFACTS_DIR/.workdir` for downstream nodes.

**VERIFIER CORRECTION:** V2 found the no-op exists in BOTH scope AND setup nodes of
archon-audit-to-pr.yaml. Original plan only mentioned scope.

**PLANNER B ADDITION:** The scope node in archon-audit-to-pr.yaml does NOT write
`.workdir` to artifacts at all. The shared setup script (T6.3) reads `.workdir` from
artifacts. The scope node MUST add: `echo "$(pwd)" > "$ARTIFACTS_DIR/.workdir"`

---

## Phase 4: Trigger Rules (F-004)

### T4.1: Change synthesize trigger to none_failed_min_one_success (F-004)

**File:** archon-audit-to-pr.yaml, synthesize node
**Change:** `trigger_rule: one_success` → `trigger_rule: none_failed_min_one_success`
**Why:** With `one_success`, 3/4 audits can fail and the master report generates from 25% data.

---

## Phase 5: Git Safety (F-008, F-015, F-016, F-017, F-020)

### T5.1: Replace git add -A with explicit staging (F-008)

**Files:** archon-adversarial-fix.yaml, archon-audit-to-pr.yaml
**Change:** Replace `git add -A` with `git add <specific files>` in all prompts.
Instruct the agent to only stage files it modified.

### T5.2: Add timeout to create-pr node (F-015)

**File:** archon-audit-to-pr.yaml, create-pr node
**Change:** Add `timeout: 300000` to the node definition
**NOTE:** 120000 is the engine default (dag-executor.ts:1201). Create-pr needs more
time for gh CLI operations. 300000 = 5 min.

### T5.3: Sanitize commit messages (F-016)

**Files:** All 3 YAML files, prompts that construct commit messages
**Change:** Instruct agents to use only finding IDs in commit messages, not full descriptions.
Single line, under 72 chars, no raw user input.

### T5.4: Verify remote before push (F-017)

**File:** archon-audit-to-pr.yaml, create-pr node
**Change:** Add remote URL verification before `git push`

### T5.5: Abort create-pr on push failure (F-020)

**File:** archon-audit-to-pr.yaml, create-pr prompt
**Change:** Instruct agent to abort if `git push` fails

---

## Phase 6: Infrastructure & Cleanup (F-012, F-018, F-019)

### T6.1: Document review agent fragility (F-012)

**File:** hermes-pr-verifier.yaml
**Change:** Add comment noting review agents don't need deps but shouldn't be
instructed to run code

### T6.2: Verify default model (F-018)

**Manual check:** Verify mimo-v2.5-pro (hermes default) produces adequate
adversarial rigor for the evaluator node

### T6.3: Extract shared setup script (F-019)

**Files:** All 3 YAML files
**Change:** Extract the 35-line setup bash block into a shared script referenced
by all 3 workflows. Reduces duplication from 3 copies to 1.

**VERIFIER CORRECTION:** V3 found that `!include` is NOT supported by the Archon engine
(Bun.YAML.parse has no custom tags). The shared script must use shell `source` instead.

**File:** `.archon/workflows/scripts/setup-deps.sh` (created as a standalone bash script)

```bash
#!/bin/bash
set -eo pipefail
if [ -z "$ARTIFACTS_DIR" ] || [ ! -d "$ARTIFACTS_DIR" ]; then
  echo "ERROR: ARTIFACTS_DIR is not set or does not exist"
  exit 1
fi
WORKDIR="$(cat "$ARTIFACTS_DIR/.workdir")"
if [ ! -d "$WORKDIR" ]; then
  echo "ERROR: Invalid workdir: $WORKDIR"
  exit 1
fi
cd "$WORKDIR"
if [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
  bun install --frozen-lockfile 2>&1 | tail -5
elif [ -f "package-lock.json" ]; then
  npm ci 2>&1 | tail -5
fi
```

**Usage in YAML files** (replace the inline setup bash block):

```yaml
- id: setup
  bash: |
    source .archon/workflows/scripts/setup-deps.sh
  depends_on: [scope]
  timeout: 300000
```

---

## Execution Strategy

### Batch 1 (P0 — Gate Pattern Fix, parallel per file):

- E1: hermes-pr-verifier.yaml — 5 bash nodes: set -eo pipefail + remove exit 0 on FAIL
- E2: archon-adversarial-fix.yaml — 5 bash nodes: set -eo pipefail + remove || true + exit 0
- E3: archon-audit-to-pr.yaml — 3 bash nodes (NOT validate): set -eo pipefail + trigger rule change

### Gate 1 (single verifier):

- grep -c 'set -eo pipefail' per file (expect 5, 5, 3)
- grep -c '|| true' in .archon/workflows/ (expect 0)
- Validate YAML: bun run cli validate workflows (all 3)

### Batch 2 (P1 — Security & Reliability, parallel per file):

- E4: hermes-pr-verifier.yaml — sanitize $ARGUMENTS + workdir validation + ARTIFACTS_DIR guard + lint OOM + test timeout
- E5: archon-adversarial-fix.yaml — sanitize $ARGUMENTS + workdir validation + ARTIFACTS_DIR guard
- E6: archon-audit-to-pr.yaml — sanitize $ARGUMENTS + $TARGET_DIRS + branch name + workdir + .workdir write + no-op fix

### Gate 2 (single verifier):

- Verify no unquoted $ARGUMENTS in bash blocks
- Verify ARTIFACTS_DIR guard in nodes that use it
- Verify .workdir written in scope nodes

### Batch 3 (P2 — Git Safety, sequential):

- E7: Replace git add -A + timeout + commit sanitization + remote verification + abort on push fail

### Gate 3 (single verifier):

- grep -c 'git add -A' (expect 0)
- Verify timeout on create-pr

### Batch 4 (P3 — Infrastructure):

- E8: Shared setup script + documentation

### Gate 4 (final):

- All 21 findings addressed
- All YAML files valid
- No anti-patterns remaining

---

## Verification Commands

```bash
# Validate workflow YAML
bun run cli validate workflows hermes-pr-verifier
bun run cli validate workflows archon-adversarial-fix
bun run cli validate workflows archon-audit-to-pr

# Structural checks
grep -n 'set -eo pipefail' .archon/workflows/hermes-pr-verifier.yaml
grep -n 'set -eo pipefail' .archon/workflows/archon-adversarial-fix.yaml
grep -n 'set -eo pipefail' .archon/workflows/archon-audit-to-pr.yaml
grep -rn '|| true' .archon/workflows/  # should return 0 results
grep -rn 'exit 0' .archon/workflows/  # should return 0 results
grep -rn 'git add -A' .archon/workflows/  # should return 0 results
grep -n 'none_failed_min_one_success' .archon/workflows/archon-audit-to-pr.yaml

# Full validation
bun run type-check
bun run lint
```
