# Planner B: Archon Codebase Pattern Verification

> Verified against: dag-executor.ts, dag-node.ts, loader.ts, executor-shared.ts,
> hermes/provider.ts, hermes/event-bridge.ts, and all 3 workflow YAML files.

---

## How the Archon Engine Executes Bash Nodes

### Execution mechanism (dag-executor.ts:1273)

```typescript
const { stdout, stderr } = await execFileAsync('bash', ['-c', finalScript], {
  cwd,
  timeout,
  env: subprocessEnv,
});
```

- Uses `bash -c` — full bash shell, NOT execFile with the script as an argument
- `source` works because it's a real bash invocation
- `cwd` is set by the executor (repo root or worktree root)
- `timeout` defaults to 120,000ms (2 min) if not specified in the node

### Auto-provided environment variables (dag-executor.ts:1264-1270)

```typescript
const subprocessEnv: NodeJS.ProcessEnv = {
  ...process.env, // full inherited environment
  ARTIFACTS_DIR: artifactsDir,
  LOG_DIR: logDir,
  BASE_BRANCH: baseBranch,
  ...(envVars ?? {}), // workflow-level env vars from config
};
```

Plus `$ARGUMENTS`, `$USER_MESSAGE`, `$WORKFLOW_ID`, `$DOCS_DIR` are substituted
into the script text BEFORE execution (not env vars — text substitution).

### Variable substitution order (dag-executor.ts:1252-1261)

1. `substituteWorkflowVariables()` — replaces $ARGUMENTS, $ARTIFACTS_DIR, $BASE_BRANCH, etc.
2. `substituteNodeOutputRefs()` — replaces $node_id.output references (shell-quoted for bash)

### Error propagation (dag-executor.ts:1319-1358)

- Non-zero exit → `execFileAsync` throws → caught → returns `{ state: 'failed', output: '', error: errorMsg }`
- Timeout → `err.killed === true` → returns `{ state: 'failed', ... }`
- Downstream nodes check trigger rules against upstream state

### Trigger rules (dag-executor.ts:467-498, dag-node.ts:24-29)

| Rule                          | Semantics                                                              |
| ----------------------------- | ---------------------------------------------------------------------- |
| `all_success` (default)       | ALL deps must be `completed` → run                                     |
| `one_success`                 | ANY dep `completed` → run (even if others failed)                      |
| `none_failed_min_one_success` | NO deps `failed` AND at least one `completed` → run                    |
| `all_done`                    | ALL deps not `pending`/`running` → run (regardless of success/failure) |

---

## Per-Task Verification

### T1.1: `set -eo pipefail` in ALL 14 bash nodes — ✅ CORRECT (with exceptions)

**Works because:** `bash -c` supports `set -eo pipefail`. The engine propagates
non-zero exit codes. `pipefail` ensures pipeline failures are caught.

**EXCEPTION — archon-audit-to-pr.yaml `validate` node (L361):**
This node is DESIGNED to run all checks and capture exit codes:

```bash
bun run type-check 2>&1
TC_EXIT=$?
```

Adding `set -eo pipefail` would make the script exit at the first failing command,
preventing subsequent checks from running and the summary from being printed.

**CORRECTION:** Do NOT add `set -eo pipefail` to the `validate` node. It should
keep its current pattern of manual exit code capture. The node has NO `set -e` by
design — this is correct behavior for a "run all checks and report" pattern.

**EXCEPTION — archon-audit-to-pr.yaml `branch-setup` node (L272):**

```bash
TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n')
```

With `set -eo pipefail`, if the file doesn't exist, `cat` fails, pipefail propagates
the non-zero exit through the pipe, and `set -e` exits the script. The `2>/dev/null`
only redirects stderr, not the exit code.

**CORRECTION:** When adding `set -eo pipefail` to branch-setup, change the cat line to:

```bash
TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n' || true)
```

This is NOT the same anti-pattern as `|| true` on validation gates — this is a
legitimate fallback/default pattern.

