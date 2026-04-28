/**
 * Async semaphore that serializes concurrent operations.
 * Used to prevent multiple hermes acp processes from contending on state.db.
 * Default maxConcurrency=1 (fully serialized). Tunable via ARCHON_HERMES_MAX_CONCURRENCY env var.
 */
export class ConcurrencyLock {
  private currentCount = 0;
  private readonly maxConcurrency: number;
  private readonly waitQueue: (() => void)[] = [];

  constructor(config?: { maxConcurrency?: number }) {
    const envVal = process.env.ARCHON_HERMES_MAX_CONCURRENCY;
    const parsed = envVal ? Number(envVal) : undefined;
    const envMax =
      typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    this.maxConcurrency = config?.maxConcurrency ?? envMax ?? 1;
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
