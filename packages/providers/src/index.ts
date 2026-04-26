// Types (contract layer — re-exported for convenience)
export type {
  IAgentProvider,
  AgentRequestOptions,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaults,
  ProviderDefaultsMap,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  MessageChunk,
  TokenUsage,
  HermesProviderDefaults,
} from './types';

// Provider config types (canonical definitions in ./types, re-exported via config modules)
// Import from ./types directly or from the config modules — both work.

// Registry
export {
  registerProvider,
  getAgentProvider,
  getRegistration,
  getProviderCapabilities,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from './registry';

// Error
export { UnknownProviderError } from './errors';

// Provider classes
export { ClaudeProvider } from './claude/provider';
export { CodexProvider } from './codex/provider';

// Config parsers
export { parseClaudeConfig, type ClaudeProviderDefaults } from './claude/config';
export { parseCodexConfig, type CodexProviderDefaults } from './codex/config';

// Utilities (needed by consumers)
export { resetCodexSingleton } from './codex/provider';
export { resolveCodexBinaryPath, fileExists as codexFileExists } from './codex/binary-resolver';
export { resolveClaudeBinaryPath, fileExists as claudeFileExists } from './claude/binary-resolver';

// Community providers
export {
  PiProvider,
  parsePiConfig,
  registerPiProvider,
  type PiProviderDefaults,
} from './community/pi';

// Hermes Agent provider
export { HermesProvider } from './hermes/provider';
export { registerHermesProvider } from './hermes/registration';
export { HERMES_CAPABILITIES } from './hermes/capabilities';
export { parseHermesConfig } from './hermes/config';
export { parseHermesModelRef, isHermesModelCompatible } from './hermes/model-ref';
export {
  resolveHermesModel,
  resolveHermesProvider,
  resolveHermesEndpoint,
} from './hermes/options-translator';
export { bridgeHermesSession } from './hermes/event-bridge';
export { AsyncQueue } from './utils/async-queue';
export { resolveHermesBinary } from './hermes/binary-resolver';
export { resolveHermesSession } from './hermes/session-resolver';
export type { HermesModelRef } from './hermes/model-ref';
