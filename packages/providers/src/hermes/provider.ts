import { spawn } from 'child_process';

import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { HERMES_CAPABILITIES } from './capabilities';
import { parseHermesConfig } from './config';
import { bridgeHermesSession } from './event-bridge';
import { buildHermesCliArgs } from './options-translator';
import { resolveHermesBinary } from './binary-resolver';
import { resolveHermesSession } from './session-resolver';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.hermes');
  return cachedLog;
}

/**
 * Hermes provider — wraps the Hermes Python CLI tool (invoked via
 * `child_process.spawn`). Hermes is a Python-based AI assistant that
 * supports tool use (bash, edit, write, grep, find, ls) and session
 * management.
 *
 * Each `sendQuery()` call spawns a fresh `hermes` process with `--json`
 * output mode. The {@link bridgeHermesSession} function in
 * `event-bridge.ts` bridges the newline-delimited JSON stdout stream into
 * Archon's `AsyncGenerator<MessageChunk>` contract.
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
   * Send a prompt to the Hermes CLI and yield streaming response chunks.
   *
   * Steps:
   *  1. Parse assistant config from `options.assistantConfig`
   *  2. Resolve session context (cwd, env, optional resumeSessionId)
   *  3. Resolve model from `options.model` or config default
   *  4. Build CLI arguments (prompt, model, system prompt, env)
   *  5. Locate the `hermes` binary (config override or PATH lookup)
   *  6. Spawn the child process with piped stdio
   *  7. Bridge the child process output via {@link bridgeHermesSession}
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

    // 2. Resolve session context (cwd, env, resume session id).
    const session = resolveHermesSession({
      cwd,
      env: options?.env,
      resumeSessionId,
    });

    // 3. Resolve model: request-level (workflow node / chat) → config default.
    const modelRef = options?.model ?? config.model;

    // 4. Build CLI arguments for `hermes chat --json ...`.
    const args = buildHermesCliArgs({
      prompt,
      cwd: session.cwd,
      modelRef,
      config,
      systemPrompt: options?.systemPrompt,
      env: options?.env,
    });

    // 5. Find the hermes binary. Config override wins; falls back to PATH.
    const hermesBinary = (await resolveHermesBinary(config.hermesBinaryPath)) ?? 'hermes';

    getLog().debug(
      {
        hermesBinary,
        args: args.slice(0, -1),
        cwd: session.cwd,
        modelRef,
      },
      'hermes.spawning_cli'
    );

    // 6. Spawn the child process with piped stdio.
    const child = spawn(hermesBinary, args, {
      cwd: session.cwd,
      env: { ...process.env, ...session.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 7. Bridge the session — yield all chunks from the child process.
    try {
      yield* bridgeHermesSession(child, options?.abortSignal);
      getLog().debug('hermes.query_completed');
    } catch (err) {
      getLog().error({ err }, 'hermes.query_failed');
      throw err;
    }
  }
}
