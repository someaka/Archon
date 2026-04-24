import type { HermesProviderDefaults } from '../types';

export type { HermesProviderDefaults };

/**
 * Parse raw YAML-derived config into typed Hermes defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, and parsePiConfig — never throws, so broken user config
 * can't prevent provider registration or workflow discovery).
 *
 * Endpoint validation uses new URL() in a try/catch: malformed URLs are
 * dropped silently rather than causing a throw at parse time.
 *
 * If provider === 'ollama' and no endpoint is provided, this parser does NOT
 * inject a default here — the options-translator handles ollama endpoint
 * defaulting at CLI arg build time, keeping config parsing side-effect free.
 */
export function parseHermesConfig(raw: Record<string, unknown>): HermesProviderDefaults {
  const result: HermesProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.provider === 'string') {
    result.provider = raw.provider;
  }

  if (typeof raw.endpoint === 'string') {
    try {
      new URL(raw.endpoint);
      result.endpoint = raw.endpoint;
    } catch {
      // Malformed URL — drop silently, don't throw.
    }
  }

  if (typeof raw.globalAuth === 'boolean') {
    result.globalAuth = raw.globalAuth;
  }

  if (typeof raw.hermesBinaryPath === 'string') {
    result.hermesBinaryPath = raw.hermesBinaryPath;
  }

  return result;
}
