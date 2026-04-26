# Hermes Provider Comprehensive Audit & Fix Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Thoroughly audit the Hermes provider (`packages/providers/src/hermes/`) against patterns from Claude, Codex, and Pi providers, identify all gaps (timeouts, resilience, security, integration), and produce a fix plan for PR to the upstream Archon repo.

**Architecture:** Three parallel research subagents analyze distinct aspects, writing deliverable reports. A synthesis phase consolidates findings into a ranked fix plan. Implementation follows via subagent-driven-development with verification gates.

**Tech Stack:** TypeScript, Bun, Archon workflow engine, ACP (Agent Client Protocol), JSON-RPC 2.0

---

## Phase 1: Parallel Research Delegation (3 Subagents)

All 3 subagents are **read-only** — they must not modify any files. Each writes a deliverable report to `.hermes/plans/`.

---

### Task 1.1: Hermes Bridge Timeout & Resilience Audit

**Objective:** Compare Hermes bridge code against Claude, Codex, and Pi bridge patterns. Identify every missing timeout, retry, error classification, and resilience mechanism.

**Files to Read:**

- `packages/providers/src/hermes/event-bridge.ts` (full)
- `packages/providers/src/hermes/provider.ts` (full)
- `packages/providers/src/claude/provider.ts` (lines 150-200 for `withFirstMessageTimeout`, lines 990-1040 for retry logic)
- `packages/providers/src/codex/provider.ts` (lines 560-620 for retry logic)
- `packages/providers/src/community/pi/event-bridge.ts` (lines 275-387 for `bridgeSession`)

**Step 1: Read Hermes bridge code**

Read `event-bridge.ts` and `provider.ts` fully. Document:

- `sendRequest()` — does it have a timeout? (Answer: no)
- `bridgeHermesSession()` — does it have a first-event timeout? (Answer: no)
- Consumer loop (`for await of queue`) — does it have an idle timeout? (Answer: no)
- Error classification — is there any? (Answer: no)
- Retry logic — is there any? (Answer: no)
- Abort signal handling — is it complete? (Answer: partial, uses SIGTERM/SIGKILL but no timeout)

**Step 2: Read Claude provider timeout patterns**

Read `claude/provider.ts` lines 150-200. Document:

- `withFirstMessageTimeout()` — how it wraps the generator
- `getFirstEventTimeoutMs()` — 60s default, env override
- `buildFirstEventHangDiagnostics()` — what it logs
- How the timeout aborts the controller and throws

**Step 3: Read Codex provider retry patterns**

Read `codex/provider.ts` lines 560-620. Document:

- `MAX_SUBPROCESS_RETRIES` (3)
- `RETRY_BASE_DELAY_MS` (2000)
- Exponential backoff delay calculation
- Error classification (`classifyAndEnrichCodexError`)

**Step 4: Read Pi provider bridge patterns**

Read `pi/event-bridge.ts` lines 275-387. Document:

- How `bridgeSession()` handles the prompt Promise
- How it wires `abortSignal` to `session.abort()`
- How it cleans up in `finally` (dispose, unsubscribe, close queue)

**Step 5: Compare and identify gaps**

Produce a gap matrix:

| Pattern                   | Claude   | Codex           | Pi           | Hermes           | Gap Severity |
| ------------------------- | -------- | --------------- | ------------ | ---------------- | ------------ |
| First-event timeout       | ✅ 60s   | ✅ SDK-internal | ❌ None      | ❌ None          | **CRITICAL** |
| Request timeout           | ✅       | ✅              | ✅ via abort | ❌ None          | **CRITICAL** |
| Retry logic               | ✅       | ✅              | ❌           | ❌ None          | HIGH         |
| Error classification      | ✅       | ✅              | ✅           | ❌ None          | HIGH         |
| Abort signal timeout      | ✅       | ✅              | ✅           | ✅ Partial       | MEDIUM       |
| Zombie process prevention | ✅ unref | ✅ SDK          | ✅ dispose   | ✅ unref+SIGKILL | PASS         |
| Queue close on error      | ✅       | ✅              | ✅           | ✅               | PASS         |

**Step 6: Write deliverable report**

Write to: `.hermes/plans/2026-04-26-hermes-bridge-timeout-audit.md`

Include:

- Exact line numbers of missing code in Hermes
- Copy-pasteable fix snippets from Claude/Codex/Pi as reference
- Recommended fix priority (CRITICAL → HIGH → MEDIUM)

---

### Task 1.2: Hermes ACP Protocol & Session Management Audit

**Objective:** Audit all Hermes ACP protocol files for security issues, dead code, magic strings, mutable state, and deviations from patterns in other providers.

**Files to Read:**

