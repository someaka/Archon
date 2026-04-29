/**
 * Async semaphore that serializes concurrent operations.
 * Used to prevent multiple hermes acp processes from contending on the same API.
 * Default maxConcurrency=3. Tunable via ARCHON_HERMES_MAX_CONCURRENCY env var.
 */
export class ConcurrencyLock {
  private currentCount = 0;
  private readonly maxConcurrency: number;
  private readonly waitQueue: (() => void)[] = [];

  constructor(config?: { maxConcurrency?: number }) {
    const envVal = process.env.ARCHON_HERMES_MAX_CONCURRENCY;
    const parsed = envVal ? Number(envVal) : undefined;
    const MAX_ALLOWED = 32;
    const envMax =
      typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_ALLOWED
        ? parsed
        : undefined;
    this.maxConcurrency = config?.maxConcurrency ?? envMax ?? 3;
  }

  async acquire(): Promise<void> {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return;
    }
    return new Promise<void>(resolve => {
      this.waitQueue.push(() => {
        this.currentCount++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.currentCount <= 0) return; // underflow guard
    this.currentCount--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  get active(): number {
    return this.currentCount;
  }
  get pending(): number {
    return this.waitQueue.length;
  }
}
