# Verification: Test Coverage Gap Analysis — Hermes Provider

# Date: 2026-04-27

# Scope: packages/providers/src/hermes/_.ts + _.test.ts

## EXECUTIVE SUMMARY

Overall test quality is GOOD for a first-pass implementation. The happy path, most
error paths, and core protocol logic are covered. However, there are significant
gaps in testing the remediation's NEW code paths (redactSecrets, MAX_TIMEOUT_MS cap,
backpressure, line buffer truncation, statSync validation), several edge cases, and
assertion depth. The most security-critical gap is that redactSecrets() has ZERO
direct test coverage despite being a security-sensitive code path.

Coverage score by file:
acp-protocol.ts ████████████░░ ~85% (good, minor gaps)
event-bridge.ts ████████░░░░░░ ~60% (major gaps on new code paths)
provider.ts ██████░░░░░░░░ ~50% (timeout cap untested, verifyHermesBinary fail untested)
binary-resolver.ts ██████████████ ~95% (excellent)
session-resolver.ts ██████████░░░░ ~75% (statSync error paths untested)
config.ts ██████████████ ~95% (excellent)
error-classifier.ts ████████████░░ ~85% (good, object-style API untested)
model-ref.ts ██████████████ ~95% (excellent)
options-translator.ts██████████████ ~95% (excellent)
timeout-utils.ts ██████████░░░░ ~75% (basic cases covered, no edge cases)
capabilities.ts ██████████████ 100% (static constant)
registration.ts ░░░░░░░░░░░░░░ 0% (no test file exists)

---

## 1. NEW CODE COVERAGE — Remediated Code Paths

### 1.1 redactSecrets() — event-bridge.ts:29-33

Status: **_ NOT TESTED _**
The function is used internally in stderr handling and error messages but is never
directly tested. No test verifies that API keys, tokens, or passwords in stderr
output are actually redacted before being logged or included in error chunks.

Missing tests:

- redactSecrets('key=sk-abc123') → 'key=[REDACTED]'
- redactSecrets('{"api_key": "sk-secret"}') → '{"api_key":"[REDACTED]'
- redactSecrets('token=BEARER_xyz password=hunter2') → both redacted
- redactSecrets('no secrets here') → passthrough unchanged
- Integration: stderr containing 'API_KEY=sk-xxx' → verify logged output is redacted

Severity: HIGH — security-sensitive code with zero coverage.

### 1.2 emitTerminal() dedup guard — event-bridge.ts:197-201

Status: PARTIALLY TESTED (indirect)
emitTerminal is called on every terminal path (normal completion, non-zero exit,
signal, error, abort), but NO test specifically triggers the dedup case where
both an error event AND an exit event fire on the same process.

Missing test:

- Process emits 'error' then 'exit' with non-zero code → only ONE terminal result chunk

Severity: MEDIUM — dedup correctness prevents duplicate chunks reaching consumers.

### 1.3 MAX_TIMEOUT_MS cap — provider.ts:20-38

Status: **_ NOT TESTED _**
getFirstEventTimeoutMs() is a module-level private function with no direct test.
No test exercises the ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS env var, the cap at
300_000ms, or the fallback to 60_000ms.

Missing tests:

- Env var set to valid value (e.g., '120000') → uses 120000
- Env var set to value > 300000 → capped at 300000, warning logged
- Env var set to negative → falls back to 60000
- Env var set to 'not-a-number' → falls back to 60000
- Env var set to 'Infinity' → falls back to 60000
- Env var unset → falls back to 60000

Severity: MEDIUM — incorrect timeout could cause hangs or premature kills.

### 1.4 Backpressure on stdin.write — event-bridge.ts:312-317

Status: **_ NOT TESTED _**
The `if (!canWrite)` branch and subsequent `drain` event listener are never
exercised in any test. Also the abort-path backpressure check (line 258-259)
is untested.

Missing tests:

- stdin.write returns false → drain listener attached
- stdin.write returns false during abort → backpressure debug logged

Severity: LOW — backpressure is a correctness safeguard for large payloads.

### 1.5 Line buffer truncation — event-bridge.ts:107-123

Status: **_ NOT TESTED _**
The MAX_LINE_BUFFER_LENGTH (1 MiB) guard is never exercised. No test sends
enough data to stdout to trigger truncation.

