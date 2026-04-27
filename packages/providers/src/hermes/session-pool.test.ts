import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { HermesSessionPool, type PooledSession, type SessionPoolConfig } from './session-pool';
import type { ChildProcess } from 'node:child_process';

function mockChildProcess(): ChildProcess {
  return {
    kill: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

function makeSession(overrides?: Partial<PooledSession>): PooledSession {
  return {
    childProcess: mockChildProcess(),
    sessionId: 'test-session-1',
    cwd: '/tmp',
    model: 'test-model',
    createdAt: Date.now(),
    lastUsed: Date.now(),
    ...overrides,
  };
}

describe('HermesSessionPool', () => {
  let pool: HermesSessionPool;

  afterEach(() => {
    pool?.destroy();
  });

  test('get returns undefined for missing key', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(pool.get('/nonexistent', 'model')).toBeUndefined();
  });

  test('set + get returns the session and updates lastUsed', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession({ lastUsed: 1000 });
    pool.set('/tmp', 'model', session);

    const result = pool.get('/tmp', 'model');
    expect(result).toBe(session);
    expect(result!.lastUsed).toBeGreaterThan(1000);
  });

  test('delete kills the process and removes from pool', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const cp = mockChildProcess();
    const session = makeSession({ childProcess: cp });
    pool.set('/tmp', 'model', session);

    pool.delete('/tmp', 'model');

    expect(cp.kill).toHaveBeenCalledWith('SIGKILL');
    expect(pool.get('/tmp', 'model')).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  test('cleanup removes idle sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 50,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 600_000, // don't auto-trigger, we'll call cleanup manually
    });
    const cp = mockChildProcess();
    const session = makeSession({ childProcess: cp });
    pool.set('/tmp', 'model', session);

    // Wait for idle timeout to elapse
    await new Promise(r => setTimeout(r, 100));

    // Trigger cleanup via a new pool with short interval — instead, use the internal cleanup
    // We can't call private cleanup directly, so we create a pool with a very short interval
    pool.destroy();
    pool = new HermesSessionPool({
      idleTimeoutMs: 50,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 20,
    });
    const cp2 = mockChildProcess();
    const session2 = makeSession({ childProcess: cp2 });
    pool.set('/tmp', 'model', session2);

    await new Promise(r => setTimeout(r, 100));

    expect(cp2.kill).toHaveBeenCalledWith('SIGKILL');
    expect(pool.size).toBe(0);
  });

  test('cleanup removes old sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 600_000,
      maxAgeMs: 50,
      cleanupIntervalMs: 20,
    });
    const cp = mockChildProcess();
    const session = makeSession({ childProcess: cp });
    pool.set('/tmp', 'model', session);

    await new Promise(r => setTimeout(r, 100));

    expect(cp.kill).toHaveBeenCalledWith('SIGKILL');
    expect(pool.size).toBe(0);
  });

  test('destroy kills all sessions and clears the pool', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const cp1 = mockChildProcess();
    const cp2 = mockChildProcess();
    pool.set('/dir1', 'm1', makeSession({ childProcess: cp1 }));
    pool.set('/dir2', 'm2', makeSession({ childProcess: cp2 }));

    pool.destroy();

    expect(cp1.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cp2.kill).toHaveBeenCalledWith('SIGKILL');
    expect(pool.size).toBe(0);
  });

  test('size returns correct count', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(pool.size).toBe(0);

    pool.set('/dir1', 'm1', makeSession());
    expect(pool.size).toBe(1);

    pool.set('/dir2', 'm2', makeSession());
    expect(pool.size).toBe(2);

    pool.delete('/dir1', 'm1');
    expect(pool.size).toBe(1);
  });
});
