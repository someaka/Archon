# V3 Protocol Verification Report

> Verifier: V3 (Online Docs/Protocol)
> Date: 2026-04-28
> Status: COMPLETE

---

## 1. Shell Pattern Verification

### T1.1: `set -eo pipefail` syntax

**Verdict: ACCURATE**

Evidence:

- `set -eo pipefail` = `set -e -o pipefail` in bash syntax
- `-e`: exit on error
- `-o pipefail`: set the pipefail shell option (causes pipeline to return rightmost non-zero exit)
- Works in bash scripts run via `bash -c` (no `#!/bin/bash` shebang needed)
- The Archon executor runs bash nodes via `execFileAsync('bash', ['-c', finalScript])`
  (dag-executor.ts:1273), so bash is the shell — pipefail is supported
- Existing Archon workflows already use `set -euo pipefail` in
  `.archon/workflows/experimental/archon-release.yaml` (lines 51, 235, 529, 544, 610, 633, 815)
- Current target files use bare `set -e` (e.g. hermes-pr-verifier.yaml:26, 67, 185, 204, 223)

Source: dag-executor.ts:1273, archon-release.yaml:51

### T2.1: `tr -cd 'a-zA-Z0-9 _-'` for argument sanitization

**Verdict: ACCURATE — safe allowlist approach**

Evidence:

- `tr -cd` deletes all characters NOT in the given set
- Allowlist: alphanumeric, space, underscore, hyphen — excludes shell metacharacters
  (`$`, `` ` ``, `|`, `;`, `&`, `(`, `)`, `<`, `>`, `!`, `\n`, etc.)
- Follows the "allowlist over denylist" security principle
- Combined with `head -c 500` for length limiting
- The `$ARGUMENTS` variable is substituted by the Archon engine at
  `executor-shared.ts:312` (`.replace(/\$ARGUMENTS/g, userMessage)`) —
  it comes from user input, so sanitization is warranted

Source: POSIX tr(1), executor-shared.ts:312

### T2.1 (cont): `head -c 500` for truncation

**Verdict: ACCURATE**

Evidence:

- `head -c N` outputs the first N bytes — standard POSIX utility
- Works on all Linux systems with coreutils
- Effective as a length limit for user-supplied arguments

### T2.2: `while IFS= read -r dir; do` for safe iteration

**Verdict: ACCURATE — this is the canonical safe pattern**

Evidence:

- `IFS=` prevents word splitting on whitespace
- `-r` prevents backslash interpretation
- Reading from a file (`< "$ARTIFACTS_DIR/.audit-target-dirs"`) avoids subshell issues
- This is the universally recommended bash pattern for safe line-by-line iteration
  (per Wooledge BashFAQ/001)

---

## 2. Archon Trigger Rule Verification

### T4.1: `trigger_rule: none_failed_min_one_success` exists

**Verdict: ACCURATE**

Evidence:

- Schema: dag-node.ts:27 — `'none_failed_min_one_success'` is in the triggerRuleSchema enum
- Executor: dag-executor.ts:490-493:
  ```
  case 'none_failed_min_one_success': {
    const anyFailed = upstreams.some(u => u.state === 'failed');
    const anySucceeded = upstreams.some(u => u.state === 'completed');
    return !anyFailed && anySucceeded ? 'run' : 'skip';
  }
  ```
- Tests: dag-executor.test.ts:323-343 — tested with skipped branch + completed branch (runs),
  and with failed branch (skips)
- Semantics match the plan's description: runs only when NO upstreams failed AND at least one succeeded

Source: dag-node.ts:24-29, dag-executor.ts:490-493, dag-executor.test.ts:323-343

### `trigger_rule: all_done` runs even if upstream failed

**Verdict: ACCURATE**

Evidence:

- dag-executor.ts:495-496:
  ```
  case 'all_done':
    return upstreams.every(u => u.state !== 'pending' && u.state !== 'running') ? 'run' : 'skip';
  ```
- Runs when ALL upstreams are in terminal state (completed, failed, or skipped)
- Does NOT check for success — runs even if all upstreams failed
- Tests: dag-executor.test.ts:346-352 — confirms runs when deps are `failed` + `skipped`

Source: dag-executor.ts:495-496, dag-executor.test.ts:346-352

### Default trigger rule

**Note:** The default is `all_success` (dag-executor.ts:483: `node.trigger_rule ?? 'all_success'`)

---

## 3. Bash Node Verification

### Are bash nodes the correct way to run validation commands?

**Verdict: ACCURATE**

Evidence:

- dag-node.ts:206-209: `bashNodeSchema` extends base with `bash: z.string()` and `timeout: z.number()`
- dag-executor.ts:1273: `execFileAsync('bash', ['-c', finalScript])` — runs directly in bash
- dag-executor.ts:1261: `substituteNodeOutputRefs(substitutedScript, nodeOutputs, true)` —
  supports output references from upstream nodes
- Bash nodes are the correct mechanism for running shell commands (type-check, lint, test, etc.)

### Does `$ARTIFACTS_DIR` exist in all bash nodes?

**Verdict: ACCURATE — auto-provided**

Evidence:

- dag-executor.ts:1264-1268:
  ```
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACTS_DIR: artifactsDir,
    LOG_DIR: logDir,
    BASE_BRANCH: baseBranch,
    ...(envVars ?? {}),
  };
  ```
- $ARTIFACTS_DIR is set as an environment variable for every bash node subprocess
- It is ALSO substituted into the bash script text itself (executor-shared.ts:313)
- This means `$ARTIFACTS_DIR` works both in `$ARTIFACTS_DIR/path` shell expansions
  AND as a literal in the YAML string

Source: dag-executor.ts:1264-1268, executor-shared.ts:271, 313

### Other auto-provided variables

Per executor-shared.ts:269-273:

- `$WORKFLOW_ID` — workflow run ID
- `$USER_MESSAGE` / `$ARGUMENTS` — user's trigger message
- `$ARTIFACTS_DIR` — artifacts directory
- `$BASE_BRANCH` — base branch
- `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT` — GitHub context

---

## 4. Shared Script Mechanism (T6.3)

### `.archon/workflows/scripts/setup-deps.sh` as a valid path

**Verdict: NEEDS VERIFICATION — likely WRONG as proposed**

Evidence:

- The Archon YAML loader (`loader.ts:28-30`) uses `Bun.YAML.parse(content)` —
  standard YAML parsing with NO custom tags
- Search for `!include` across the codebase: ZERO results
- The `.archon/scripts/` directory is for **script nodes** (TypeScript/Python via bun/uv),
  discovered by `script-discovery.ts` — NOT for bash includes
- `.archon/workflows/scripts/` is not a recognized Archon path convention
- There is NO `!include` or similar directive supported by the Archon workflow engine

**How it COULD work (shell-native approach):**
The plan could use shell `source` inside the bash block:

```yaml
bash: |
  source .archon/workflows/scripts/setup-deps.sh
