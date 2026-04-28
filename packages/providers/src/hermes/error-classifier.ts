export type HermesErrorClass =
  | 'rate_limit'
  | 'auth'
  | 'permission'
  | 'crash'
  | 'unknown'
  | 'protocol';

export interface ClassifiedError {
  errorClass: HermesErrorClass;
  shouldRetry: boolean;
  enrichedMessage: string;
}

/**
 * Classify a Hermes subprocess error based on the error message, stderr output,
 * and process exit code.
 *
 * Rules (applied in order):
 *  1. protocol      — JSON-RPC error codes (takes precedence)
 *  2. rate_limit    — message/stderr includes "rate limit", "429", "timed out", "timeout"
 *  3. auth          — message/stderr includes "unauthorized", "invalid api key"
 *  4. permission    — message/stderr includes "eacces", "enoent", "enotdir"
 *  5. crash         — non-zero exit code OR message/stderr includes "panic"
 *  6. unknown       — everything else
 */
export function classifyHermesError(
  message: string,
  contextOrStderrLines?:
    | {
        jsonRpcCode?: number;
        stderr?: string | string[];
        exitCode?: number | null;
      }
    | string[],
  maybeExitCode?: number | null
): ClassifiedError {
  // Normalize arguments to support both legacy and object-style calls.
  let jsonRpcCode: number | undefined;
  let stderrStr: string;
  let exitCode: number | null;

  if (Array.isArray(contextOrStderrLines)) {
    stderrStr = contextOrStderrLines.join(' ');
    exitCode = maybeExitCode ?? null;
  } else if (contextOrStderrLines != null) {
    jsonRpcCode = contextOrStderrLines.jsonRpcCode;
    const rawStderr = contextOrStderrLines.stderr ?? '';
    stderrStr = Array.isArray(rawStderr) ? rawStderr.join(' ') : rawStderr;
    exitCode = contextOrStderrLines.exitCode ?? null;
  } else {
    stderrStr = '';
    exitCode = maybeExitCode ?? null;
  }

  const msg = message.toLowerCase();
  const std = stderrStr.toLowerCase();
  const combined = `${msg} ${std}`;

  // JSON-RPC error code classification (takes precedence)
  if (jsonRpcCode !== undefined) {
    const code = jsonRpcCode;
    if (code === -32700 || code === -32600 || code === -32601 || code === -32602) {
      return {
        errorClass: 'protocol',
        shouldRetry: false,
        enrichedMessage: `Hermes protocol error (code ${code}): ${message}`,
      };
    }
    if (code === -32603) {
      return {
        errorClass: 'crash',
        shouldRetry: false,
        enrichedMessage: `Hermes server error (code ${code}): ${message}`,
      };
    }
    if (code === -32000 || code === -32001 || code === -32002) {
      return {
        errorClass: 'unknown',
        shouldRetry: true,
        enrichedMessage: `Hermes agent error (code ${code}): ${message}`,
      };
    }
  }

  // First-event timeout (subprocess hang) → NOT retryable
  // "no output within Nms" means the subprocess never produced output — retrying won't help
  if (combined.includes('no output within')) {
    return {
      errorClass: 'crash',
      shouldRetry: false,
      enrichedMessage: `First-event timeout (subprocess hang): ${message}`,
    };
  }

  // Rate limit / timeout → retryable
  if (
    combined.includes('rate limit') ||
    combined.includes('429') ||
    combined.includes('timed out') ||
    combined.includes('timeout')
  ) {
    return {
      errorClass: 'rate_limit',
      shouldRetry: true,
      enrichedMessage: `Rate limit or timeout detected: ${message}`,
    };
  }

  // Auth failures → NOT retryable
  if (combined.includes('unauthorized') || combined.includes('invalid api key')) {
    return {
      errorClass: 'auth',
      shouldRetry: false,
      enrichedMessage: `Authentication failed: ${message}`,
    };
  }

  // Permission errors → NOT retryable
  if (combined.includes('eacces') || combined.includes('enoent') || combined.includes('enotdir')) {
    return {
      errorClass: 'permission',
      shouldRetry: false,
      enrichedMessage: `Permission or path error detected: ${message}`,
    };
  }

  // Crash (non-zero exit or panic) → retryable
  if ((exitCode !== null && exitCode !== 0) || combined.includes('panic')) {
    return {
      errorClass: 'crash',
      shouldRetry: true,
      enrichedMessage: `Hermes process crashed: ${message}`,
    };
  }

  return {
    errorClass: 'unknown',
    shouldRetry: true,
    enrichedMessage: `Hermes error (unknown): ${message}`,
  };
}
