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
import { HermesAcpClient } from './acp-client';
import { resolveHermesBinary, verifyHermesBinary, INSTALL_INSTRUCTIONS } from './binary-resolver';
import { resolveHermesSession } from './session-resolver';
import { createLazyLogger } from '../utils/lazy-logger';
import { withFirstEventTimeout } from './timeout-utils';
import { readHermesMcpConfig } from './hermes-mcp-reader';
import { HermesSessionPool } from './session-pool';
import { ConcurrencyLock } from './concurrency-lock';
import { classifyHermesError, HermesClassifiedError } from './error-classifier';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
const getLog = createLazyLogger('provider.hermes');

/** Module-level session pool singleton — persists across sendQuery calls. */
const defaultSessionPool = new HermesSessionPool();
const defaultConcurrencyLock = new ConcurrencyLock();

const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

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
 * Hermes provider — wraps the Hermes CLI tool via {@link HermesAcpClient}.
 * Uses the ACP (Agent Client Protocol) JSON-RPC 2.0 stdio transport for
 * structured communication.
 *
 * Each `sendQuery()` call creates a fresh {@link HermesAcpClient} which
 * spawns `hermes acp` and runs the full ACP handshake (`initialize` →
 * `session/new` → `session/prompt`), with streaming `session/update`
 * notifications bridged into Archon's `AsyncGenerator<MessageChunk>`
 * contract. All ACP interaction is delegated to the client.
 *
 * Session pooling: A module-level {@link HermesSessionPool} persists
 * {@link HermesAcpClient} instances across sendQuery calls for the same
 * cwd+model key. The first query creates a client with `keepAlive: true`
 * (full ACP init, but the child is not killed after completion).
 * Subsequent queries with the same key reuse the pooled client via
 * `prompt()` (skipInit mode), enabling true multi-turn conversation
 * continuity. The pool automatically cleans up idle/aged sessions and
 * is destroyed on process exit.
 *
 * v1 capabilities: sessionResume and mcp are true; the rest are false
 * (see `capabilities.ts`). These map to Hermes features but require
 * intentional wiring before they can be declared. Under-declaring is
 * honest; the dag-executor emits warnings for any nodeConfig field not
 * supported.
 */
export class HermesProvider implements IAgentProvider {
  constructor(
    private pool: HermesSessionPool = defaultSessionPool,
    private lock: ConcurrencyLock = defaultConcurrencyLock
  ) {}

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
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (options?.abortSignal?.aborted) throw new Error('Query aborted');
      await this.lock.acquire();
      try {
        yield* this._sendQueryOnce(prompt, cwd, resumeSessionId, options);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const classified =
          error instanceof HermesClassifiedError
            ? error.classification
            : classifyHermesError(error.message);
        if (!classified.shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) throw error;
        lastError = error;
      } finally {
        this.lock.release();
      }
      // Backoff sleeps OUTSIDE the lock (#5)
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      getLog().info({ attempt, delayMs }, 'hermes.retrying_query');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw lastError ?? new Error('Hermes query failed after retries');
  }

  /**
   * Execute a single query attempt (no retry or lock).
   * This is the original sendQuery implementation extracted for retry wrapping.
   */
  private async *_sendQueryOnce(
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
    //    Skip pool lookup when freshSession is requested (context:fresh or parallel layer).
    const pooled = options?.freshSession
      ? undefined
      : this.pool.acquire(session.cwd, model, config.provider);
    if (pooled?.client.isAlive()) {
      getLog().debug(
        { cwd: session.cwd, model, sessionId: pooled.sessionId },
        'hermes.reusing_pooled_session'
      );

      // Re-read MCP config (lightweight, keeps client contract simple).
      const mcpServers = await readHermesMcpConfig();

      // Reuse existing pooled session — prompt-only mode via HermesAcpClient.
      const clientPrompt = pooled.client.prompt(prompt, {
        systemPrompt: options?.systemPrompt,
        mcpServers,
        abortSignal: options?.abortSignal,
      });
      try {
        yield* withFirstEventTimeout(
          clientPrompt,
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
        // Signal client prompt generator to close and clean up (but NOT kill the
        // process — the client's keepAlive handles that).
        void clientPrompt.return(undefined);
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

    // 5. Create HermesAcpClient — spawns `hermes acp` with piped stdio.
    const client = new HermesAcpClient({
      binary: hermesBinary,
      args: ['acp'],
      env: { ...session.env, ...modelEnv },
      cwd: session.cwd,
    });

    // 6. Run full ACP handshake via client.init() — yield all chunks, intercept
    // the result chunk to capture sessionId for pool registration.
    const clientInit = client.init(prompt, {
      systemPrompt: options?.systemPrompt,
      mcpServers,
      abortSignal: options?.abortSignal,
    });

    let capturedSessionId: string | undefined;
    let queryFailed = false;

    try {
      const timeouted = withFirstEventTimeout(
        clientInit,
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
      void clientInit.return(undefined);

      if (capturedSessionId && !queryFailed) {
        // Success — register in pool for reuse by subsequent queries.
        // NOTE: This runs even for freshSession queries. That's intentional:
        // a fresh session avoids stale context for THIS query, but once used
        // it's clean and can be reused by the next non-fresh query.
        getLog().debug(
          { cwd: session.cwd, model, sessionId: capturedSessionId },
          'hermes.registering_pooled_session'
        );
        this.pool.set(
          session.cwd,
          model,
          {
            client,
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
          client.childProcess.on('exit', () => {
            cleanupTempDir(tempHermesHome);
          });
        }
      } else {
        // Failed or no sessionId — kill the process and clean up immediately.
        client.dispose();
        cleanupTempDir(tempHermesHome);
      }
    }
  }
}
