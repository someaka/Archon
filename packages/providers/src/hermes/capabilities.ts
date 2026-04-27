import type { ProviderCapabilities } from '../types';

/**
 * Hermes Agent capabilities — intentionally conservative. Declared flags must
 * reflect wired-up behavior, not potential support. The dag-executor uses
 * these to warn users when a workflow node specifies a feature the provider
 * ignores.
 *
 * sessionResume: true — The Hermes provider maintains a session pool that
 * persists child processes across sendQuery calls for the same cwd+model
 * combination. Pooled sessions are reused with skipInit mode (no re-init),
 * enabling true multi-turn conversation continuity.
 *
 * skills: false — Hermes does not currently have wired-up skills support.
 *
 * envInjection: true — Hermes accepts env vars via --env flags and HERMES_*
 * environment variables, matching the standard pattern.
 *
 * fallbackModel: false — Hermes does not currently support specifying a
 * fallback model when the primary is unavailable.
 *
 * structuredOutput is best-effort (not SDK-enforced like Claude/Codex):
 * the --json flag requests JSON output but Hermes does not guarantee schema
 * compliance the way Claude's outputFormat does.
 */
export const HERMES_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
