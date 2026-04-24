import type { ProviderCapabilities } from '../types';

/**
 * Hermes Agent capabilities — intentionally conservative. Declared flags must
 * reflect wired-up behavior, not potential support. The dag-executor uses
 * these to warn users when a workflow node specifies a feature the provider
 * ignores.
 *
 * sessionResume: false — Hermes CLI sessions are single-shot; each invocation
 * is independent and there is no persistent session store to resume from.
 *
 * skills: true — Hermes has built-in skills support via its skill system.
 *
 * envInjection: true — Hermes accepts env vars via --env flags and HERMES_*
 * environment variables, matching the standard pattern.
 *
 * fallbackModel: true — Hermes config supports specifying a fallback model
 * when the primary is unavailable.
 *
 * structuredOutput is best-effort (not SDK-enforced like Claude/Codex):
 * the --json flag requests JSON output but Hermes does not guarantee schema
 * compliance the way Claude's outputFormat does.
 */
export const HERMES_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: true,
  sandbox: false,
};
