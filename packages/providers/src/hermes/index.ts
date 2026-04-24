/**
 * Hermes Agent provider -- built-in provider for Nous Research's Hermes CLI.
 *
 * Re-exports the public API surface: capabilities, config parser, model-ref
 * utilities, the provider class itself, and the registration hook.
 *
 * @example
 * ```typescript
 * import { HermesProvider, registerHermesProvider } from '@archon/providers/hermes';
 * ```
 */
export { HERMES_CAPABILITIES } from './capabilities';
export { parseHermesConfig, type HermesProviderDefaults } from './config';
export { isHermesModelCompatible, parseHermesModelRef, type HermesModelRef } from './model-ref';
export { HermesProvider } from './provider';
export { registerHermesProvider } from './registration';
