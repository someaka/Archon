# Planner A: Issue Requirements + Hermes Docs Gap Analysis

## 1. Issue #1106 — What It ACTUALLY Asks For

**Title:** "Hermes Agent integration"
**URL:** https://github.com/coleam00/Archon/issues/1106
**Note:** The URL in the task (nicepkg/Archon) 404s. The actual upstream is coleam00/Archon.

### Summary of Issue Requirements

The issue is a **feature request** to add Hermes Agent as a third AI assistant provider
alongside Claude Code and Codex. It covers:

1. **Core Integration:** `HermesClient` implementing `IAssistantClient`
2. **Configuration:** `assistant: hermes` support in `.archon/config.yaml`
3. **CLI Setup:** `archon init` wizard showing Hermes option
4. **Workflow Support:** Per-node `provider: hermes` and `model:` override
5. **Testing:** Unit + integration tests
6. **Documentation:** User-facing docs

### What the Issue Does NOT Mention

- **The issue does NOT mention workflow YAML quality at all.**
- The issue does NOT mention `set -eo pipefail`, gate patterns, shell injection in $ARGUMENTS,
  trigger rules, git safety, or any of the 21 findings in the plan.
- The issue is purely about **provider integration** — wiring Hermes as a backend for
  Archon's workflow engine.

### Key Quote from Issue

> Add Hermes Agent as a third AI assistant provider in Archon, alongside Claude Code
> and Codex. Hermes Agent is an open-source AI agent framework by Nous Research.

---

## 2. Gap Analysis: Issue #1106 vs. Plan's 21 Findings

### Classification

| Category                                      | Findings                                                                                                | Issue Relevance                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Directly addresses issue #1106**            | NONE                                                                                                    | The plan's 21 findings are all about workflow YAML quality, not provider integration |
| **Indirectly related (workflow reliability)** | F-002, F-003, F-004, F-005, F-006, F-007                                                                | These affect whether Hermes-powered workflows actually run correctly                 |
| **General quality improvements**              | F-001, F-008, F-009, F-010, F-011, F-012, F-013, F-014, F-015, F-016, F-017, F-018, F-019, F-020, F-021 | Defense-in-depth, security hardening, code hygiene                                   |

### Finding-by-Finding Assessment

**F-001 (Shell injection in $ARGUMENTS):** NOT in issue. General security hardening.
The plan's sanitization approach (tr -cd allowlist) is reasonable but overly aggressive —
stripping all non-alphanumeric chars breaks useful arguments like file paths with `/`.

**F-002 (set -eo pipefail):** NOT in issue, but IMPORTANT for workflow correctness.
Without pipefail, `bun install 2>&1 | tail -5` silently swallows install failures.
This directly affects whether Hermes-powered workflows fail fast on dependency issues.

**F-003 (Gate pattern — || true and forced exit 0):** NOT in issue, but CRITICAL for
workflow correctness. The current pattern forces all gates to exit 0, which means the
evaluate node receives SUCCESS output even when checks fail. This is a fundamental
design flaw that undermines the entire adversarial evaluation concept.

**F-004 (Synthesize trigger_rule: one_success):** NOT in issue, but IMPORTANT.
With `one_success`, 3/4 audits can fail and the synthesis runs on 25% data.
Should be `none_failed_min_one_success`.

**F-005 (Structured gate results):** NOT in issue. Nice-to-have enhancement.
The plan proposes writing JSON to gate-results.json — adds complexity for marginal benefit
since the evaluate node is a prompt node that reads text output.

**F-006 (Lint gate OOM):** NOT in issue. Practical fix — increasing NODE_OPTIONS
max-old-space-size is straightforward.

**F-007 (Test gate empty output):** NOT in issue. The 5-min timeout may be insufficient.
Splitting into targeted tests first is reasonable.

**F-008 (git add -A):** NOT in issue. General safety — explicit staging is better practice
but the current approach works for the intended use case (agent-driven commits).

**F-009 (Branch-setup missing set -e):** NOT in issue, but IMPORTANT. Missing error
handling means git checkout failures are silently ignored.

**F-010 (Unquoted $TARGET_DIRS):** NOT in issue. Real bug — word splitting on directory
paths with spaces would break the for loop.

**F-011 (Workdir validation):** NOT in issue. Defense-in-depth. Checking path exists
before cd is good practice.

**F-012 (Review agent fragility):** NOT in issue. Documentation-level concern about
prompt nodes that don't run code.

**F-013 (ARTIFACTS_DIR guard):** NOT in issue. Defense-in-depth. The workflow engine
guarantees $ARTIFACTS_DIR exists, so this is belt-and-suspenders.

