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
