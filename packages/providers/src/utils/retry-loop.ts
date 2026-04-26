/**
 * Shared retry loop for provider async generators.
 *
 * Wraps an async generator with exponential backoff retry logic,
 * error classification, and terminal result chunk emission on
 * final failure (optional).
 */

export type ErrorCategory =
  | 'rate_limit'
  | 'auth'
  | 'crash'
  | 'unknown'
  | 'deterministic'
  | 'timeout'
  | 'aborted'
  | 'model_access';

/**
 * Pattern arrays used by the default classifier.
 */
export interface ErrorClassificationRules {
  rateLimitPatterns: string[];
  authPatterns: string[];
  crashPatterns: string[];
  deterministicPatterns?: string[];
}

/**
 * Result of classifying an error.
 */
export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
}

/**
 * Default classifier using substring matching against pattern arrays.
 */
export function classifyProviderError(
  error: Error,
  rules: ErrorClassificationRules
): ClassifiedError {
  const message = error.message.toLowerCase();
  if (rules.deterministicPatterns?.some(p => message.includes(p))) {
    return { category: 'deterministic', retryable: false };
  }
  if (rules.rateLimitPatterns.some(p => message.includes(p))) {
    return { category: 'rate_limit', retryable: true };
  }
  if (rules.authPatterns.some(p => message.includes(p))) {
    return { category: 'auth', retryable: false };
  }
  if (rules.crashPatterns.some(p => message.includes(p))) {
    return { category: 'crash', retryable: true };
  }
  return { category: 'unknown', retryable: false };
}

/**
 * Options for the withRetry wrapper.
 */
export interface WithRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  classifyError: (err: Error) => ClassifiedError;
  /**
   * Called before each retry with the enriched error and attempt number.
   * Return a replacement error to throw instead of retrying.
   */
  onBeforeRetry?: (err: Error, attempt: number) => Error | undefined;
  /**
   * If true, the final error is enriched with a provider-specific prefix
   * by the caller.  When false, withRetry throws the raw error.
   */
  enrichError?: (err: Error, category: ErrorCategory) => Error;
  abortSignal?: AbortSignal;
  /**
   * Logger context for retry telemetry.
   */
  log?: {
    error: (ctx: Record<string, unknown>, msg: string) => void;
    info: (ctx: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Wrap an async generator with retry logic.
 *
 * Each call to `fn` must return a fresh AsyncGenerator.  If a call throws,
 * the error is classified; retryable errors trigger an exponential backoff
 * delay and a fresh generator is created.  Non-retryable errors and
 * exhausted retries propagate immediately.
 */
export async function* withRetry<T>(
  fn: () => AsyncGenerator<T>,
  options: WithRetryOptions
): AsyncGenerator<T> {
  const { maxRetries, baseDelayMs, classifyError, abortSignal } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    try {
      yield* fn();
      return;
    } catch (error) {
      const err = error as Error;

      if (abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      const classified = classifyError(err);

      options.log?.error(
        {
          err,
          errorClass: classified.category,
          attempt,
          maxRetries,
        },
        'query_error'
      );

      // Allow caller to intercept and throw a replacement before retry logic
      const replacement = options.onBeforeRetry?.(err, attempt);
      if (replacement) {
        throw replacement;
      }

      const shouldRetry = classified.retryable && attempt < maxRetries;

      if (!shouldRetry) {
        const enriched = options.enrichError ? options.enrichError(err, classified.category) : err;
        throw enriched;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      options.log?.info({ attempt, delayMs, errorClass: classified.category }, 'retrying_query');
      await new Promise(resolve => setTimeout(resolve, delayMs));
      lastError = err;
    }
  }

  throw lastError ?? new Error('Query failed after retries');
}