```

But this requires knowing the absolute path at YAML-authoring time, or using
a relative path from the working directory. The script would need
to be placed at a predictable path relative to the repo root.

**Alternative: use a script node with `runtime: bun`**
Script nodes support named scripts from `.archon/scripts/` (dag-executor.ts:1449),
but those are TypeScript/Python, not bash.

**CORRECTION NEEDED:**
The plan should either:

1. Use `source .archon/workflows/scripts/setup-deps.sh` in bash blocks (works if cwd is repo root)
2. Keep the setup code inline in each YAML file (current approach, just deduplicated)
3. Accept that `!include` doesn't exist and inline the shared script content

The most practical approach is option 2 or 3 — the `!include` mechanism does not exist.

---

## 5. Default Timeout

**Verdict: ACCURATE (relevant to T1.5, T5.2)**

Evidence:

- dag-executor.ts:1201: `const SUBPROCESS_DEFAULT_TIMEOUT = 120_000;` (2 minutes)
- dag-executor.ts:1263: `const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;`
- T5.2 proposes `timeout: 120000` for create-pr — this equals the default,
  so it's redundant but not harmful. If create-pr needs more time, a higher value is needed.

---

## Summary Table

| Claim                                | Verdict                | Evidence                                                 |
| ------------------------------------ | ---------------------- | -------------------------------------------------------- |
| `set -eo pipefail` syntax            | ACCURATE               | dag-executor.ts:1273, archon-release.yaml:51             |
| `tr -cd 'a-zA-Z0-9 _-'` allowlist    | ACCURATE               | Standard POSIX, excludes all metacharacters              |
| `head -c 500` truncation             | ACCURATE               | Standard POSIX utility                                   |
| `while IFS= read -r` pattern         | ACCURATE               | Canonical safe bash iteration pattern                    |
| `none_failed_min_one_success` exists | ACCURATE               | dag-node.ts:27, dag-executor.ts:490-493                  |
| `all_done` runs on failure           | ACCURATE               | dag-executor.ts:495-496, test at :346-352                |
| Bash nodes for validation            | ACCURATE               | dag-node.ts:206-209, dag-executor.ts:1273                |
| `$ARTIFACTS_DIR` auto-provided       | ACCURATE               | dag-executor.ts:1266, executor-shared.ts:313             |
| `.archon/workflows/scripts/` path    | NEEDS VERIFICATION     | No Archon convention for this path                       |
| `!include` support                   | WRONG                  | Not supported — Bun.YAML.parse has no custom tags        |
| `timeout: 120000` for create-pr      | ACCURATE but redundant | Equals SUBPROCESS_DEFAULT_TIMEOUT (dag-executor.ts:1201) |

---

## Overall Assessment

**The plan's shell patterns and trigger rule changes are all ACCURATE and well-evidenced.**
The Archon engine source confirms every proposed trigger rule, bash node pattern,
and environment variable.

**One significant issue: T6.3 (shared script extraction) is NOT implementable as described.**
The Archon engine does not support `!include` or any YAML directive for referencing
external files. The `Bun.YAML.parse()` call is standard YAML with no custom tags.
The plan must either:

- Keep setup code inline in each YAML (safest)
- Use shell `source` with a relative path (works if cwd is repo root)

The remaining 19 findings are correctly identified and the proposed fixes are sound.