**F-014 (Branch name sanitization):** NOT in issue. Real but low-risk — the TARGET
value comes from grep against predefined strings, not arbitrary user input.

**F-015 (create-pr timeout):** NOT in issue. Practical fix.

**F-016 (Commit message sanitization):** NOT in issue. Defense-in-depth.

**F-017 (Remote verification):** NOT in issue. Defense-in-depth.

**F-018 (Default model verification):** NOT in issue. Manual check item.

**F-019 (Extract shared setup script):** NOT in issue. DRY improvement — reduces
duplication across 3 files. The plan correctly notes `!include` doesn't work in
Bun.YAML.parse and proposes shell `source` instead.

**F-020 (Push failure handling):** NOT in issue. Defense-in-depth.

**F-021 (pwd → cd no-op):** NOT in issue, but REAL BUG. `WORKDIR="$(pwd)" && cd "$WORKDIR"`
is a no-op that wastes a line and confuses readers.

---

## 3. Hermes Docs — Relevant Patterns and Recommendations

### 3.1 Architecture Relevance

Hermes Agent docs confirm:

- Hermes communicates via **ACP (Agent Client Protocol)** — JSON-RPC 2.0 over stdio
- The `hermes acp` subprocess is spawned per-session with `keepAlive: true` for pooling
- Session pool is keyed by `cwd + model + provider`
- Error handling: spawn failures and non-zero exits surface as `result` chunks with `isError: true`
- Binary resolution falls back to PATH lookup

**Key insight for the plan:** The workflow YAML files invoke Hermes indirectly — Archon's
dag-executor spawns Hermes via the provider, which spawns `hermes acp`. The bash nodes
in the workflow run in Archon's process (not in Hermes). So `set -eo pipefail` concerns
are about Archon's bash node execution, not Hermes's tool execution.

### 3.2 Security Model

Hermes docs describe:

- Dangerous command approval (manual/smart/off modes)
- YOLO mode for bypassing approvals
- Terminal backend isolation (local/docker/ssh/modal/daytona/singularity)

**Relevance to plan:** The workflow YAML files run bash nodes in Archon's executor,
NOT through Hermes's terminal tool. The security model docs don't directly apply to
the workflow bash nodes. However, the principle of least privilege is sound — the
plan's shell injection concerns (F-001) are valid for bash nodes that interpolate `$ARGUMENTS`.

### 3.3 Tool System

