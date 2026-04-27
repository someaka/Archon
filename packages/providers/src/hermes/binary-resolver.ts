/**
 * Hermes CLI resolver for compiled (bun --compile) archon binaries.
 *
 * Thin wrapper around the shared binary resolver that supplies
 * provider-specific strings (env var name, install instructions, etc.).
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the caller
 * falls back to `'hermes'` from PATH.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync as _existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBinaryPath } from '../utils/binary-resolver';
import { createLazyLogger } from '../utils/lazy-logger';

const getLog = createLazyLogger('provider.hermes.binary-resolver');
const VERIFY_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
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

export async function verifyHermesBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: VERIFY_TIMEOUT_MS });
    return true;
  } catch (err) {
    getLog().debug({ err, binary }, 'hermes.binary_verify_failed');
    return false;
  }
}

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
  const canonicalPath = join(homedir(), '.local', 'bin', 'hermes');

  return resolveBinaryPath({
    envVar: 'HERMES_BINARY_PATH',
    configPath: configHermesBinaryPath,
    autodetectPaths: [canonicalPath],
    throwOnMiss: false,
    logId: 'hermes-binary',
    logEvent: 'hermes.binary_resolved',
    binaryName: 'Hermes',
    fileExists,
    envErrorMessage: envPath =>
      `HERMES_BINARY_PATH is set to "${envPath}" but the file does not exist.\n` +
      'Please verify the path points to the Hermes executable.',
    configErrorMessage: configPath =>
      `assistants.hermes.hermesBinaryPath is set to "${configPath}" but the file does not exist.\n` +
      'Please verify the path in .archon/config.yaml points to the Hermes executable.',
  });
}
