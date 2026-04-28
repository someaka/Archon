import { isRegisteredProvider, registerProvider } from '../registry';

import { HERMES_CAPABILITIES } from './capabilities';
import { HermesProvider } from './provider';

/**
 * Register the Hermes built-in provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Hermes is a
 * core (builtIn: true) provider maintained by the Archon team alongside
 * Claude and Codex.
 */
export function registerHermesProvider(): void {
  if (isRegisteredProvider('hermes')) return;
  registerProvider({
    id: 'hermes',
    displayName: 'Hermes Agent (Nous Research)',
    factory: () => new HermesProvider(),
    capabilities: HERMES_CAPABILITIES,
    builtIn: true,
  });
}
