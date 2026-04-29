/**
 * Shared binary resolver for compiled (bun --compile) archon binaries.
 *
 * The provider-specific wrappers call this generic function with provider-
 * specific strings (env var names, config keys, autodetect paths, install
 * instructions, and log identifiers).
 *
 * Resolution order:
 * 1. Environment variable override
 * 2. Config file override
 * 3. Autodetect canonical install paths
 * 4. Throw with install instructions (or return undefined)
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so callers fall
 * back to normal node_modules / PATH resolution. Vendor paths are skipped in
 * dev mode (no bundled binary), but env var, config, and autodetect checks
 * still run so that user-installed binaries are found.
 */
import { existsSync as _existsSync } from 'node:fs';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Logger cache keyed by log identifier. */
const logCache = new Map<string, ReturnType<typeof createLogger>>();

function getLog(id: string): ReturnType<typeof createLogger> {
  let log = logCache.get(id);
  if (!log) {
    log = createLogger(id);
    logCache.set(id, log);
  }
  return log;
}

export interface ResolveBinaryPathOptions {
  /** Name of the environment variable to check (e.g. 'CLAUDE_BIN_PATH'). */
  envVar?: string;
  /** Config-provided binary path. */
  configPath?: string;
  /** Ordered list of paths to probe for autodetection. */
  autodetectPaths?: string[];
  /** Ordered list of vendor paths checked before autodetectPaths, logged as source: 'vendor'. */
  vendorPaths?: string[];
  /** If true, throw when the binary is not found. If false, return undefined. */
  throwOnMiss?: boolean;
  /** Install instructions included in the thrown error. */
  installInstructions?: string;
  /** Log identifier passed to createLogger (e.g. 'claude-binary'). */
  logId: string;
  /** Event name used for the resolved log line (e.g. 'claude.binary_resolved'). */
  logEvent: string;
  /** Human-readable name of the binary for generic error messages. */
  binaryName: string;
  /** Provider-specific error message when env var is set but file missing. */
  envErrorMessage?: (envPath: string) => string;
  /** Provider-specific error message when config path is set but file missing. */
  configErrorMessage?: (configPath: string) => string;
  /**
   * File existence checker. Defaults to the shared {@link fileExists}.
   * Providers should pass their own exported wrapper so tests can spyOn it.
   */
  fileExists?: (path: string) => boolean;
}

/**
 * Resolve a provider binary path using the standard pipeline.
 *
 * Always checks: env → config → autodetect, then either throws or returns
 * undefined based on `throwOnMiss`.
 *
 * In dev mode (BUNDLED_IS_BINARY=false): vendor paths are skipped (no bundled
 * binary), but env, config, and autodetect resolution still runs.
 */
export async function resolveBinaryPath(
  options: ResolveBinaryPathOptions
): Promise<string | undefined> {
  const {
    envVar,
    configPath,
    autodetectPaths = [],
    vendorPaths = [],
    throwOnMiss = true,
    installInstructions,
    logId,
    logEvent,
    binaryName,
    envErrorMessage,
    configErrorMessage,
    fileExists: checkFileExists = fileExists,
  } = options;

  const log = getLog(logId);

  // 1. Environment variable override
  if (envVar) {
    const envPath = process.env[envVar];
    if (envPath) {
      if (!checkFileExists(envPath)) {
        throw new Error(
          envErrorMessage?.(envPath) ??
            `${envVar} is set to "${envPath}" but the file does not exist.\n` +
              `Please verify the path points to the ${binaryName} executable.`
        );
      }
      log.info({ binaryPath: envPath, source: 'env' }, logEvent);
      return envPath;
    }
  }

  // 2. Config file override
  if (configPath) {
    if (!checkFileExists(configPath)) {
      throw new Error(
        configErrorMessage?.(configPath) ??
          `Config binary path is set to "${configPath}" but the file does not exist.\n` +
            `Please verify the path in .archon/config.yaml points to the ${binaryName} executable.`
      );
    }
    log.info({ binaryPath: configPath, source: 'config' }, logEvent);
    return configPath;
  }

  // 3. Vendor paths (user-placed binary)
  if (BUNDLED_IS_BINARY) {
    for (const probePath of vendorPaths) {
      if (checkFileExists(probePath)) {
        log.info({ binaryPath: probePath, source: 'vendor' }, logEvent);
        return probePath;
      }
    }
  }

  // 4. Autodetect canonical install paths
  for (const probePath of autodetectPaths) {
    if (checkFileExists(probePath)) {
      log.info({ binaryPath: probePath, source: 'autodetect' }, logEvent);
      return probePath;
    }
  }

  // 4. Not found
  if (throwOnMiss) {
    throw new Error(
      installInstructions ??
        `${binaryName} not found. Please set ${envVar} or configure the binary path in .archon/config.yaml.`
    );
  }

  return undefined;
}
