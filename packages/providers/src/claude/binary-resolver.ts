/**
 * Claude Code CLI resolver for compiled (bun --compile) archon binaries.
 *
 * Thin wrapper around the shared binary resolver that supplies
 * provider-specific strings (env var name, install instructions, etc.).
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the caller
 * omits `pathToClaudeCodeExecutable` entirely and the SDK resolves via its
 * normal node_modules lookup.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync as _existsSync } from 'node:fs';
import { resolveBinaryPath } from '../utils/binary-resolver';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

const INSTALL_INSTRUCTIONS =
  'Claude Code not found. Archon requires the Claude Code executable to be\n' +
  'reachable at a configured path in compiled builds.\n\n' +
  'To fix, install Claude Code and point Archon at it:\n\n' +
  '  macOS / Linux (recommended — native installer):\n' +
  '    curl -fsSL https://claude.ai/install.sh | bash\n' +
  '    export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"\n\n' +
  '  Windows (PowerShell):\n' +
  '    irm https://claude.ai/install.ps1 | iex\n' +
  '    $env:CLAUDE_BIN_PATH = "$env:USERPROFILE\\.local\\bin\\claude.exe"\n\n' +
  '  Or via npm (alternative):\n' +
  '    npm install -g @anthropic-ai/claude-code\n' +
  '    export CLAUDE_BIN_PATH="$(npm root -g)/@anthropic-ai/claude-code/cli.js"\n\n' +
  'Persist the path in ~/.archon/config.yaml instead of the env var:\n' +
  '    assistants:\n' +
  '      claude:\n' +
  '        claudeBinaryPath: /absolute/path/to/claude\n\n' +
  'See: https://archon.diy/docs/reference/configuration#claude';

/**
 * Resolve the path to the Claude Code executable (native binary in SDK 0.2.x;
 * legacy `cli.js` is still accepted for operators pinned to npm-installed
 * SDKs that ship a JS entry point).
 *
 * In dev mode: returns undefined (let SDK resolve from its bundled per-platform
 * native binary in `@anthropic-ai/claude-agent-sdk-<platform>`).
 * In binary mode: resolves from env/config, or throws with install instructions.
 */
export async function resolveClaudeBinaryPath(
  configClaudeBinaryPath?: string
): Promise<string | undefined> {
  const nativeInstallerPath =
    process.platform === 'win32'
      ? join(homedir(), '.local', 'bin', 'claude.exe')
      : join(homedir(), '.local', 'bin', 'claude');

  return resolveBinaryPath({
    envVar: 'CLAUDE_BIN_PATH',
    configPath: configClaudeBinaryPath,
    autodetectPaths: [nativeInstallerPath],
    throwOnMiss: true,
    installInstructions: INSTALL_INSTRUCTIONS,
    logId: 'claude-binary',
    logEvent: 'claude.binary_resolved',
    binaryName: 'Claude Code',
    fileExists,
    envErrorMessage: envPath =>
      `CLAUDE_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
      'Please verify the path points to the Claude Code executable (native binary\n' +
      'from the curl/PowerShell installer, or cli.js from an npm global install).',
    configErrorMessage: configPath =>
      `assistants.claude.claudeBinaryPath is set to "${configPath}" but the file does not exist.\n` +
      'Please verify the path in .archon/config.yaml points to the Claude Code executable.',
  });
}
