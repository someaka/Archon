import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { ConcurrencyLock } from './concurrency-lock';

describe('ConcurrencyLock', () => {
  const originalEnv = process.env.ARCHON_HERMES_MAX_CONCURRENCY;

  beforeEach(() => {
    delete process.env.ARCHON_HERMES_MAX_CONCURRENCY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARCHON_HERMES_MAX_CONCURRENCY;
    } else {
      process.env.ARCHON_HERMES_MAX_CONCURRENCY = originalEnv;
    }
  });

  it('serializes concurrent acquire calls (explicit maxConcurrency=1)', async () => {
    const lock = new ConcurrencyLock({ maxConcurrency: 1 });
    const order: number[] = [];

    const p1 = lock.acquire().then(() => {
      order.push(1);
      return new Promise<void>(r =>
        setTimeout(() => {
          lock.release();
          r();
        }, 30)
      );
    });

    const p2 = lock.acquire().then(() => {
      order.push(2);
      lock.release();
    });

    const p3 = lock.acquire().then(() => {
      order.push(3);
      lock.release();
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('respects maxConcurrency from constructor', async () => {
    const lock = new ConcurrencyLock({ maxConcurrency: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = async (id: number) => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      lock.release();
    };

    await Promise.all([run(1), run(2), run(3), run(4)]);
    expect(maxConcurrent).toBe(2);
  });

  it('respects ARCHON_HERMES_MAX_CONCURRENCY env var', async () => {
    process.env.ARCHON_HERMES_MAX_CONCURRENCY = '3';
    const lock = new ConcurrencyLock();
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = async () => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      lock.release();
    };

    await Promise.all([run(), run(), run(), run(), run()]);
    expect(maxConcurrent).toBe(3);
  });

  it('ignores invalid ARCHON_HERMES_MAX_CONCURRENCY env var and defaults to 3', async () => {
    process.env.ARCHON_HERMES_MAX_CONCURRENCY = 'notanumber';
    const lock = new ConcurrencyLock();
    // Invalid env falls back to default (3), so 3 concurrent acquires succeed
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = async () => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      lock.release();
    };
    await Promise.all([run(), run(), run(), run()]);
    expect(maxConcurrent).toBe(3);
  });

  it('constructor config takes precedence over env var', async () => {
    process.env.ARCHON_HERMES_MAX_CONCURRENCY = '5';
    const lock = new ConcurrencyLock({ maxConcurrency: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const run = async () => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      lock.release();
    };

    await Promise.all([run(), run(), run(), run()]);
    expect(maxConcurrent).toBe(2);
  });

  it('release underflow guard does not throw', () => {
    const lock = new ConcurrencyLock();
    expect(() => lock.release()).not.toThrow();
    expect(() => lock.release()).not.toThrow();
    expect(lock.active).toBe(0);
  });

  it('active and pending getters work correctly', async () => {
    const lock = new ConcurrencyLock();
    expect(lock.active).toBe(0);
    expect(lock.pending).toBe(0);

    await lock.acquire();
    expect(lock.active).toBe(1);
    expect(lock.pending).toBe(0);

    // Default concurrency is 3, so 3 acquires succeed immediately
    const p2 = lock.acquire();
    expect(lock.active).toBe(2);
    expect(lock.pending).toBe(0);

    const p3 = lock.acquire();
    expect(lock.active).toBe(3);
    expect(lock.pending).toBe(0);

    // Fourth acquire should queue
    const p4 = lock.acquire();
    expect(lock.active).toBe(3);
    expect(lock.pending).toBe(1);

    lock.release();
    await new Promise(r => setTimeout(r, 0));
    expect(lock.active).toBe(3);
    expect(lock.pending).toBe(0);

    lock.release();
    await new Promise(r => setTimeout(r, 0));
    expect(lock.active).toBe(2);
    expect(lock.pending).toBe(0);

    lock.release();
    lock.release(); // extra release for p4
    expect(lock.active).toBe(0);
    expect(lock.pending).toBe(0);

    // Ensure promises resolved
    await p2;
    await p3;
    await p4;
  });

  it('queued acquires resolve in FIFO order (maxConcurrency=1)', async () => {
    const lock = new ConcurrencyLock({ maxConcurrency: 1 });
    const order: number[] = [];

    // Acquire the lock first
    await lock.acquire();

    // Queue up several acquires
    const p2 = lock.acquire().then(() => {
      order.push(2);
    });
    const p3 = lock.acquire().then(() => {
      order.push(3);
    });
    const p4 = lock.acquire().then(() => {
      order.push(4);
    });

    // Release in sequence - each release should wake up the next waiter
    lock.release();
    await new Promise(r => setTimeout(r, 0));
    lock.release();
    await new Promise(r => setTimeout(r, 0));
    lock.release();
    await new Promise(r => setTimeout(r, 0));

    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  it('constructors with negative maxConcurrency falls back to env or default (3)', () => {
    process.env.ARCHON_HERMES_MAX_CONCURRENCY = '-2';
    const lock = new ConcurrencyLock();
    // -2 is finite but not > 0, so it falls back to default (3)
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = async () => {
      await lock.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      lock.release();
    };
    return Promise.all([run(), run(), run(), run()]).then(() => {
      expect(maxConcurrent).toBe(3);
    });
  });
});