- `packages/providers/src/hermes/acp-protocol.ts` (full)
- `packages/providers/src/hermes/session-resolver.ts` (full)
- `packages/providers/src/hermes/binary-resolver.ts` (full)
- `packages/providers/src/hermes/options-translator.ts` (full)
- `packages/providers/src/hermes/acp-bridge.ts` (full — dead code check)
- `packages/providers/src/hermes/capabilities.ts` (full)
- `packages/providers/src/hermes/config.ts` (full)
- `packages/providers/src/claude/binary-resolver.ts` (for comparison)
- `packages/providers/src/codex/binary-resolver.ts` (for comparison)

**Step 1: Security audit**

Read `provider.ts` line 106:

```typescript
env: { ...process.env, ...session.env }
```

Document: Full `process.env` leak to subprocess. Compare with Claude's env handling.

Read `session-resolver.ts` line 53:

```typescript
const env: Record<string, string> = { ...process.env } as Record<string, string>;
```

Document: Same leak in session resolver. Defense-in-depth failure.

Read `binary-resolver.ts` line 65:

```typescript
const envPath = process.env.HERMES_BINARY_PATH;
if (envPath) {
  if (!fileExists(envPath)) {
```

Document: Path traversal risk, no `isFile()` check, no executable permission check.

**Step 2: Dead code audit**

Read `acp-bridge.ts` (full). Document:

- `buildAcpRequests()` is never called from anywhere
- File is completely unused
- Has its own test file (`acp-bridge.test.ts`) that's also dead weight

**Step 3: Magic strings & hardcoded values**

Read `event-bridge.ts` line 344:

```typescript
clientInfo: { name: 'archon', version: '0.3.9' }
```

Document: Hardcoded version string. Compare with how other providers handle version.

Read `options-translator.ts` line 37:

```typescript
return { provider: config.provider ?? '<default>', model: config.model };
```

Document: Magic string `'<default>'` with no named constant.

**Step 4: Mutable state audit**

Read `acp-protocol.ts` line 36:

```typescript
let nextId = 1;
```

Document: Global mutable counter. Cross-session ID collision risk. Compare with per-session counters in other providers.

Read `event-bridge.ts` line 149:

```typescript
let terminalEmitted = false;
```

Document: Shared mutable flag across closures. Compare with explicit state objects.

Read `event-bridge.ts` line 15, `provider.ts` line 17, `binary-resolver.ts` line 29:
Document: Global lazy logger caches (`cachedLog` pattern). Compare with direct `createLogger()` calls.

**Step 5: ACP protocol correctness**

Read `event-bridge.ts` line 292:

```typescript
createRequest('session/cancel' as const, { sessionId } as unknown as Record<string, unknown>);
```

Document: Uses `createRequest` instead of `createNotification` for fire-and-forget `session/cancel`. Per ACP spec, notifications have no `id` field.

**Step 6: Write deliverable report**

Write to: `.hermes/plans/2026-04-26-hermes-acp-security-audit.md`

Include:

- Finding table with severity (CRITICAL / HIGH / MEDIUM / LOW)
- Exact file paths and line numbers
- Recommended fixes with code snippets
- Cross-references to equivalent patterns in Claude/Codex/Pi

---

### Task 1.3: Archon Workflow Engine Integration Audit

**Objective:** Check how Hermes provider integrates with the Archon workflow engine. Compare against Claude/Codex/Pi integration. Identify missing capabilities, incorrect flags, and integration gaps.

**Files to Read:**

- `packages/providers/src/hermes/capabilities.ts` (full)
- `packages/providers/src/types.ts` (for `ProviderCapabilities` interface)
- `packages/workflows/src/engine/dag-executor.ts` (for how capabilities are checked)
- `packages/providers/src/claude/capabilities.ts` (for comparison)
- `packages/providers/src/codex/capabilities.ts` (for comparison)
- `packages/providers/src/community/pi/capabilities.ts` (for comparison)
- `packages/providers/src/registry.ts` (for provider registration)
- `packages/providers/src/index.ts` (for exports)

**Step 1: Capability flag audit**

Read `hermes/capabilities.ts`. Document all declared capabilities.

Compare with `claude/capabilities.ts`, `codex/capabilities.ts`, `pi/capabilities.ts`.

Identify:

- Capabilities Hermes declares `false` that it could support (e.g., `structuredOutput`, `sessionResume`)
- Capabilities Hermes might incorrectly declare `true`
- Missing capability declarations that the workflow engine expects

**Step 2: DAG executor integration**

Read `dag-executor.ts` (or relevant workflow engine files). Find:

- How the executor checks `provider.getCapabilities()` before running nodes
- What happens when a node requests a capability the provider doesn't have
- How `idle_timeout`, `allowed_tools`, `denied_tools`, `output_format` are handled
- Whether Hermes nodes get warnings for unsupported features

