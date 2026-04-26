/**
 * Codex binary resolver for compiled (bun --compile) archon binaries.
 *
 * Thin wrapper around the shared binary resolver that supplies
 * provider-specific strings (env var name, install instructions, etc.).
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal node_modules-based resolution.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { existsSync as _existsSync } from 'node:fs';
import { resolveBinaryPath } from '../utils/binary-resolver';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

const CODEX_VENDOR_DIR = 'vendor/codex';

const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

/** Returns the vendor binary filename for the current platform, or undefined if unsupported. */
function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

/**
 * Canonical install locations probed by autodetect. Grounded in
 * the official @openai/codex README and the npm global-install contract
 * (npm writes the binary to `{npm_prefix}/bin/<name>` on POSIX and
 * `{npm_prefix}\<name>.cmd` on Windows). The probes cover the npm prefix
 * a default install lands at on each platform:
 *
 *  - `$HOME/.npm-global/bin/codex` — common when the user ran
 *    `npm config set prefix ~/.npm-global` to avoid root writes
 *  - `/opt/homebrew/bin/codex` — mac Apple Silicon with homebrew-node
 *    (homebrew sets npm prefix to /opt/homebrew)
 *  - `/usr/local/bin/codex` — mac Intel with homebrew-node, or linux
 *    with system-installed node (npm prefix defaults to /usr/local)
 *  - `%AppData%\npm\codex.cmd` — Windows npm global default
 *
 * Not covered (explicit override required via CODEX_BIN_PATH or config):
 *   - users with other custom npm prefixes — `npm root -g` would spawn
 *     a subprocess per resolve, too heavy for a probe helper
 *   - Homebrew cask install (`brew install --cask codex`) — cask layout
 *     isn't a PATH binary; users should symlink or set the path
 *   - manual GitHub Releases extract — placement is user-determined
 */
function getVendorPaths(): string[] {
  const paths: string[] = [];
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const archonHome = getArchonHome();
    paths.push(join(archonHome, CODEX_VENDOR_DIR, binaryName));
  }
  return paths;
}

function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'codex.cmd'));
    paths.push(join(homedir(), '.npm-global', 'codex.cmd'));
    return paths;
  }

  // POSIX (macOS + Linux)
  paths.push(join(homedir(), '.npm-global', 'bin', 'codex'));

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/codex');
  }

  paths.push('/usr/local/bin/codex');

  return paths;
}

/**
 * Resolve the path to the Codex native binary.
 *
 * In dev mode: returns undefined (let SDK resolve via node_modules).
 * In binary mode: resolves from env/config/vendor dir, or throws with install instructions.
 */
export async function resolveCodexBinaryPath(
  configCodexBinaryPath?: string
): Promise<string | undefined> {
  const autodetectPaths = getAutodetectPaths();
  const vendorPaths = getVendorPaths();

  const vendorPathStr = `~/.archon/${CODEX_VENDOR_DIR}/`;
  const installInstructions =
    'Codex CLI binary not found. The Codex provider requires a native binary\n' +
    'that cannot be resolved automatically in compiled Archon builds.\n\n' +
    'To fix, choose one of:\n' +
    '  1. Install globally: npm install -g @openai/codex\n' +
    '     Then set: CODEX_BIN_PATH=$(which codex)\n\n' +
    `  2. Place the binary at: ${vendorPathStr}\n\n` +
    '  3. Set the path in config:\n' +
    '     # .archon/config.yaml\n' +
    '     assistants:\n' +
    '       codex:\n' +
    '         codexBinaryPath: /path/to/codex\n';

  return resolveBinaryPath({
    envVar: 'CODEX_BIN_PATH',
    configPath: configCodexBinaryPath,
    vendorPaths,
    autodetectPaths,
    throwOnMiss: true,
    installInstructions,
    logId: 'codex-binary',
    logEvent: 'codex.binary_resolved',
    binaryName: 'Codex CLI',
    fileExists,
    envErrorMessage: envPath =>
      `CODEX_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
      'Please verify the path points to the Codex CLI binary.',
    configErrorMessage: configPath =>
      `assistants.codex.codexBinaryPath is set to "${configPath}" but the file does not exist.\n` +
      'Please verify the path in .archon/config.yaml points to the Codex CLI binary.',
  });
}
