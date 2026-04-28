import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  HermesProviderDefaults,
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { HERMES_CAPABILITIES } from './capabilities';
import { parseHermesConfig, getHermesLiveConfig } from './config';
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
const defaultSessionPool = new HermesSessionPool();

// Clean up pool on process exit to prevent zombie child processes.
let signalHandlersRegistered = false;
if (!signalHandlersRegistered) {
  signalHandlersRegistered = true;
  process.on('exit', () => {
    defaultSessionPool.destroy();
  });
  process.on('SIGTERM', () => {
    defaultSessionPool.destroy();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    defaultSessionPool.destroy();
    process.exit(0);
  });
}

const MAX_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Build the effective Hermes config by merging Archon's assistantConfig with
 * the live hermes config (~/.hermes/config.yaml).
 *
 * Precedence for model/provider:
 *   1. Explicit options.model (workflow/node specifies model) — caller handles
 *   2. Live hermes config model/provider (authoritative)
 *   3. Archon config model/provider (fallback)
 *
 * Operational settings (globalAuth, hermesBinaryPath) always come from Archon config.
 */
async function buildHermesConfig(
  assistantConfig: Record<string, unknown>
): Promise<HermesProviderDefaults> {
  const archonConfig = parseHermesConfig(assistantConfig);
  const liveConfig = await getHermesLiveConfig();

  // Live config wins for model/provider; Archon config wins for operational settings
  return {
    model: liveConfig.model ?? archonConfig.model,
    provider: liveConfig.provider ?? archonConfig.provider,
    endpoint: archonConfig.endpoint, // endpoint stays from Archon config
    globalAuth: archonConfig.globalAuth,
    hermesBinaryPath: archonConfig.hermesBinaryPath,
  };
}

/** Symlink a file/dir if it exists. Silent no-op on missing source or link error. */
function trySymlink(source: string, dest: string): void {
  if (existsSync(source)) {
    try {
      symlinkSync(source, dest);
    } catch {
      /* source gone or dest exists */
    }
  }
}

/** Remove a temp directory silently. No-op if undefined or already gone. */
function cleanupTempDir(dir?: string): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

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
  constructor(private pool: HermesSessionPool = defaultSessionPool) {}

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
    // 1. Build effective config: merge Archon operational settings with live hermes
    //    model/provider from ~/.hermes/config.yaml. Live config is authoritative for
    //    model/provider — Archon config provides operational settings only.
    const config = await buildHermesConfig(options?.assistantConfig ?? {});

    // 2. Resolve session context (cwd, env).
    const session = resolveHermesSession({
      cwd,
      env: options?.env,
      resumeSessionId,
    });

    // Determine model key for pool lookup.
    const model = options?.model ?? config.model ?? 'default';

    // 3. Check session pool for an existing session (keyed by cwd + provider + model).
    const pooled = this.pool.acquire(session.cwd, model, config.provider);
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
        this.pool.delete(session.cwd, model, config.provider);
        getLog().error({ err }, 'hermes.pooled_query_failed');
        throw err;
      } finally {
        // Release the session back to the pool (success or error path —
        // delete() above handles eviction on error, release is a no-op then).
        this.pool.release(session.cwd, model, config.provider);
        // Signal bridge to close queue and remove listeners (but NOT kill the
        // process — keepAlive: true handles that).
        void bridge.return(undefined);
      }
      return;
    }

    // Remove stale pool entry if process has exited.
    if (pooled) {
      this.pool.delete(session.cwd, model, config.provider);
    }

    // 4. No pooled session — full spawn path.

    // 4a. Find the hermes binary. Config override wins; falls back to PATH.
    const hermesBinary = (await resolveHermesBinary(config.hermesBinaryPath)) ?? 'hermes';

    // 4b. If workflow/node specifies a model, create a temporary HERMES_HOME
    // with a config.yaml override. This is the production mechanism for
    // per-node model selection — HERMES_MODEL env var does NOT work in ACP mode,
    // and session/new does not accept a model param (ACP spec).
    const modelEnv: Record<string, string> = {};
    // Archon convention: HERMES_USE_GLOBAL_AUTH signals the Hermes ACP subprocess
    // to use globally configured auth (from `hermes login`) instead of per-session
    // credentials. Not an official Hermes env var — Archon-specific for Docker/CI.
    if (config.globalAuth) {
      modelEnv.HERMES_USE_GLOBAL_AUTH = 'true';
    }
    let tempHermesHome: string | undefined;
    // Only create temp HERMES_HOME when workflow/node explicitly specifies a model.
    // When no explicit model, hermes reads from its own ~/.hermes/config.yaml —
    // the live config is authoritative, not Archon's override.
    if (options?.model) {
      tempHermesHome = mkdtempSync(join(tmpdir(), 'hermes-archon-'));
      // When we get here, options.model is guaranteed non-null (per the condition above).
      // Use the explicit model + any provider/endpoint from config for the temp override.
      const modelOverride = options.model;
      const hasStructured = config.provider || config.endpoint;
      const modelConfig: Record<string, unknown> = {
        default: modelOverride,
      };
      if (config.provider) modelConfig.provider = config.provider;
      if (config.endpoint) modelConfig.base_url = config.endpoint;
      // Bun.YAML.stringify handles special chars safely — no manual escaping needed.
      writeFileSync(
        join(tempHermesHome, 'config.yaml'),
        Bun.YAML.stringify({
          model: hasStructured ? modelConfig : modelOverride,
        })
      );
      // Symlink config files from real HERMES_HOME into temp dir
      const realHermesHome = join(process.env.HOME || '/root', '.hermes');
      trySymlink(join(realHermesHome, '.env'), join(tempHermesHome, '.env'));
      trySymlink(join(realHermesHome, 'skills'), join(tempHermesHome, 'skills'));
      trySymlink(join(realHermesHome, 'auth.json'), join(tempHermesHome, 'auth.json'));
      modelEnv.HERMES_HOME = tempHermesHome;
    }

    // 4c. Pre-flight check — verify the binary is executable and responds to --version.
    const isValid = await verifyHermesBinary(hermesBinary);
    if (!isValid) {
      cleanupTempDir(tempHermesHome);
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
        this.pool.set(
          session.cwd,
          model,
          {
            childProcess: child,
            sessionId: capturedSessionId,
            cwd: session.cwd,
            model,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            inUse: false,
          },
          config.provider
        );
        // Clean up tempHermesHome when the pooled process eventually exits.
        if (tempHermesHome) {
          child.on('exit', () => {
            cleanupTempDir(tempHermesHome);
          });
        }
      } else {
        // Failed or no sessionId — kill the process and clean up immediately.
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        cleanupTempDir(tempHermesHome);
      }
    }
  }
}
