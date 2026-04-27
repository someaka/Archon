import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { HERMES_CAPABILITIES } from './capabilities';
import { parseHermesConfig } from './config';
import { bridgeHermesSession } from './event-bridge';
import { resolveHermesBinary, verifyHermesBinary, INSTALL_INSTRUCTIONS } from './binary-resolver';
import { resolveHermesSession } from './session-resolver';
import { createLazyLogger } from '../utils/lazy-logger';
import { withFirstEventTimeout } from './timeout-utils';
import { readHermesMcpConfig } from './hermes-mcp-reader';
import { HermesSessionPool } from './session-pool';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
const getLog = createLazyLogger('provider.hermes');

/** Module-level session pool singleton — persists across sendQuery calls. */
const sessionPool = new HermesSessionPool();

// Clean up pool on process exit to prevent zombie child processes.
process.on('exit', () => {
  sessionPool.destroy();
});
process.on('SIGTERM', () => {
  sessionPool.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  sessionPool.destroy();
  process.exit(0);
});

const MAX_TIMEOUT_MS = 300_000; // 5 minutes

export function getFirstEventTimeoutMs(): number {
  const raw = process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed > MAX_TIMEOUT_MS) {
        getLog().warn(
          { requested: parsed, capped: MAX_TIMEOUT_MS },
          'hermes.first_event_timeout_capped'
        );
        return MAX_TIMEOUT_MS;
      }
      return parsed;
    }
  }
  return 60_000;
}

/**
 * Hermes provider — wraps the Hermes CLI tool (invoked via
 * `child_process.spawn`). Uses the ACP (Agent Client Protocol) JSON-RPC 2.0
 * stdio transport for structured communication.
 *
 * Each `sendQuery()` call spawns a fresh `hermes acp` process. The
 * {@link bridgeHermesSession} function in `event-bridge.ts` handles the
 * ACP lifecycle: `initialize` → `session/new` → `session/prompt`, with
 * streaming `session/update` notifications bridged into Archon's
 * `AsyncGenerator<MessageChunk>` contract.
 *
 * Session pooling: A module-level {@link HermesSessionPool} persists child
 * processes across sendQuery calls for the same cwd+model key. The first
 * query spawns a new process with `keepAlive: true` (full ACP init, but
 * the child is not killed after completion). Subsequent queries with the
 * same key reuse the pooled process via `skipInit: true` mode, enabling
 * true multi-turn conversation continuity. The pool automatically cleans
 * up idle/aged sessions and is destroyed on process exit.
 *
 * v1 capabilities: sessionResume and mcp are true; the rest are false
 * (see `capabilities.ts`). These map to Hermes features but require
 * intentional wiring before they can be declared. Under-declaring is
 * honest; the dag-executor emits warnings for any nodeConfig field not
 * supported.
 */
export class HermesProvider implements IAgentProvider {
  /**
   * Return the provider type identifier.
   */
  getType(): string {
    return 'hermes';
  }

  /**
   * Return the provider's capability flags.
   * Used by the dag-executor to warn when nodes specify unsupported features.
   */
  getCapabilities(): ProviderCapabilities {
    return HERMES_CAPABILITIES;
  }

