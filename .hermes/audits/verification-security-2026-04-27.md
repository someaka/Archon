# Hermes Provider Security Verification Audit

**Date:** 2026-04-27
**Auditor:** Verifier 4 (automated)
**Scope:** All non-test source files in packages/providers/src/hermes/ + shared utils
**Status:** COMPLETE

---

## Files Audited

### Hermes provider files (11):

- provider.ts, event-bridge.ts, acp-protocol.ts, session-resolver.ts
- binary-resolver.ts, capabilities.ts, config.ts, error-classifier.ts
- model-ref.ts, options-translator.ts, timeout-utils.ts

### Shared utilities (3):

- utils/async-queue.ts, utils/binary-resolver.ts, utils/lazy-logger.ts

---

## Previous Audit Issues — Verification Status

### C3 (Pi): process.env mutation — NOT PRESENT IN HERMES

VERIFIED ABSENT. No `process.env.X = Y` assignments exist in any Hermes
source file. The `session-resolver.ts` creates a fresh `env` object and
copies entries into it without mutating `process.env`. Test files do
mutate `process.env` for setup/teardown, which is standard test practice.

### R5: stderr redaction — IMPLEMENTED, GAPS REMAIN

VERIFIED PRESENT. `redactSecrets()` in event-bridge.ts (line 29-33) is
called at ALL 6 stderr output sites:

- Line 182: live stderr logging (warn level)
- Line 213: non-zero exit error push
- Line 234: process error message
- Line 239: process error push
- Line 280: abort message
- Line 285: abort error push

No unprotected stderr paths exist. See Finding H2 for coverage gaps.

### I7: abortSignal listener leak — FULLY RESOLVED

VERIFIED FIXED. The abort listener at line 295 uses `{ once: true }`.
The `finally` block (lines 419-436) calls `abortSignal.removeEventListener`
and clears `sigkillTimeout`. The `emitTerminal` guard (line 198-200)
prevents duplicate terminal chunks. The `queue.close()` in the finally
block drains any pending waiters so the consumer never hangs.

### I18: process.env re-spread in provider.ts — STILL PRESENT

PRESENT at provider.ts line 131: `env: { ...process.env, ...session.env }`.
This is functionally redundant since `session.env` already contains ALL of
`process.env` (built in session-resolver.ts lines 66-71). The double spread
is wasteful but not a separate security issue beyond what H1 describes.

---

## New Security Findings

### H1 [MEDIUM] — Full process.env passed to child process (credential leakage)

**Location:** provider.ts:131, session-resolver.ts:66-71

**Description:**
The Hermes child process receives the ENTIRE parent process environment.
`session-resolver.ts` copies every string-valued entry from `process.env`
into the returned `env` object (lines 67-71), then `provider.ts` spreads
it into the spawn options (line 131). This means the child inherits ALL
environment variables, including secrets unrelated to Hermes:

- API keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY
- Database credentials: DATABASE_URL, POSTGRES_PASSWORD
- Cloud tokens: GITHUB_TOKEN, NPM_TOKEN, DOCKER_PASSWORD
- Any other secrets in the parent's environment

**Impact:** If the Hermes binary is compromised, replaced, or if the
configured `hermesBinaryPath` points to a malicious executable, ALL
secrets from the parent environment are exposed.

**Mitigating factors:**

- The binary is user-configured (config.yaml or env var)
- `verifyHermesBinary` runs `--version` before use
- In practice, Hermes needs API keys for the configured LLM provider

**Note:** The `globalAuth` config flag is parsed (config.ts:38-39) but
NEVER consumed by any provider code. It appears to be a dead config field
with no runtime effect.

**Recommendation:** Consider an env allowlist approach: only pass variables
starting with `HERMES_`, `OPENAI_`, `ANTHROPIC_`, plus standard vars like
`PATH`, `HOME`, `LANG`, etc. Or implement `globalAuth: false` to activate
filtering.

---

### H2 [MEDIUM] — redactSecrets() pattern gaps