### T1.2: Let validation gates fail naturally — ✅ CORRECT (with nuance)

**hermes-pr-verifier.yaml gates (type-check, lint-check, test-gates):**
Currently: `exit 0` on both PASS and FAIL branches.
Change FAIL to `exit 1` — node becomes `failed` state.
Evaluate node uses `trigger_rule: all_done` → still runs. ✅ CORRECT

**archon-adversarial-fix.yaml gates (type-check, lint-check, test-gates):**
Currently: `|| true` + `exit 0`.
Remove `|| true`, remove forced `exit 0` — let commands fail naturally.
Adversarial-review uses `trigger_rule: all_done` → still runs. ✅ CORRECT

**archon-audit-to-pr.yaml validate node:**
This node is NOT a gate in the same sense. It runs all checks and reports results.
The downstream `fix-validation-failures` reads `$validate.output` and checks for
`VALIDATION_STATUS: PASS/FAIL`. The validate node should exit 0 always so the
downstream node can read its output and decide what to do.

**CORRECTION:** The validate node should keep `exit 0` at the end (or just let the
last command's exit code stand). The node's job is to REPORT, not to GATE.

**archon-audit-to-pr.yaml synthesize trigger rule:**
Change `trigger_rule: one_success` → `trigger_rule: none_failed_min_one_success`.
This is correct — prevents generating a report from 25% data when 3/4 audits fail.

BUT: With the new gate pattern (gates exit non-zero on failure), the audit-domain
prompt nodes (which use default `trigger_rule: all_success`) depend on `scope`.
If scope fails, all audit domains are skipped, and synthesize would have zero
upstream completions → skipped. This is correct behavior.

### T1.3: Structured gate results — ✅ CORRECT

Writing JSON to `$ARTIFACTS_DIR/gate-results.json` with `>>` append is fine.
The `$ARTIFACTS_DIR` env var is auto-provided by the engine.

### T1.4: Lint gate OOM — ✅ CORRECT

`NODE_OPTIONS="--max-old-space-size=8192"` is standard Node.js configuration.

### T1.5: Test gate timeout — ✅ CORRECT

Increasing timeout to 600000 (10 min) or splitting tests is fine.
The `timeout` field on bash nodes is in milliseconds (dag-node.ts:208).

### T2.1: Sanitize $ARGUMENTS — ✅ CORRECT

```bash
SAFE_ARGUMENTS=$(printf '%s' "$ARGUMENTS" | tr -cd 'a-zA-Z0-9 _-' | head -c 500)
```

`$ARGUMENTS` is text-substituted by the engine BEFORE bash execution.
The `tr -cd` allowlist approach is correct. `case` statement instead of regex is safer.

### T2.2: Quote $TARGET_DIRS iteration — ⚠️ PARTIALLY CORRECT

The `while IFS= read -r` pattern is correct for handling spaces in paths.
BUT: In the scope node of archon-audit-to-pr.yaml, `TARGET_DIRS` is set to known
safe values (hardcoded directory paths). The `for dir in $TARGET_DIRS` word splitting
is intentional and safe here. The change is only needed if TARGET_DIRS could contain
spaces or special chars from user input — which it can't in the current code.

**VERDICT:** The change is defensive and correct, but low priority for the scope node.
More important for any future node that might read TARGET_DIRS from artifacts.

### T2.3: Sanitize branch name — ✅ CORRECT

`tr -cd 'a-zA-Z0-9-'` strips non-alphanumeric chars before using in branch name.

### T3.1: Add `set -e` to branch-setup — ✅ CORRECT (with fix)

See T1.1 exception above — needs `|| true` on the cat pipe line.

### T3.2: Validate .workdir after reading — ✅ CORRECT

```bash
WORKDIR="$(cat "$ARTIFACTS_DIR/.workdir")"
if [ ! -d "$WORKDIR" ]; then
  echo "ERROR: Invalid workdir: $WORKDIR"
  exit 1
fi
cd "$WORKDIR"
```

Good defensive pattern. Prevents `cd` to a non-existent path.

### T3.3: Guard $ARTIFACTS_DIR — ✅ CORRECT (but redundant)

The engine always sets `ARTIFACTS_DIR` as an env var (dag-executor.ts:1266).
If it's missing, the engine has a bug. The guard is defensive but technically redundant.
Still recommended for robustness.

### T3.4: Fix pwd → cd no-op — ✅ CORRECT

`WORKDIR="$(pwd)" && cd "$WORKDIR"` is a no-op. Replace with saving to artifacts:

```bash
WORKDIR="$(pwd)"
echo "$WORKDIR" > "$ARTIFACTS_DIR/.workdir"
```

**NOTE:** The archon-audit-to-pr.yaml scope node does NOT write .workdir to artifacts.
The setup node does `WORKDIR="$(pwd)" && cd "$WORKDIR"` (no-op). Both need fixing.
The scope node should add `echo "$(pwd)" > "$ARTIFACTS_DIR/.workdir"` and the setup
node should read from artifacts like the other workflows.

### T4.1: Change synthesize trigger — ✅ CORRECT

`one_success` → `none_failed_min_one_success` prevents generating a partial report.

### T5.1-T5.5: Git safety — ✅ CORRECT

All git safety improvements are sound. `git add -A` → explicit staging is safer.
Timeout on create-pr node is appropriate. Branch name sanitization is correct.

### T6.3: Extract shared setup script — ✅ CORRECT (with caveats)

**`source` works because:** bash nodes run via `bash -c`, so `source` resolves
relative to the `cwd` set by the executor (repo root / worktree root).

**Caveats:**

1. The `.archon/workflows/scripts/` directory must exist in the repo
2. The script must be committed to the repo (not just local)
3. In worktrees, `.archon/` must be accessible (it is — git worktrees share the repo)
4. The shebang `#!/bin/bash` in a sourced script is harmless (treated as comment) but unnecessary

**MISSING FROM PLAN:** The archon-audit-to-pr.yaml scope node does NOT write `.workdir`
to artifacts. The shared setup script reads `.workdir` from artifacts. So the scope
node in archon-audit-to-pr.yaml MUST be updated to write `.workdir`:

```bash
# Add to scope node, after WORKDIR detection:
echo "$(pwd)" > "$ARTIFACTS_DIR/.workdir"
```

---

## Corrected Patterns (Verified Against Engine)

### Correct gate pattern (hermes-pr-verifier.yaml, archon-adversarial-fix.yaml):

```yaml
- id: type-check
  bash: |
    #!/bin/bash
    set -eo pipefail

    WORKDIR="$(cat "$ARTIFACTS_DIR/.workdir")"
    if [ ! -d "$WORKDIR" ]; then
      echo "ERROR: Invalid workdir: $WORKDIR"
      exit 1
    fi
    cd "$WORKDIR"

    echo "=== TypeScript Type Check ==="
    if bun run type-check 2>&1; then
      echo "PASS: type-check"
    else
      echo "FAIL: type-check"
      exit 1
    fi
  depends_on: [setup]
  timeout: 120000
```

### Correct "run all checks" pattern (archon-audit-to-pr.yaml validate node):

```yaml
- id: validate
  bash: |
    #!/bin/bash
    # NOTE: NO set -e — intentional. This node runs ALL checks and reports results.

    if [ -z "$ARTIFACTS_DIR" ] || [ ! -d "$ARTIFACTS_DIR" ]; then
      echo "ERROR: ARTIFACTS_DIR is not set or does not exist"
      exit 1
    fi

    echo "=== TYPE CHECK ==="
    bun run type-check 2>&1
    TC_EXIT=$?

    echo ""
    echo "=== LINT ==="
    bun run lint 2>&1
    LINT_EXIT=$?

    echo ""
    echo "=== RESULTS ==="
    echo "Type check: $([ $TC_EXIT -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "Lint: $([ $LINT_EXIT -eq 0 ] && echo 'PASS' || echo 'FAIL')"

    if [ $TC_EXIT -eq 0 ] && [ $LINT_EXIT -eq 0 ]; then
      echo "VALIDATION_STATUS: PASS"
    else
      echo "VALIDATION_STATUS: FAIL"
    fi
    # Always exit 0 — downstream node reads VALIDATION_STATUS from output
  depends_on: [implement-fixes, setup]
  timeout: 300000
```

### Correct branch-setup pattern (with set -eo pipefail):

```yaml
- id: branch-setup
  bash: |
    #!/bin/bash
    set -eo pipefail

    if [ -z "$ARTIFACTS_DIR" ] || [ ! -d "$ARTIFACTS_DIR" ]; then
      echo "ERROR: ARTIFACTS_DIR is not set or does not exist"
      exit 1
    fi

    TARGET=$(cat "$ARTIFACTS_DIR/.audit-target" 2>/dev/null | tr -d '\n' || true)
    TARGET=$(printf '%s' "$TARGET" | tr -cd 'a-zA-Z0-9-')
    BRANCH_NAME="audit-fix-$(date +%Y%m%d)-${TARGET:-general}"

    git checkout -b "$BRANCH_NAME"

    echo "$BRANCH_NAME" > "$ARTIFACTS_DIR/.fix-branch"
    echo "Created branch: $BRANCH_NAME"
  depends_on: [fix-plan]
```

### Correct shared setup script usage:

```yaml
- id: setup
  bash: |
    source .archon/workflows/scripts/setup-deps.sh
  depends_on: [scope]
  timeout: 300000
```

### Correct scope node (archon-audit-to-pr.yaml — add .workdir write):

```yaml
- id: scope
  bash: |
    #!/bin/bash
    set -eo pipefail

    WORKDIR="$(pwd)"
    echo "$WORKDIR" > "$ARTIFACTS_DIR/.workdir"

    # ... rest of scope logic ...

    echo "$TARGET" > "$ARTIFACTS_DIR/.audit-target"
    echo "$TARGET_DIRS" > "$ARTIFACTS_DIR/.audit-target-dirs"
```

---

## Summary of Corrections to the Plan

| Task | Plan Says                              | Correction                                                                            |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| T1.1 | `set -eo pipefail` in ALL 14 nodes     | EXCLUDE validate node (archon-audit-to-pr.yaml) — it's designed to capture exit codes |
| T1.1 | Add `set -eo pipefail` to branch-setup | Need `\|\| true` on the cat pipe line for graceful fallback                           |
| T1.2 | Remove all `\|\| true` and `exit 0`    | KEEP `exit 0` on validate node (archon-audit-to-pr.yaml) — it reports, doesn't gate   |
| T3.1 | Add `set -e` to branch-setup           | Add `set -eo pipefail` (not just `set -e`) with `\|\| true` on cat pipe               |
| T6.3 | Source shared script                   | archon-audit-to-pr.yaml scope node MUST also write `.workdir` to artifacts            |
| T3.4 | Fix no-op in scope+setup               | scope node needs `echo "$(pwd)" > "$ARTIFACTS_DIR/.workdir"` added                    |

## Best Practices from Existing Workflows

1. **archon-validate-pr.yaml**: Uses `command:` nodes for named commands, bash for
   deterministic setup, prompt for AI analysis. Good separation of concerns.
2. **All workflows**: Use `$ARTIFACTS_DIR` for inter-node file communication.
3. **Gate pattern**: hermes-pr-verifier and archon-adversarial-fix use `trigger_rule: all_done`
   on evaluation nodes to run regardless of gate failures — this is the correct pattern.
4. **No `!include` support**: Bun.YAML.parse has no custom tags. Use `source` for shared scripts.
5. **Timeout defaults**: 120,000ms (2 min) for bash nodes. Override for long operations.