Missing tests:

- Incoming data exceeds MAX_LINE_BUFFER_LENGTH → buffer truncated, warning logged
- Single partial line exceeds MAX_LINE_BUFFER_LENGTH → truncated

Severity: LOW — defensive code for adversarial/buggy subprocess output.

### 1.6 statSync validation — session-resolver.ts:53-63

Status: PARTIALLY TESTED
Tests exist for empty/undefined cwd (falls back to process.cwd()). But the
statSync error paths are not tested.

Missing tests:

- cwd that does not exist → throws 'does not exist'
- cwd that is a file (not directory) → throws 'not a directory'

Severity: MEDIUM — unclear error messages without validation.

### 1.7 Request timeout (30s) — event-bridge.ts:319-329

Status: **_ NOT TESTED _**
The REQUEST_TIMEOUT_MS race in sendRequest() is never exercised. No test
simulates a subprocess that accepts a request but never responds.

Missing test:

- Subprocess never responds to initialize → times out after 30s → error result

Severity: MEDIUM — production hangs if Hermes CLI stalls.

---

## 2. ERROR PATH COVERAGE

### 2.1 Covered error paths:

[✓] spawn failure (EACCES) — provider.test.ts, event-bridge.test.ts
[✓] Process non-zero exit — event-bridge.test.ts
[✓] Process terminated by signal — event-bridge.test.ts
[✓] Abort signal (pre-aborted) — provider.test.ts, event-bridge.test.ts
[✓] verifyHermesBinary returns false — binary-resolver.test.ts (execFile throws)
[✓] Invalid JSON on stdout — acp-protocol.test.ts (parseMessage returns null)
[✓] Config path/env var not found — binary-resolver.test.ts

### 2.2 Missing error paths:

[✗] verifyHermesBinary failure in provider.sendQuery — provider.test.ts does NOT
test the throw on line 114-117 of provider.ts ('not executable or not working').
The mock always returns true.
[✗] JSON-RPC error response from Hermes — no test simulates a response with
`{jsonrpc: "2.0", id: 1, error: {code: -32603, message: "..."}}`.
[✗] Abort during mid-stream — all abort tests use pre-aborted signals.
No test fires abort while chunks are actively streaming.
[✗] SIGKILL fallback (5-second timer) — the setTimeout on line 270-277 is
never tested (would require waiting 5s or mocking setTimeout).
[✗] Non-zero exit with stderr content — exit is tested but the stderr inclusion
in the error message is not asserted.
[✗] Error event with stderr content — same: error event tested but stderr
inclusion in error message is not verified.
[✗] getFirstEventTimeoutMs env var — see section 1.3.
[✗] Protocol version mismatch — event-bridge.ts line 349-353 checks for
protocol_version !== 1, but no test exercises this path.

---

## 3. EDGE CASE COVERAGE

### 3.1 Covered edge cases:

[✓] Empty config object — config.test.ts
[✓] Empty model string — model-ref.test.ts
[✓] Empty/undefined cwd — session-resolver.test.ts
[✓] Non-string env values — session-resolver.test.ts
[✓] Empty env object — session-resolver.test.ts
[✓] Empty notification stream — event-bridge.test.ts
[✓] Invalid JSON — acp-protocol.test.ts
[✓] Non-numeric id — acp-protocol.test.ts
[✓] Result+method collision — acp-protocol.test.ts
[✓] Non-numeric error code — acp-protocol.test.ts
[✓] Non-string method — acp-protocol.test.ts
[✓] Model with colons (ollama tags) — model-ref.test.ts
[✓] Nested slashes (openrouter) — model-ref.test.ts
[✓] Null/undefined config values — config.test.ts
[✓] Malformed URL endpoint — config.test.ts

### 3.2 Missing edge cases:

[✗] parseMessage with empty string '' — should return null
[✗] parseMessage with whitespace-only string — should return null
[✗] parseMessage with null/undefined error object — e.g.,
`{"jsonrpc":"2.0","id":1,"error":null}` — should return null
[✗] parseMessage notification with no params —
`{"jsonrpc":"2.0","method":"session/update"}` — should parse (params is optional)
[✗] parseMessage with extra unknown fields — should still parse valid messages
[✗] isSessionUpdateParams with unknown sessionUpdate value — e.g., 'unknown_update'
[✗] isSessionUpdateParams with missing sessionId
[✗] isSessionUpdateParams with null input
[✗] session-resolver with non-existent cwd → throws 'does not exist'
[✗] session-resolver with cwd that is a file → throws 'not a directory'
[✗] event-bridge with empty prompt string — should still send session/prompt
[✗] event-bridge with relative cwd — should throw 'requires absolute cwd'
[✗] AcpIdGenerator wrap at MAX_SAFE_INTEGER — should wrap to 1
[✗] parseHermesModelRef('hermes:') — empty model after prefix with no slash
[✗] classifyHermesError with object-style context — e.g.,
classifyHermesError('fail', {jsonRpcCode: -32603})
[✗] classifyHermesError with stderr as string (not array) in object context
[✗] classifyHermesError with no context (undefined second arg)

---

## 4. MOCK QUALITY ANALYSIS

### 4.1 @archon/paths mocks

All test files that import from @archon/paths include BUNDLED_VERSION in their
mock. This is correct and consistent.

provider.test.ts: BUNDLED_VERSION='dev' ✓ BUNDLED_IS_BINARY=false ✓ createLogger ✓
event-bridge.test.ts: BUNDLED_VERSION='dev' ✓ BUNDLED_IS_BINARY=false ✓ createLogger ✓
binary-resolver.test.ts: BUNDLED_VERSION='dev' ✓ BUNDLED_IS_BINARY=toggled ✓ createLogger ✓
session-resolver.test.ts: BUNDLED_VERSION='dev' ✓ BUNDLED_IS_BINARY=false ✓ createLogger ✓
config.test.ts: No @archon/paths import (no logger used) ✓ N/A
error-classifier.test.ts: No @archon/paths import (no logger used) ✓ N/A
model-ref.test.ts: No @archon/paths import (no logger used) ✓ N/A
options-translator.test.ts:No @archon/paths import (no logger used) ✓ N/A
timeout-utils.test.ts: No @archon/paths import (no logger used) ✓ N/A
acp-protocol.test.ts: No @archon/paths import (no logger used) ✓ N/A

### 4.2 Mock fidelity for ChildProcess

Both provider.test.ts and event-bridge.test.ts create mock ChildProcess objects.
The shape covers:
✓ pid, stdout, stderr, stdin, kill, unref, ref, killed
Missing properties (not currently needed but could break if source changes):
✗ connected, channel, exitCode, signalCode, spawnargs, spawnfile, stdio, send, disconnect

Assessment: Adequate for current usage. The missing properties are not accessed
by the bridge or provider code.

### 4.3 Mock fidelity for binary-resolver (provider.test.ts)

Mock exports: resolveHermesBinary, verifyHermesBinary, fileExists, INSTALL_INSTRUCTIONS
Real exports: resolveHermesBinary, verifyHermesBinary, fileExists, INSTALL_INSTRUCTIONS
Match: ✓ All exported members covered.

### 4.4 Mock fidelity for child_process (provider.test.ts)

Only `spawn` is mocked. The real module also exports execFile, exec, fork, etc.
Since provider.ts only imports `spawn`, this is adequate. ✓

### 4.5 Mock fidelity for child_process (binary-resolver.test.ts)

Only `execFile` is mocked. Since binary-resolver.ts imports `execFile`, this is
adequate. ✓

### 4.6 ACP Mock Process shape

The createAcpMock() in both provider.test.ts and event-bridge.test.ts faithfully
implements the ACP protocol flow: initialize → session/new → session/prompt.
The mock correctly handles stdin writes and pushes responses to stdout. ✓

However, the event-bridge mock does NOT simulate JSON-RPC error responses. The
mock only sends success responses. This means the bridge's error response handling
path is untested.

---

## 5. ASSERTION QUALITY ANALYSIS

### 5.1 Weak assertions (behavior not fully validated):