**Step 3: Error handling integration**

Check how Hermes errors propagate through the workflow engine:

- Does a hung provider (like our 20-minute stall) get detected by the engine?
- Is there an engine-level timeout on node execution?
- How does the engine handle `isError: true` result chunks?
- Compare with how Claude/Codex/Pi errors are handled

**Step 4: Provider registration audit**

Read `registry.ts` and `index.ts`. Check:

- Is Hermes properly registered in the provider registry?
- Does it have the correct `builtIn` flag?
- Is the display name correct?
- Compare registration pattern with Claude/Codex/Pi

**Step 5: Test coverage audit**

Check test files:

- `packages/providers/src/hermes/*.test.ts` — what do they cover?
- Are there tests for timeout handling? (Answer: probably no)
- Are there tests for error classification? (Answer: probably no)
- Compare test coverage with Claude/Codex providers

**Step 6: Write deliverable report**

Write to: `.hermes/plans/2026-04-26-hermes-workflow-integration-audit.md`

Include:

- Capability matrix (Hermes vs Claude vs Codex vs Pi)
- Integration gap list with severity
- Engine-level timeout recommendations
- Test coverage gaps

---

## Phase 2: Synthesis & Plan Writing

**Objective:** Read all 3 deliverable reports, consolidate findings, and write the final implementation plan.

**Step 1: Read deliverables**

```bash
read_file(".hermes/plans/2026-04-26-hermes-bridge-timeout-audit.md")
read_file(".hermes/plans/2026-04-26-hermes-acp-security-audit.md")
read_file(".hermes/plans/2026-04-26-hermes-workflow-integration-audit.md")
```

**Step 2: Consolidate findings**

Merge all findings into a single ranked list:

- CRITICAL: Security issues, hangs, data loss risk
- HIGH: Missing timeouts, incorrect protocol usage
- MEDIUM: Dead code, magic strings, mutable state
- LOW: Style issues, missing tests

**Step 3: Write final implementation plan**

Write to: `.hermes/plans/2026-04-26-hermes-fix-plan.md`

Follow `writing-plans` skill format:

- Bite-sized tasks (2-5 min each)
- Exact file paths
- Complete code examples
- Exact commands with expected output
- Verification steps

**Step 4: Plan audit (optional but recommended)**

Dispatch a verifier subagent to audit the plan before implementation.

---

## Phase 3: Implementation (Subagent-Driven)

**Objective:** Execute the fix plan using fresh subagents per task with two-stage review.

**Step 1: Parse plan into tasks**

Create todo list from the plan.

**Step 2: Per-task execution**

For each task:

1. Dispatch implementer subagent with full context
2. Dispatch spec compliance reviewer
3. Dispatch code quality reviewer
4. Mark complete only when both reviews pass

**Step 3: Batch verification gates**

After each batch of 3 tasks, dispatch a verifier to run:

- `bun run type-check`
- `bun run lint`
- `bun test packages/providers/src/hermes/`

**Step 4: Final integration review**

After all tasks complete:

- Run full test suite
- Run workflow validation
- Verify no regressions in Claude/Codex/Pi providers

---

## Verification Gates

### Gate 1: Type Check

```bash
cd /home/d/Desktop/Archon-canonical && bun run type-check
```

Expected: PASS (no errors)

### Gate 2: Lint

```bash
cd /home/d/Desktop/Archon-canonical && bun run lint
```

Expected: PASS (zero warnings)

### Gate 3: Hermes Tests

```bash
cd /home/d/Desktop/Archon-canonical && bun test packages/providers/src/hermes/
```

Expected: All tests pass

### Gate 4: Timeout Test

```bash
cd /home/d/Desktop/Archon-canonical && bun test packages/providers/src/hermes/event-bridge.test.ts
```

Expected: New timeout tests pass (simulate stalled provider, verify timeout fires)

### Gate 5: Workflow Validation

```bash
cd /home/d/Desktop/Archon-canonical && bun run cli validate workflows archon-adversarial-fix
```

Expected: VALID

---

## Principles

- **DRY:** Extract shared timeout utilities if used across providers
- **YAGNI:** Don't add features Hermes doesn't need (e.g., don't add retry if not justified)
- **TDD:** Write timeout tests before implementing timeout logic
- **Fail Fast:** Timeouts should throw clear errors with diagnostic info (like Claude's `#1067` pattern)
- **No Regressions:** Changes must not break Claude/Codex/Pi providers

---

## Remember

```
Fresh subagent per task
Two-stage review every time
Spec compliance FIRST
Code quality SECOND
Never skip reviews
Catch issues early
```
