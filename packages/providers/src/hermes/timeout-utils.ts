export interface FirstEventHangDiagnosticsInput {
  /** Same as withFirstEventTimeout timeoutMs */
  timeoutMs: number;
  /** Same as withFirstEventTimeout context string */
  context: string;
  /** Provider name, e.g. "openai", "anthropic" */
  providerName: string;
  /** Model identifier, e.g. "gpt-4o" */
  model: string;
  /** Current working directory when the request was made */
  cwd: string;
}

/**
 * Build a human-readable diagnostic string that is emitted when the
 * first-event timeout fires.  Pure function – no side effects.
 */
export function buildFirstEventHangDiagnostics(input: FirstEventHangDiagnosticsInput): string {
  const lines: string[] = [
    '--- First-Event Timeout Diagnostics ---',
    `Timestamp  : ${new Date().toISOString()}`,
    `Provider   : ${input.providerName}`,
    `Model      : ${input.model}`,
    `CWD        : ${input.cwd}`,
    `Timeout    : ${input.timeoutMs}ms`,
    `Context    : ${input.context}`,
    '',
    'Possible causes:',
    '  1. The hermes acp process may not be running or has crashed.',
    '     Check with: ps aux | grep hermes',
    '  2. state.db may be very large, slowing down initial reads.',
    '     Check with: ls -lh ~/.hermes/state.db',
    '  3. A ConcurrencyLock may be blocking this request.',
    '     Check for other active hermes sessions.',
    '  4. The provider endpoint may be unreachable or rate-limited.',
    '     Check network connectivity and provider status.',
    '--- End Diagnostics ---',
  ];
  return lines.join('\n');
}

export async function* withFirstEventTimeout<T>(
  gen: AsyncGenerator<T>,
  timeoutMs: number,
  context: string
): AsyncGenerator<T> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new Error(`Hermes subprocess produced no output within ${timeoutMs}ms (${context})`));
    }, timeoutMs);
  });

  let first = true;
  while (true) {
    let result;
    try {
      result = first ? await Promise.race([gen.next(), timer]) : await gen.next();
    } finally {
      if (first && timerHandle !== undefined) {
        clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    }

    if (result.done) return;
    first = false;
    yield result.value;
  }
}