**Location:** event-bridge.ts:29-33

**Description:**
The `redactSecrets()` function uses two regex patterns:

1. `\b(key|token|api_key|password|secret|auth)\b=\S+` (key=value)
2. `"(key|token|api_key|password|secret|auth)":\s*"[^"]*` (JSON)

**Patterns that ARE redacted:**

- `key=sk-abc123` → redacted ✓
- `token=Bearer xyz` → redacted ✓
- `api_key="secret"` → redacted ✓
- `password=p@ss` → redacted ✓
- `secret=123` → redacted ✓
- `auth=Basic xxx` → redacted ✓
- `{"api_key": "sk-..."}` → redacted ✓

**Patterns that are NOT redacted:**

- `OPENAI_API_KEY=sk-xxx` — `\bkey\b` doesn't match inside
  `OPENAI_API_KEY` because `_` is a \w character (no word boundary)
- `Authorization: Bearer sk-xxx` — no `Authorization` pattern
- `HERMES_API_KEY=xxx` — same \b boundary issue
- Bare token strings: `sk-abc123def456` without key= prefix
- `AWS_SECRET_ACCESS_KEY=xxx` — `secret` is embedded mid-word

**Impact:** If Hermes CLI outputs env-style variable assignments with
prefixed names (e.g., `OPENAI_API_KEY=...`) to stderr, they would pass
through unredacted. Severity is bounded by the fact that stderr is:
(a) capped at 50 lines / 500 chars per line
(b) only shown in warn-level logs and error messages
(c) truncated to 200 chars in error surfaces

**Recommendation:** Extend the regex to catch env-var prefixed patterns:
`/(API_KEY|SECRET|TOKEN|PASSWORD|AUTH)=\S+/gi` or use a broader word
boundary approach.

---

### H3 [LOW] — Binary path validation is existence-only

**Location:** binary-resolver.ts (hermes-specific), utils/binary-resolver.ts (shared)

**Description:**
Both the Hermes-specific and shared binary resolvers check `existsSync(path)`
but do NOT verify:

- The path is a regular file (not a directory, symlink, device)
- The file has execute permission
- The file is not a symlink to an unexpected target

`verifyHermesBinary()` (binary-resolver.ts:43-51) does run `--version`
via `execFile`, which provides some protection since:

- `execFile` does NOT use a shell (no shell injection)
- A non-executable file would fail with EACCES
- A directory would fail with EISDIR

**Impact:** LOW. The `execFile` verification mitigates most risks. An
attacker would need to place a malicious executable at the configured
path, which requires write access to the filesystem.

---

### H4 [LOW] — No content block size limit in ACP parser

**Location:** event-bridge.ts:158-168

**Description:**
When processing `session/update` notifications, the bridge extracts
`update.content.text` and pushes it directly into the queue without
size validation. A malicious or buggy Hermes process could send a
single `agent_message_chunk` with a multi-gigabyte text payload.

The line buffer is capped at 1 MiB (MAX_LINE_BUFFER_LENGTH), which
limits individual JSON lines. However, a single JSON line within that
1 MiB limit could contain a text field close to 1 MiB — which is
reasonable for streaming but could be surprising in edge cases.

**Impact:** LOW. The 1 MiB line buffer cap provides implicit protection.
Multi-gigabyte payloads would be split across multiple buffer reads and
would fail JSON parsing. The realistic maximum is ~1 MiB per chunk.

---

### H5 [INFO] — Redundant env spread in provider.ts

**Location:** provider.ts:131

**Description:**
`env: { ...process.env, ...session.env }` — `session.env` already
contains all entries from `process.env` (built in session-resolver.ts
lines 66-71 by iterating `Object.entries(process.env)`). The
`...process.env` spread is redundant. This is a code cleanliness issue,
not a security issue.

**Impact:** None. Functionally identical to `env: session.env`.

---

## Security Dimensions — Detailed Assessment

### 1. Env Var Handling

STATUS: MEDIUM RISK (H1)