Hermes docs describe 47 built-in tools organized in 19 toolsets. The workflow YAML
files use `bash:` nodes (Archon's executor runs shell commands) and `prompt:` nodes
(Hermes agent handles the prompt with its full tool suite).

**Key distinction:**

- `bash:` nodes → Archon runs the shell directly (set -e, pipefail matter here)
- `prompt:` nodes → Hermes agent runs, using its tools (terminal tool has its own error handling)

### 3.4 Error Handling Patterns

Hermes docs recommend:

- `approvals.mode: smart` for balanced security
- Docker backend for untrusted code
- Session pooling for performance

None of these directly inform the workflow YAML fixes, but the general principle of
"fail fast, surface errors clearly" aligns with the plan's F-002, F-003, F-009 findings.

---

## 4. Corrections to the Plan

### 4.1 Critical Correction: Scope Mismatch

The plan addresses **workflow YAML quality**, but issue #1106 asks for **provider
integration**. The plan should either:

**Option A:** Acknowledge that these 21 findings are quality improvements to the
existing workflow YAML files (which were created as part of the Hermes integration
effort referenced in issue #1106), and frame them as "hardening the Hermes-powered
workflows."

**Option B:** Restructure to first address any provider integration gaps (HermesClient,
config, CLI setup) and then address workflow quality as a secondary concern.

**Recommendation:** Option A — the provider integration appears complete based on the
git log showing multiple `fix(hermes)` commits. The 21 findings are about the quality
of the workflows that USE the Hermes provider. Frame the plan as "hardening Hermes
workflow quality."

### 4.2 Prioritization Corrections

The plan treats all 21 findings as equal priority. They should be prioritized:

**P0 — Fix first (breaks workflow correctness):**

- F-002: `set -eo pipefail` (silent failures in dependency install)
- F-003: Gate pattern (gates always pass, undermining evaluation)
- F-004: Synthesize trigger_rule (runs on insufficient data)
- F-021: pwd → cd no-op (real bug, wastes a line)

**P1 — Fix second (real bugs, defense-in-depth):**

- F-009: Branch-setup missing error handling
- F-010: Unquoted $TARGET_DIRS iteration
- F-006: Lint gate OOM
- F-007: Test gate empty output

**P2 — Fix third (security hardening):**

- F-001: Shell injection in $ARGUMENTS
- F-014: Branch name sanitization
- F-016: Commit message sanitization
- F-008: git add -A → explicit staging

**P3 — Nice-to-have (code quality):**

- F-005: Structured gate results
- F-011: Workdir validation
- F-012: Review agent fragility docs
- F-013: ARTIFACTS_DIR guard
- F-015: Create-pr timeout
- F-017: Remote verification
- F-018: Default model verification
- F-019: Extract shared setup script
- F-020: Push failure handling

### 4.3 Technical Corrections

1. **F-001 sanitization is too aggressive:** `tr -cd 'a-zA-Z0-9 _-'` strips `/` from
   file paths, `:` from URLs, etc. Use a blocklist (strip `;|&$\`<>(){}[]`) instead
   of an allowlist, or better yet, use proper quoting (which Archon's variable
   substitution already does for bash nodes per the docs).

2. **F-003 — evaluate node trigger_rule:** The plan says `all_done` already handles
   failed state. This is CORRECT. But the plan should verify that `all_done` is
   actually set on the evaluate node (it is — confirmed in hermes-pr-verifier.yaml line 336).

3. **F-005 — structured gate results:** Over-engineered. The evaluate node is a prompt
   node — it reads text output from the bash nodes. Adding JSON file writing adds
   complexity without clear benefit. The current text-based output ("PASS: type-check"
   / "FAIL: type-check") is sufficient for the evaluator prompt.

4. **F-019 — shared setup script:** The plan correctly notes `!include` doesn't work
   in Bun.YAML.parse and proposes `source`. This is a good DRY improvement. However,
   the extracted script should be minimal — just the dependency install logic, not
   the workdir resolution (which varies per workflow).

5. **F-013 — ARTIFACTS_DIR guard:** The Archon workflow engine guarantees `$ARTIFACTS_DIR`
   is set and exists before node execution (per the variable reference docs: "Pre-created
   external artifacts directory"). Adding guards is belt-and-suspenders but not wrong.

---

## 5. Recommendations from Hermes Docs

### 5.1 Use Archon's Built-in Variable Quoting

From the Archon variable reference:

> $nodeId.output values are auto shell-quoted (single-quoted, with embedded ' escaped)
> when substituted into bash: scripts

This means `$scope.output` in bash nodes is already safe from injection. The plan's
concern about `$ARGUMENTS` (F-001) is valid because `$ARGUMENTS` is substituted BEFORE
the bash script runs (it's a workflow variable, not a node output reference), so it's
NOT auto-quoted.

### 5.2 Consider Script Nodes for Deterministic Work

From the Archon docs:

> Use script nodes for deterministic work that needs a real programming language.
> If a plain shell command is enough, use a bash: node instead.

The validation gates (type-check, lint, test) are deterministic. They could potentially
be `script:` nodes instead of `bash:` nodes, which would give better error handling
(non-zero exit fails the node, stderr is logged as warning). However, this is a bigger
refactor than the plan proposes.

### 5.3 Trigger Rules Are Well-Defined

From the Archon docs, trigger rules are:

- `all_success` (default) — run only if all deps succeeded
- `one_success` — run if at least one dep succeeded
- `none_failed_min_one_success` — run if no deps failed AND at least one succeeded
- `all_done` — run when all deps are in terminal state

The plan's recommendation to change synthesize from `one_success` to
`none_failed_min_one_success` is correct per these semantics.

---

## 6. Summary

| Question                                           | Answer                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| What does issue #1106 actually ask for?            | Hermes Agent provider integration (HermesClient, config, CLI, workflows)        |
| Does it mention workflow YAML quality?             | NO — not at all                                                                 |
| Are the 21 findings relevant to the issue?         | NOT DIRECTLY — they're quality improvements to existing workflows               |
| Does the plan's proposed fix align with the issue? | NO — the plan addresses workflow quality, not provider integration              |
| Should the findings still be fixed?                | YES — they're legitimate bugs and improvements, just not issue-specific         |
| How should the plan be reframed?                   | As "hardening Hermes-powered workflow quality" — part of the integration effort |

**Bottom line:** The plan is technically sound but misaligned with the issue. The 21 findings
are real improvements to the workflow YAML files that were created as part of the Hermes
integration. The plan should be reframed as workflow hardening (not issue resolution) and
reprioritized to fix correctness bugs first (F-002, F-003, F-004, F-021), then real bugs
(F-009, F-010), then security hardening, then nice-to-haves.
