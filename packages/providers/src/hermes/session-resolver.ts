/**
 * Session resolver for Hermes Agent.
 *
 * Prepares the execution context (cwd + env) for each sendQuery call.
 * Session continuity is handled by the provider-level session pool
 * (see session-pool.ts), not by this resolver.
 */

import { statSync } from 'node:fs';

/**
 * Execution context for a Hermes CLI invocation.
 * Captures the working directory and merged environment for a sendQuery call.
 * Session persistence is handled upstream by the provider's session pool.
 */
export interface HermesSessionContext {
  /** Working directory for the hermes CLI subprocess. */
  cwd: string;
  /** Session ID — not managed by this resolver (the provider pool tracks session IDs).
   *  Present in the interface for uniform provider shape. */
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
 *   - resumeSessionId: accepted but not used here. The provider-level session
 *     pool handles multi-turn reuse via skipInit mode.
 */
export function resolveHermesSession(options: {
  cwd: string;
  env?: Record<string, string>;
  resumeSessionId?: string;
}): HermesSessionContext {
  const { cwd: rawCwd, env: providedEnv, resumeSessionId } = options;

  // Validate cwd — fall back to process.cwd() if the provided path is empty, then verify existence and directory.
  const cwd = rawCwd && rawCwd.length > 0 ? rawCwd : process.cwd();
  try {
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Hermes session cwd is not a directory: ${cwd}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Hermes session cwd does not exist: ${cwd}`);
    }
    throw err;
  }

  // Merge environment: process.env is the baseline, caller-provided env overrides.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (providedEnv) {
    for (const [key, value] of Object.entries(providedEnv)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
  }

  // resumeSessionId is not used here — the provider session pool handles
  // multi-turn reuse via skipInit mode. Parameter is kept for interface
  // compatibility.
  void resumeSessionId;

  return { cwd, env };
}