1. provider.test.ts "resume session is accepted without throwing"
   Current: expect(error).toBeUndefined()
   Missing: Should verify no warning chunk is emitted (or that a warning IS emitted
   if that's the intended behavior). The test name implies "accepted" but doesn't
   verify the actual session resume behavior.

2. provider.test.ts "spawn failure is handled gracefully"
   Current: Checks isError: true
   Missing: Should assert error message contains 'spawn EACCES' or similar.

3. event-bridge.test.ts "systemPrompt is sent as separate ContentBlock"
   Current: Only checks result chunk exists
   Missing: Should capture what was written to stdin and verify the prompt array
   contains two ContentBlocks (systemPrompt + prompt).

4. event-bridge.test.ts "stderr output is captured and logged"
   Current: Checks assistant chunk still arrives
   Missing: Should assert on mockLogger.warn calls to verify stderr was logged.
   Should verify the stderr line appears in error messages on failure paths.

5. event-bridge.test.ts "process non-zero exit → result with isError: true"
   Current: Checks isError: true
   Missing: Should assert errors array contains 'exited with code 1'.

6. event-bridge.test.ts "process crash via error event → result with isError: true"
   Current: Checks isError: true
   Missing: Should assert errors array contains 'spawn failure'.

7. event-bridge.test.ts "abort signal → error result"
   Current: Checks isError: true, errors: ['Query was aborted']
   This is GOOD — properly validates error content. ✓

### 5.2 Tests with NO meaningful assertion:

None found. All tests have at least one expect() call.

---

## 6. TEST ORGANIZATION

### 6.1 File structure: ✓

One test file per source file. Clean 1:1 mapping.

### 6.2 Describe block grouping: ✓

Tests are grouped by function/feature within each file. The event-bridge.test.ts
groups AsyncQueue tests and bridgeHermesSession tests separately.

### 6.3 Test name descriptiveness: ✓ (mostly)

Most test names clearly describe the scenario and expected outcome. Minor issues:

- "session context shape validation" is vague — should specify what shape is validated
- "resume session is accepted without throwing" — unclear what "accepted" means

### 6.4 Missing test files:

- registration.ts has NO test file. registerHermesProvider() is untested.
- capabilities.ts has no dedicated test but is covered indirectly via provider.test.ts.

---

## 7. PRIORITIZED REMEDIATION RECOMMENDATIONS

### P0 (Security / Correctness):

1. Add direct tests for redactSecrets() — verify keys/tokens/passwords are redacted.
2. Add test for verifyHermesBinary failure in provider.sendQuery (the throw path).
3. Add test for JSON-RPC error response handling in the bridge.

### P1 (New code paths from remediation):

4. Add tests for getFirstEventTimeoutMs() — env var parsing, MAX_TIMEOUT_MS cap,
   fallback behavior. Requires either exporting the function or testing via the
   provider's sendQuery with different env vars.
5. Add tests for statSync error paths in session-resolver (ENOENT, not-directory).
6. Add test for emitTerminal dedup (error event + exit both firing).
7. Add test for request timeout (30s REQUEST_TIMEOUT_MS) in the bridge.
8. Add test for protocol version mismatch in the bridge.

### P2 (Edge cases):

9. Add edge case tests for parseMessage (empty string, whitespace, null error).
10. Add test for relative cwd in bridgeHermesSession (should throw).
11. Add test for AcpIdGenerator wrap at MAX_SAFE_INTEGER.
12. Add tests for classifyHermesError with object-style context API.
13. Add test for isSessionUpdateParams with invalid inputs.

### P3 (Assertion improvements):

14. Strengthen assertions in provider.test.ts spawn failure test (check error message).
15. Strengthen assertions in event-bridge stderr test (check logger calls).
16. Strengthen assertions in systemPrompt test (capture stdin writes).
17. Add test for non-zero exit with stderr content (verify error message includes stderr).

### P4 (Nice to have):

18. Add registration.ts test (registerHermesProvider idempotency).
19. Add line buffer truncation test for event-bridge.
20. Add stderr line limit test (MAX_STDERR_LINES).
21. Add abort-during-mid-stream test.

---

## FILES READ

Source files (13):
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/provider.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/event-bridge.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/acp-protocol.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/binary-resolver.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/session-resolver.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/config.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/error-classifier.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/model-ref.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/options-translator.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/timeout-utils.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/capabilities.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/index.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/registration.ts

Test files (10):
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/provider.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/event-bridge.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/acp-protocol.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/binary-resolver.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/session-resolver.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/config.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/error-classifier.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/model-ref.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/options-translator.test.ts
/home/d/Desktop/Archon-canonical/packages/providers/src/hermes/timeout-utils.test.ts
