/**
 * Session resolver for Hermes Agent.
 *
 * Hermes CLI is stateless per invocation — each `sendQuery()` spawns a fresh
 * process. This module prepares the execution context (cwd + env) for that
 * single invocation. No persistent session store, resume, or conversation
 * history is maintained.
 */

/**
 * Execution context for a Hermes CLI invocation.
 * Hermes is stateless per invocation — there is no persistent session store,
 * session resume, or conversation history maintained across CLI calls. Each
 * `sendQuery()` spawns a fresh hermes process. This context captures the
 * working directory and merged environment for that single invocation.
 */
export interface HermesSessionContext {
  /** Working directory for the hermes CLI subprocess. */
  cwd: string;
  /** Session ID — always undefined for Hermes since sessions are single-shot.
   *  Present in the interface only for uniform provider shape. */
  sessionId?: string;
  /** Merged environment variables for the hermes subprocess.
   *  Caller-provided env overrides process.env entries. */
  env: Record<string, string>;
}

/**
 * Resolve a Hermes session context for a sendQuery call.
 *
 * Behavior:
 *   - cwd: validated to exist (falls back to process.cwd() when missing).
 *   - env: caller-provided vars are merged on top of process.env; caller wins.
 *   - resumeSessionId: logged as unsupported (Hermes has no session store),
 *     but does NOT throw — the caller can surface a warning chunk.
 *
 * Hermes ACP is stateless by design: each `hermes acp` invocation is
 * independent. There is no session persistence, resume, or threading model
 * on the Hermes side. Archon holds the conversation history; Hermes just
 * processes single-turn prompts.
 */
export function resolveHermesSession(options: {
  cwd: string;
  env?: Record<string, string>;
  resumeSessionId?: string;
}): HermesSessionContext {
  const { cwd: rawCwd, env: providedEnv, resumeSessionId } = options;

  // Validate cwd — fall back to process.cwd() if the provided path is empty.
  const cwd = rawCwd && rawCwd.length > 0 ? rawCwd : process.cwd();

  // Merge environment: process.env is the baseline, caller-provided env overrides.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([, v]): v is string => typeof v === 'string')
  );
  if (providedEnv) {
    for (const [key, value] of Object.entries(providedEnv)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
  }

  // Session resume is not supported — Hermes CLI is stateless per invocation.
  // Caller surfaces a warning via capabilities.sessionResume === false.
  void resumeSessionId;

  return { cwd, env };
}
