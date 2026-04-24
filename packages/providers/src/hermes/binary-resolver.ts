/**
 * Hermes CLI resolver for compiled (bun --compile) archon binaries.
 *
 * The Hermes provider spawns a subprocess using the `hermes` binary.
 * In dev mode the binary is resolved from PATH; in compiled binaries
 * we need explicit resolution so the frozen build path doesn't break
 * on end-user machines.
 *
 * Resolution order (binary mode only):
 * 1. `HERMES_BINARY_PATH` environment variable
 * 2. `assistants.hermes.hermesBinaryPath` in config
 * 3. Autodetect canonical install path (`~/.local/bin/hermes`)
 * 4. Return undefined (caller falls back to PATH)
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the caller
 * falls back to `'hermes'` from PATH.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('hermes-binary');
  return cachedLog;
}

export const INSTALL_INSTRUCTIONS =
  'Hermes binary not found. Archon requires the Hermes executable to be\n' +
  'reachable at a configured path in compiled builds.\n\n' +
  'To fix, install Hermes and point Archon at it:\n\n' +
  '  macOS / Linux (recommended):\n' +
  '    pip install hermes-cli\n' +
  '    export HERMES_BINARY_PATH="$(which hermes)"\n\n' +
  '  Or install from source:\n' +
  '    git clone https://github.com/NousResearch/hermes.git\n' +
  '    cd hermes && pip install -e .\n' +
  '    export HERMES_BINARY_PATH="$(which hermes)"\n\n' +
  'Persist the path in ~/.archon/config.yaml instead of the env var:\n' +
  '    assistants:\n' +
  '      hermes:\n' +
  '        hermesBinaryPath: /absolute/path/to/hermes\n\n' +
  'See: https://archon.diy/docs/reference/configuration#hermes';

/**
 * Resolve the path to the Hermes CLI binary.
 *
 * In dev mode: returns undefined (caller falls back to `'hermes'` from PATH).
 * In binary mode: resolves from env/config/autodetect, or returns undefined
 * so the caller falls back to PATH.
 */
export async function resolveHermesBinary(
  configHermesBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.HERMES_BINARY_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `HERMES_BINARY_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the Hermes executable.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'hermes.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configHermesBinaryPath) {
    if (!fileExists(configHermesBinaryPath)) {
      throw new Error(
        `assistants.hermes.hermesBinaryPath is set to "${configHermesBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Hermes executable.'
      );
    }
    getLog().info(
      { binaryPath: configHermesBinaryPath, source: 'config' },
      'hermes.binary_resolved'
    );
    return configHermesBinaryPath;
  }

  // 3. Autodetect — canonical user-local install path
  const canonicalPath = join(homedir(), '.local', 'bin', 'hermes');
  if (fileExists(canonicalPath)) {
    getLog().info({ binaryPath: canonicalPath, source: 'autodetect' }, 'hermes.binary_resolved');
    return canonicalPath;
  }

  // 4. Not found — return undefined so caller falls back to PATH
  return undefined;
}