- Full process.env spread to child — no filtering
- No env var allowlist or blocklist
- `globalAuth` config flag parsed but never consumed
- No `process.env` mutation (C3 verified absent)

### 2. Stderr Redaction

STATUS: MEDIUM RISK (H2)

- `redactSecrets()` implemented and called at ALL stderr output sites
- Covers common key=value and JSON patterns
- Gaps: prefixed env vars (OPENAI_API_KEY), Authorization headers, bare tokens
- Stderr capped at 50 lines × 500 chars — bounded exposure

### 3. Path Injection

STATUS: LOW RISK (H3)

- cwd validated as existing directory (session-resolver.ts:53-63)
- cwd validated as absolute path (event-bridge.ts:77-79)
- Binary path checked for file existence
- `execFile` (not `exec`) used — no shell injection possible
- Config path accepted as string, validated only by existence

### 4. stdin/stdout Safety (JSON-RPC)

STATUS: LOW RISK

- `parseMessage()` uses JSON.parse in try/catch — crash-safe
- Validates jsonrpc version, message structure, type constraints
- Line buffer capped at 1 MiB — prevents OOM
- Invalid messages logged and skipped (no throw)
- `isSessionUpdateParams` validates structure before type assertion
- ID generator wraps at MAX_SAFE_INTEGER — no overflow

### 5. Process Lifecycle

STATUS: LOW RISK

- `childProcess.unref()` prevents parent process hanging (line 82)
- `finally` block always sends SIGKILL as defensive cleanup (line 432)
- `emitTerminal` guard prevents duplicate terminal chunks (line 198)
- `queue.close()` drains waiters so consumer never hangs (line 421)
- Exit handler clears sigkillTimeout (line 206)
- Edge case: if parent crashes, `finally` doesn't run → child orphaned
  (mitigated by OS PID cleanup and hermes being a short-lived process)

### 6. Abort Handling

STATUS: GOOD

- Abort handler: session/cancel → SIGTERM → SIGKILL (5s) → queue.close()
- `{ once: true }` prevents double-fire
- `finally` block removes listener and clears timer
- All abort paths: emitTerminal + rejectPending + queue.close()
- Defensive SIGKILL in finally in case abort path was incomplete

### 7. Timeout Safety

STATUS: GOOD

- `ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS` validated:
  - Must be finite number > 0
  - Capped at MAX_TIMEOUT_MS = 300,000 (5 minutes)
  - Defaults to 60,000 (1 minute)
- Per-request timeout: REQUEST_TIMEOUT_MS = 30,000 (30 seconds)
- Binary verification timeout: 5,000 ms (hardcoded)

### 8. Data Leakage in Errors

STATUS: LOW RISK

- All stderr in error messages passes through `redactSecrets()`
- Error messages include exit code, signal — no secrets
- Binary path in error messages — not a secret
- Debug logs include truncated prompt (200 chars) — acceptable
- No env vars leaked in error messages

---

## Summary

| ID  | Severity | Finding                           | Status   |
| --- | -------- | --------------------------------- | -------- |
| C3  | —        | process.env mutation (Pi pattern) | ABSENT   |
| R5  | —        | stderr redaction                  | PRESENT  |
| I7  | —        | abortSignal listener leak         | RESOLVED |
| I18 | —        | process.env re-spread             | PRESENT  |
| H1  | MEDIUM   | Full process.env to child process | NEW      |
| H2  | MEDIUM   | redactSecrets pattern gaps        | NEW      |
| H3  | LOW      | Binary path validation weak       | NEW      |
| H4  | LOW      | No content block size limit       | NEW      |
| H5  | INFO     | Redundant env spread              | NEW      |

**Overall assessment:** The Hermes provider has solid process lifecycle
management, abort handling, and timeout safety. The two MEDIUM findings
(H1, H2) are bounded by operational context (local CLI tool, stderr
caps) but represent genuine defense-in-depth gaps. No HIGH or CRITICAL
issues found. Previous audit findings I7 and R5 are confirmed resolved
or present. C3 (process.env mutation) is confirmed absent.
