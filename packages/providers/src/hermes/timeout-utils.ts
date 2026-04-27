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
    const result = first ? await Promise.race([gen.next(), timer]) : await gen.next();

    if (first && timerHandle !== undefined) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }

    if (result.done) return;
    first = false;
    yield result.value;
  }
}
