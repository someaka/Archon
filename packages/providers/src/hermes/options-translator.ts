import type { HermesProviderDefaults } from '../types';

import { parseHermesModelRef } from './model-ref';

// ─── Model resolution ──────────────────────────────────────────────────────

/**
 * Resolve the Hermes model from a model reference string and config defaults.
 *
 * Resolution order:
 *   1. modelRef is a string with "hermes:" prefix → parse it
 *   2. modelRef is "hermes" or undefined → use config.model
 *   3. Nothing resolved → return null (caller should error or use hermes default)
 *
 * @param modelRef  — raw model string from the request (may be undefined)
 * @param config    — parsed HermesProviderDefaults from config.yaml
 * @returns         — resolved { provider, model } or null
 */
export function resolveHermesModel(
  modelRef: string | undefined,
  config: HermesProviderDefaults
): { provider: string; model: string } | null {
  if (modelRef) {
    const parsed = parseHermesModelRef(modelRef, { provider: config.provider });
    if (parsed) {
      return { provider: parsed.provider, model: parsed.model };
    }
  }

  // Fallback to config defaults when no modelRef or bare "hermes" ref.
  if (config.model && config.provider) {
    return { provider: config.provider, model: config.model };
  }

  if (config.model) {
    // Model without provider — can't fully resolve
    return { provider: config.provider ?? '<default>', model: config.model };
  }

  return null;
}

/**
 * Resolve the LLM provider (ollama, openrouter, openai, anthropic, etc.)
 * from the model reference and config.
 *
 * @param modelRef  — raw model string from the request
 * @param config    — parsed HermesProviderDefaults from config.yaml
 * @returns         — provider string or undefined
 */
export function resolveHermesProvider(
  modelRef: string | undefined,
  config: HermesProviderDefaults
): string | undefined {
  if (modelRef) {
    const parsed = parseHermesModelRef(modelRef, { provider: config.provider });
    if (parsed) {
      return parsed.provider;
    }
  }

  return config.provider;
}

// ─── Endpoint resolution ───────────────────────────────────────────────────

/** Default Ollama endpoint when none is configured. */
const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434/v1';

/**
 * Resolve the API endpoint for Hermes CLI.
 *
 * Rules:
 *   - If config.endpoint is set → use it directly.
 *   - If provider is 'ollama' and no endpoint → default to localhost.
 *   - Otherwise → undefined (Hermes will use its own defaults).
 *
 * @param config  — parsed HermesProviderDefaults from config.yaml
 * @returns       — endpoint URL string or undefined
 */
export function resolveHermesEndpoint(config: HermesProviderDefaults): string | undefined {
  if (config.endpoint) {
    return config.endpoint;
  }

  if (config.provider === 'ollama') {
    return OLLAMA_DEFAULT_ENDPOINT;
  }

  return undefined;
}

// ─── CLI argument builder ──────────────────────────────────────────────────

/**
 * Providers accepted by the Hermes CLI `chat` subcommand.
 * Hermes has its own provider namespace; values not in this set are
 * internal/agent-side identifiers (e.g. 'opencode-go') and must NOT
 * be passed to the CLI — Hermes resolves them from ~/.hermes/config.yaml.
 */
const HERMES_CLI_PROVIDERS = new Set([
  'auto',
  'openrouter',
  'nous',
  'openai-codex',
  'copilot-acp',
  'copilot',
  'anthropic',
  'gemini',
  'xai',
  'ollama-cloud',
  'huggingface',
  'zai',
  'kimi-coding',
  'kimi-coding-cn',
  'stepfun',
  'minimax',
  'minimax-cn',
  'kilocode',
  'xiaomi',
  'arcee',
  'nvidia',
]);

/**
 * Build Hermes CLI arguments for the `chat` subcommand.
 *
 * Translates Archon's SendQueryOptions-derived fields into the hermes CLI
 * flag vocabulary. Defensive: undefined/null values are omitted rather than
 * emitting empty flags.
 *
 * Args produced (in order):
 *   chat              — the subcommand
 *   --json            — request structured JSON output
 *   --model <model>   — if resolved from modelRef/config
 *   --provider <p>    — if resolved AND known to Hermes CLI
 *   --endpoint <url>  — if configured or defaulted
 *   --system <prompt> — if systemPrompt provided
 *   --cwd <cwd>       — working directory
 *   --prompt <prompt> — user prompt
 *
 * @param options  — options bag containing prompt, cwd, modelRef, config, etc.
 * @returns        — array of CLI argument strings
 */
export function buildHermesCliArgs(options: {
  prompt: string;
  cwd: string;
  modelRef?: string;
  config?: HermesProviderDefaults;
  systemPrompt?: string;
  env?: Record<string, string>;
}): string[] {
  const { prompt, cwd, modelRef, config, systemPrompt, env } = options;

  const args: string[] = ['chat', '--json'];

  const effectiveConfig = config ?? {};

  // --model
  const resolvedModel = resolveHermesModel(modelRef, effectiveConfig);
  if (resolvedModel?.model && resolvedModel.model !== '<default>') {
    args.push('--model', resolvedModel.model);
  }

  // --provider: only pass if Hermes CLI recognises it. Internal/provider-side
  // identifiers (e.g. 'opencode-go') are omitted so Hermes resolves the
  // backend from its own ~/.hermes/config.yaml.
  const resolvedProvider = resolveHermesProvider(modelRef, effectiveConfig);
  if (resolvedProvider && HERMES_CLI_PROVIDERS.has(resolvedProvider)) {
    args.push('--provider', resolvedProvider);
  }

  // --endpoint
  const resolvedEndpoint = resolveHermesEndpoint(effectiveConfig);
  if (resolvedEndpoint) {
    args.push('--endpoint', resolvedEndpoint);
  }

  // --system
  if (systemPrompt && systemPrompt.length > 0) {
    args.push('--system', systemPrompt);
  }

  // --cwd
  args.push('--cwd', cwd);

  // --env flags (one per env var)
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        args.push('--env', `${key}=${value}`);
      }
    }
  }

  // --prompt (always last — user prompt)
  args.push('--prompt', prompt);

  return args;
}
