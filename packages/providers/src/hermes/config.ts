import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { HermesProviderDefaults } from '../types';
import { createLazyLogger } from '../utils/lazy-logger';

const getLog = createLazyLogger('provider.hermes.config');

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

/**
 * Read model/provider from Hermes's live config.yaml (~/.hermes/config.yaml).
 *
 * This is the AUTHORITATIVE source for what model Hermes is currently using.
 * Called when the workflow doesn't specify a model — defers to Hermes's own
 * configuration instead of Archon's config.yaml overrides.
 *
 * Hermes config.yaml structure (relevant fields):
 *   model:
 *     default: mimo-v2.5-pro
 *     provider: xiaomi
 *     base_url: https://token-plan-ams.xiaomimimo.com/v1
 *
 * Returns empty object if config file doesn't exist or can't be parsed.
 * Never throws — defensive like parseHermesConfig.
 */
export async function getHermesLiveConfig(): Promise<{
  model?: string;
  provider?: string;
}> {
  const configPath = join(homedir(), '.hermes', 'config.yaml');

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      getLog().debug({ configPath }, 'hermes.live_config_not_found');
      return {};
    }
    getLog().warn({ err, configPath }, 'hermes.live_config_read_error');
    return {};
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.YAML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    getLog().warn({ err, configPath }, 'hermes.live_config_parse_error');
    return {};
  }

  // model can be a string (simple) or an object (structured with default/provider/base_url)
  const modelSection = parsed.model;
  let model: string | undefined;
  let provider: string | undefined;

  if (typeof modelSection === 'string') {
    // Simple format: model: "mimo-v2.5-pro"
    model = modelSection;
  } else if (typeof modelSection === 'object' && modelSection !== null) {
    // Structured format: model: { default: "...", provider: "...", base_url: "..." }
    const modelObj = modelSection as Record<string, unknown>;
    if (typeof modelObj.default === 'string') {
      model = modelObj.default;
    }
    if (typeof modelObj.provider === 'string') {
      provider = modelObj.provider;
    }
  }

  getLog().debug(
    { configPath, model: model ?? '(none)', provider: provider ?? '(none)' },
    'hermes.live_config_read'
  );

  return { model, provider };
}
