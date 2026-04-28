import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { HermesSessionPool, type PooledSession, type SessionPoolConfig } from './session-pool';
import type { ChildProcess } from 'node:child_process';

function mockChildProcess(): ChildProcess {
  return {
    kill: mock(() => true),
    unref: mock(() => {}),
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

  test('delete for non-existent key is a no-op', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(() => pool.delete('/nonexistent', 'model')).not.toThrow();
    expect(pool.size).toBe(0);
  });

  test('set overwrites existing session and kills old process', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const cp1 = mockChildProcess();
    const cp2 = mockChildProcess();
    pool.set('/tmp', 'model', makeSession({ childProcess: cp1 }));
    pool.set('/tmp', 'model', makeSession({ childProcess: cp2 }));
    expect(pool.size).toBe(1);
    // Old process should have been killed
    expect(cp1.kill).toHaveBeenCalledWith('SIGKILL');
    pool.delete('/tmp', 'model');
    expect(cp2.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('cleanup timer kills only idle sessions, not recently-used ones', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 100,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 50,
    });
    const cpIdle = mockChildProcess();
    const cpActive = mockChildProcess();
    pool.set('/dir1', 'm1', makeSession({ childProcess: cpIdle }));
    pool.set('/dir2', 'm2', makeSession({ childProcess: cpActive }));

    // Keep cpActive active
    const interval = setInterval(() => {
      pool.get('/dir2', 'm2');
    }, 30);
    await new Promise(r => setTimeout(r, 200));
    clearInterval(interval);

    expect(cpIdle.kill).toHaveBeenCalled();
    expect(cpActive.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
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

  test('provider parameter isolates sessions with same cwd and model', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const cp1 = mockChildProcess();
    const cp2 = mockChildProcess();
    const session1 = makeSession({ childProcess: cp1, sessionId: 'session-openai' });
    const session2 = makeSession({ childProcess: cp2, sessionId: 'session-anthropic' });

    pool.set('/tmp', 'gpt-4', session1, 'openai');
    pool.set('/tmp', 'gpt-4', session2, 'anthropic');

    expect(pool.size).toBe(2);

    const got1 = pool.get('/tmp', 'gpt-4', 'openai');
    const got2 = pool.get('/tmp', 'gpt-4', 'anthropic');

    expect(got1).toBe(session1);
    expect(got1!.sessionId).toBe('session-openai');
    expect(got2).toBe(session2);
    expect(got2!.sessionId).toBe('session-anthropic');
  });

  test('get with provider does not return session set without provider', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    expect(pool.get('/tmp', 'model')).toBe(session);
    expect(pool.get('/tmp', 'model', 'hermes')).toBeUndefined();
  });

  test("delete with provider only removes that provider's session", () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const cp1 = mockChildProcess();
    const cp2 = mockChildProcess();
    pool.set('/tmp', 'model', makeSession({ childProcess: cp1 }), 'openai');
    pool.set('/tmp', 'model', makeSession({ childProcess: cp2 }), 'anthropic');

    pool.delete('/tmp', 'model', 'openai');

    expect(cp1.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cp2.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
    expect(pool.get('/tmp', 'model', 'anthropic')).toBeDefined();
    expect(pool.get('/tmp', 'model', 'openai')).toBeUndefined();
  });

  test('undefined provider and empty-string provider produce same key', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    expect(pool.get('/tmp', 'model')).toBe(session);
    expect(pool.get('/tmp', 'model', undefined)).toBe(session);
    expect(pool.get('/tmp', 'model', '')).toBe(session);
  });
});