  /**
   * Send a prompt to Hermes via ACP and yield streaming response chunks.
   *
   * Session pool integration:
   *  - If a pooled session exists for the same cwd+model key, reuse it
   *    (skipInit mode) without spawning a new process.
   *  - Otherwise, spawn a fresh process with keepAlive: true so it survives
   *    after the bridge completes, then register it in the pool.
   *
   * Steps:
   *  1. Parse assistant config from `options.assistantConfig`
   *  2. Resolve session context (cwd, env)
   *  3. Check session pool for an existing session
   *  4. If pooled: reuse via skipInit mode
   *  5. If not pooled: locate binary, spawn, bridge, register in pool
   *
   * Error handling: spawn failures and non-zero exits are surfaced through
   * the bridge as `result` chunks with `isError: true`. The bridge also
   * handles abort signals (SIGTERM + SIGKILL fallback) and zombie-process
   * prevention.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // 1. Parse assistant config (.archon/config.yaml assistants.hermes section).
    const config = parseHermesConfig(options?.assistantConfig ?? {});

    // 2. Resolve session context (cwd, env).
    const session = resolveHermesSession({
      cwd,
      env: options?.env,
      resumeSessionId,
    });

    // Determine model key for pool lookup.
    const model = options?.model ?? config.model ?? 'default';

    // 3. Check session pool for an existing session.
    const pooled = sessionPool.get(session.cwd, model);
    if (pooled && !pooled.childProcess.killed && pooled.childProcess.exitCode === null) {
      getLog().debug(
        { cwd: session.cwd, model, sessionId: pooled.sessionId },
        'hermes.reusing_pooled_session'
      );

      // Re-read MCP config (lightweight, keeps bridge contract simple).
      const mcpServers = await readHermesMcpConfig();

      // Reuse existing pooled session — prompt-only mode.
      const bridge = bridgeHermesSession(
        pooled.childProcess,
        {
          prompt,
          cwd: session.cwd,
          systemPrompt: options?.systemPrompt,
          mcpServers,
          skipInit: true,
          existingSessionId: pooled.sessionId,
          keepAlive: true,
        },
        options?.abortSignal
      );
      try {
        yield* withFirstEventTimeout(
          bridge,
          getFirstEventTimeoutMs(),
          `hermes acp pooled cwd=${session.cwd}`
        );
        getLog().debug('hermes.pooled_query_completed');
      } catch (err) {
        // Pool session is likely dead — evict it so next call spawns fresh.
        sessionPool.delete(session.cwd, model);
        getLog().error({ err }, 'hermes.pooled_query_failed');
        throw err;
      } finally {
        // Signal bridge to close queue and remove listeners (but NOT kill the
        // process — keepAlive: true handles that).
        void bridge.return(undefined);
      }
      return;
    }

    // Remove stale pool entry if process has exited.
    if (pooled) {
      sessionPool.delete(session.cwd, model);
    }

    // 4. No pooled session — full spawn path.

    // 4a. Find the hermes binary. Config override wins; falls back to PATH.
    const hermesBinary = (await resolveHermesBinary(config.hermesBinaryPath)) ?? 'hermes';

    // 4b. If workflow/node specifies a model, create a temporary HERMES_HOME
    // with a config.yaml override. This is the production mechanism for
    // per-node model selection — HERMES_MODEL env var does NOT work in ACP mode,
    // and session/new does not accept a model param (ACP spec).
    const modelEnv: Record<string, string> = {};
    let tempHermesHome: string | undefined;
    if (options?.model) {
      tempHermesHome = mkdtempSync(join(tmpdir(), 'hermes-archon-'));
      // Escape model string to prevent YAML injection
      const escapedModel = options.model
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
      writeFileSync(join(tempHermesHome, 'config.yaml'), `model: "${escapedModel}"\n`);
      // Symlink .env for API keys
      const realHermesHome = join(process.env.HOME || '/root', '.hermes');
      const realEnv = join(realHermesHome, '.env');
      if (existsSync(realEnv)) {
        try {
          symlinkSync(realEnv, join(tempHermesHome, '.env'));
        } catch {
          /* ignore */
        }
      }
      // Symlink skills directory
      const realSkills = join(realHermesHome, 'skills');
      if (existsSync(realSkills)) {
        try {
          symlinkSync(realSkills, join(tempHermesHome, 'skills'));
        } catch {
          /* ignore */
        }
      }
      // Symlink auth.json for OAuth credentials
      const realAuth = join(realHermesHome, 'auth.json');
      if (existsSync(realAuth)) {
        try {
          symlinkSync(realAuth, join(tempHermesHome, 'auth.json'));
        } catch {
          /* ignore */
        }
      }
      modelEnv.HERMES_HOME = tempHermesHome;
    }

    // 4c. Pre-flight check — verify the binary is executable and responds to --version.
    const isValid = await verifyHermesBinary(hermesBinary);
    if (!isValid) {
      // Clean up temp dir before throwing.
      if (tempHermesHome) {
        try {
          rmSync(tempHermesHome, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      throw new Error(
        `Hermes binary '${hermesBinary}' is not executable or not working. ${INSTALL_INSTRUCTIONS}`
      );
    }

    // 4d. Read MCP server config from ~/.hermes/config.yaml (before spawn so
    // the await doesn't create a microtask gap between spawn and bridge setup).
    const mcpServers = await readHermesMcpConfig();
    getLog().debug(
      {
        hermesBinary,
        cwd: session.cwd,
        model,
        prompt: prompt.slice(0, 200),
      },
      'hermes.spawning_acp'
    );

    // 5. Spawn `hermes acp` with piped stdio.
    const child = spawn(hermesBinary, ['acp'], {
      cwd: session.cwd,
      env: { ...session.env, ...modelEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 6. Bridge the ACP session with keepAlive — yield all chunks, intercept
    // the result chunk to capture sessionId for pool registration.
    const bridge = bridgeHermesSession(
      child,
      {
        prompt,
        cwd: session.cwd,
        systemPrompt: options?.systemPrompt,
        mcpServers,
        keepAlive: true,
      },
      options?.abortSignal
    );

    let capturedSessionId: string | undefined;
    let queryFailed = false;

    try {
      const timeouted = withFirstEventTimeout(
        bridge,
        getFirstEventTimeoutMs(),
        `hermes acp cwd=${session.cwd}`
      );
      for await (const chunk of timeouted) {
        // Capture sessionId from the terminal result chunk.
        if (chunk.type === 'result' && chunk.sessionId) {
          capturedSessionId = chunk.sessionId;
          if (chunk.isError) {
            queryFailed = true;
          }
        }
        yield chunk;
      }
      getLog().debug('hermes.query_completed');
    } catch (err) {
      queryFailed = true;
      getLog().error({ err }, 'hermes.query_failed');
      throw err;
    } finally {
      // Signal bridge to close queue and remove listeners.
      void bridge.return(undefined);

      if (capturedSessionId && !queryFailed) {
        // Success — register in pool for reuse by subsequent queries.
        getLog().debug(
          { cwd: session.cwd, model, sessionId: capturedSessionId },
          'hermes.registering_pooled_session'
        );
        sessionPool.set(session.cwd, model, {
          childProcess: child,
          sessionId: capturedSessionId,
          cwd: session.cwd,
          model,
          createdAt: Date.now(),
          lastUsed: Date.now(),
        });
        // Clean up tempHermesHome when the pooled process eventually exits.
        if (tempHermesHome) {
          child.on('exit', () => {
            try {
              rmSync(tempHermesHome, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          });
        }
      } else {
        // Failed or no sessionId — kill the process and clean up immediately.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        if (tempHermesHome) {
          try {
            rmSync(tempHermesHome, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}
