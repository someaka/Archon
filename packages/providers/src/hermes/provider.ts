import { spawn } from 'child_process';

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

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
const getLog = createLazyLogger('provider.hermes');

const MAX_TIMEOUT_MS = 300_000; // 5 minutes

function getFirstEventTimeoutMs(): number {
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
 * v1 capabilities are all false (see `capabilities.ts`): sessionResume,
 * mcp, hooks, skills, agents, toolRestrictions, structuredOutput,
 * costControl, effortControl, thinkingControl, fallbackModel, sandbox.
 * These map to Hermes features but require intentional wiring before they
 * can be declared. Under-declaring is honest; the dag-executor emits
 * warnings for any nodeConfig field not supported.
 *
 * The provider is stateless — no instance state is needed. Each query
 * creates its own child process and session context.
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
   * Steps:
   *  1. Parse assistant config from `options.assistantConfig`
   *  2. Resolve session context (cwd, env)
   *  3. Locate the `hermes` binary (config override or PATH lookup)
   *  4. Spawn `hermes acp` with piped stdio
   *  5. Bridge the ACP session via {@link bridgeHermesSession}
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

    // 3. Find the hermes binary. Config override wins; falls back to PATH.
    const hermesBinary = (await resolveHermesBinary(config.hermesBinaryPath)) ?? 'hermes';

    // 3a. Pre-flight check — verify the binary is executable and responds to --version.
    const isValid = await verifyHermesBinary(hermesBinary);
    if (!isValid) {
      throw new Error(
        `Hermes binary '${hermesBinary}' is not executable or not working. ${INSTALL_INSTRUCTIONS}`
      );
    }

    getLog().debug(
      {
        hermesBinary,
        cwd: session.cwd,
        prompt: prompt.slice(0, 200),
      },
      'hermes.spawning_acp'
    );

    // 4. Spawn `hermes acp` with piped stdio.
    const child = spawn(hermesBinary, ['acp'], {
      cwd: session.cwd,
      env: { ...process.env, ...session.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 5. Bridge the ACP session — yield all chunks from the child process.
    try {
      yield* withFirstEventTimeout(
        bridgeHermesSession(
          child,
          {
            prompt,
            cwd: session.cwd,
            systemPrompt: options?.systemPrompt,
          },
          options?.abortSignal
        ),
        getFirstEventTimeoutMs(),
        `hermes acp cwd=${session.cwd}`
      );
      getLog().debug('hermes.query_completed');
    } catch (err) {
      getLog().error({ err }, 'hermes.query_failed');
      throw err;
    }
  }
}
