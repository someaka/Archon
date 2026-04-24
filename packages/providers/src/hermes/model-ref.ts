/**
 * Shape of a parsed Hermes model reference.
 * Hermes model refs carry both the LLM provider (ollama, openrouter, openai,
 * anthropic, etc.) and the model ID, since Hermes is an agent framework that
 * delegates to multiple underlying LLM providers.
 */
export interface HermesModelRef {
  /** The LLM provider backend — e.g. 'ollama', 'openrouter', 'openai', 'anthropic'. */
  provider: string;
  /** The model identifier — e.g. 'qwen2.5-coder:32b', 'llama3.1', 'anthropic/claude-opus-4'. */
  model: string;
}

/**
 * Parse a Hermes model reference string.
 *
 * Formats:
 *   - "hermes"                              → returns null (use defaults from config)
 *   - "hermes:qwen2.5-coder:32b"            → { provider: '<default>', model: 'qwen2.5-coder:32b' }
 *                                              (default provider comes from config)
 *   - "hermes:ollama/llama3.1"              → { provider: 'ollama', model: 'llama3.1' }
 *   - "hermes:openrouter/anthropic/claude-opus-4" → { provider: 'openrouter', model: 'anthropic/claude-opus-4' }
 *
 * The model portion may contain colons (ollama tags like "qwen2.5-coder:32b")
 * and slashes (openrouter namespaced models like "anthropic/claude-opus-4").
 * We split only on the FIRST '/' after the "hermes:" prefix, so everything
 * after the provider segment becomes the model ID.
 *
 * @param modelRef   — the raw model string (e.g. "hermes:ollama/llama3.1")
 * @param defaults   — optional fallback provider when the ref has no provider segment
 * @returns          — parsed HermesModelRef, or null for bare "hermes"
 */
export function parseHermesModelRef(
  modelRef: string,
  defaults?: { provider?: string }
): HermesModelRef | null {
  // Bare "hermes" — signal caller to use config defaults entirely.
  if (modelRef === 'hermes') {
    return null;
  }

  const prefix = 'hermes:';
  if (!modelRef.startsWith(prefix)) {
    return null;
  }

  const rest = modelRef.slice(prefix.length);

  // No provider/model separator — treat the whole rest as a model ID
  // and fall back to the default provider from config.
  const idx = rest.indexOf('/');
  if (idx <= 0) {
    if (!defaults?.provider) {
      return null;
    }
    return { provider: defaults.provider, model: rest };
  }

  const provider = rest.slice(0, idx);
  const model = rest.slice(idx + 1);

  if (provider.length === 0 || model.length === 0) {
    return null;
  }

  return { provider, model };
}

/**
 * Registry-level `isModelCompatible` check.
 * Syntactic only — returns true for the exact string "hermes" or any string
 * beginning with "hermes:". The actual model/provider availability is
 * validated at `sendQuery` time via the config and CLI binary.
 */
export function isHermesModelCompatible(model: string): boolean {
  return model === 'hermes' || model.startsWith('hermes:');
}
