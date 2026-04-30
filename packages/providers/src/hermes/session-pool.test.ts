import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { HermesSessionPool, type PooledSession, type SessionPoolConfig } from './session-pool';
import type { HermesAcpClient } from './acp-client';

function mockHermesAcpClient(): HermesAcpClient {
  return {
    dispose: mock(() => {}),
    isAlive: mock(() => true),
    childProcess: {
      unref: mock(() => {}),
      kill: mock(() => true),
    },
  } as unknown as HermesAcpClient;
}

function makeSession(overrides?: Partial<PooledSession>): PooledSession {
  return {
    client: mockHermesAcpClient(),
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

  test('set + get returns the session and does not update lastUsed', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession({ lastUsed: 1000 });
    pool.set('/tmp', 'model', session);

    const result = pool.get('/tmp', 'model');
    expect(result).toBe(session);
    // get() no longer updates lastUsed — only acquire() does
    expect(result!.lastUsed).toBe(1000);
  });

  test('delete kills the process and removes from pool', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const client = mockHermesAcpClient();
    const session = makeSession({ client });
    pool.set('/tmp', 'model', session);

    pool.delete('/tmp', 'model');

    expect(client.dispose).toHaveBeenCalled();
    expect(pool.get('/tmp', 'model')).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  test('cleanup removes idle sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 50,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 600_000, // don't auto-trigger, we'll call cleanup manually
    });
    const client = mockHermesAcpClient();
    const session = makeSession({ client });
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
    const client2 = mockHermesAcpClient();
    const session2 = makeSession({ client: client2 });
    pool.set('/tmp', 'model', session2);

    await new Promise(r => setTimeout(r, 100));

    expect(client2.dispose).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  test('cleanup removes old sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 600_000,
      maxAgeMs: 50,
      cleanupIntervalMs: 20,
    });
    const client = mockHermesAcpClient();
    const session = makeSession({ client });
    pool.set('/tmp', 'model', session);

    await new Promise(r => setTimeout(r, 100));

    expect(client.dispose).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  test('destroy kills all sessions and clears the pool', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const client1 = mockHermesAcpClient();
    const client2 = mockHermesAcpClient();
    pool.set('/dir1', 'm1', makeSession({ client: client1 }));
    pool.set('/dir2', 'm2', makeSession({ client: client2 }));

    pool.destroy();

    expect(client1.dispose).toHaveBeenCalled();
    expect(client2.dispose).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  test('delete for non-existent key is a no-op', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(() => pool.delete('/nonexistent', 'model')).not.toThrow();
    expect(pool.size).toBe(0);
  });

  test('set overwrites existing session and kills old process', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const client1 = mockHermesAcpClient();
    const client2 = mockHermesAcpClient();
    pool.set('/tmp', 'model', makeSession({ client: client1 }));
    pool.set('/tmp', 'model', makeSession({ client: client2 }));
    expect(pool.size).toBe(1);
    // Old process should have been killed via dispose
    expect(client1.dispose).toHaveBeenCalled();
    pool.delete('/tmp', 'model');
    expect(client2.dispose).toHaveBeenCalled();
  });

  test('cleanup timer kills only idle sessions, not recently-used ones', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 100,
      maxAgeMs: 600_000,
      cleanupIntervalMs: 50,
    });
    const clientIdle = mockHermesAcpClient();
    const clientActive = mockHermesAcpClient();
    pool.set('/dir1', 'm1', makeSession({ client: clientIdle }));
    pool.set('/dir2', 'm2', makeSession({ client: clientActive }));

    // Keep clientActive active via acquire/release (get() no longer resets lastUsed)
    const interval = setInterval(() => {
      const s = pool.acquire('/dir2', 'm2');
      if (s) pool.release('/dir2', 'm2');
    }, 30);
    await new Promise(r => setTimeout(r, 200));
    clearInterval(interval);

    expect(clientIdle.dispose).toHaveBeenCalled();
    expect(clientActive.dispose).not.toHaveBeenCalled();
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
    const client1 = mockHermesAcpClient();
    const client2 = mockHermesAcpClient();
    const session1 = makeSession({ client: client1, sessionId: 'session-openai' });
    const session2 = makeSession({ client: client2, sessionId: 'session-anthropic' });

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
    const client1 = mockHermesAcpClient();
    const client2 = mockHermesAcpClient();
    pool.set('/tmp', 'model', makeSession({ client: client1 }), 'openai');
    pool.set('/tmp', 'model', makeSession({ client: client2 }), 'anthropic');

    pool.delete('/tmp', 'model', 'openai');

    expect(client1.dispose).toHaveBeenCalled();
    expect(client2.dispose).not.toHaveBeenCalled();
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

  // ── acquire/release semantics ───────────────────────────────────────────

  test('acquire returns session and marks inUse', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    const acquired = pool.acquire('/tmp', 'model');
    expect(acquired).toBe(session);
    expect(acquired!.inUse).toBe(true);
  });

  test('acquire returns undefined when session is already inUse', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    const first = pool.acquire('/tmp', 'model');
    expect(first).toBe(session);

    const second = pool.acquire('/tmp', 'model');
    expect(second).toBeUndefined();
  });

  test('release clears inUse flag and allows re-acquire', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    pool.acquire('/tmp', 'model');
    pool.release('/tmp', 'model');

    expect(session.inUse).toBe(false);

    const reacquired = pool.acquire('/tmp', 'model');
    expect(reacquired).toBe(session);
    expect(reacquired!.inUse).toBe(true);
  });

  test('release for non-existent key is a no-op', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    expect(() => pool.release('/nonexistent', 'model')).not.toThrow();
  });

  test('cleanup does not evict inUse sessions', async () => {
    pool = new HermesSessionPool({
      idleTimeoutMs: 50,
      maxAgeMs: 50,
      cleanupIntervalMs: 20,
    });
    const client = mockHermesAcpClient();
    const session = makeSession({ client });
    pool.set('/tmp', 'model', session);

    // Acquire so it's marked inUse
    pool.acquire('/tmp', 'model');

    // Wait past both idle and age timeouts
    await new Promise(r => setTimeout(r, 150));

    // Session should NOT have been killed — it's inUse
    expect(client.dispose).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });

  test('get() still returns inUse sessions (read-only access)', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    pool.set('/tmp', 'model', session);

    pool.acquire('/tmp', 'model');

    // get() is read-only — should still return the inUse session
    const result = pool.get('/tmp', 'model');
    expect(result).toBe(session);
  });

  test('set() initializes session.inUse to false', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession();
    // Manually set inUse to true to verify set() resets it
    (session as any).inUse = true;

    pool.set('/tmp', 'model', session);

    expect(session.inUse).toBe(false);
  });

  // ── Regression: Dead session eviction on acquire ──────────────────────
  // Verifier finding #11: pool.acquire() checks inUse but never
  // client.isAlive(). Dead sessions are handed out with inUse=true,
  // then the provider has to detect and evict them. Fix: add isAlive()
  // check inside acquire() that kills + removes dead sessions.

  test('acquire returns undefined for dead session (isAlive=false) and evicts it', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const client = mockHermesAcpClient();
    // Mock isAlive to return false (dead process)
    (client.isAlive as any).mockReturnValue(false);
    const session = makeSession({ client });
    pool.set('/tmp', 'model', session);

    expect(pool.size).toBe(1);

    const acquired = pool.acquire('/tmp', 'model');
    // Dead session should NOT be handed out
    expect(acquired).toBeUndefined();
    // Dead session should have been evicted from the pool
    expect(pool.size).toBe(0);
    // Dead session's client should have been disposed
    expect(client.dispose).toHaveBeenCalled();
  });

  // ── Regression: Dead session eviction on release ──────────────────────
  // Verifier finding #12: pool.release() sets inUse=false unconditionally
  // on dead sessions, "resurrecting zombies" that can be re-acquired.
  // Fix: add isAlive() check inside release() that kills + removes dead
  // sessions instead of setting inUse=false.

  test('release on dead session removes from pool instead of resurrecting zombie', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const client = mockHermesAcpClient();
    const session = makeSession({ client });
    pool.set('/tmp', 'model', session);

    // Acquire the session (marks inUse=true)
    const acquired = pool.acquire('/tmp', 'model');
    expect(acquired).toBe(session);
    expect(acquired!.inUse).toBe(true);

    // Process dies while in use
    (client.isAlive as any).mockReturnValue(false);

    // Release the dead session
    pool.release('/tmp', 'model');

    // The session should be evicted (not resurrected with inUse=false)
    expect(pool.size).toBe(0);
    expect(client.dispose).toHaveBeenCalled();

    // Trying to acquire again should fail (session removed)
    const reacquired = pool.acquire('/tmp', 'model');
    expect(reacquired).toBeUndefined();
  });

  // ── Regression: Idle timer accuracy ───────────────────────────────────
  // Verifier finding #13: get() updates lastUsed on every read, which
  // prevents the idle cleanup timer from ever expiring for sessions that
  // are only read (not actually used). Fix: get() should be read-only
  // and not reset lastUsed. Only acquire() should update lastUsed.

  test('get() does not reset lastUsed — only acquire() does', () => {
    pool = new HermesSessionPool({ cleanupIntervalMs: 600_000 });
    const session = makeSession({ lastUsed: 1000 });
    pool.set('/tmp', 'model', session);

    // Read the session via get()
    const result = pool.get('/tmp', 'model');
    expect(result).toBe(session);

    // lastUsed should NOT be updated by get() — it stays at the original value
    expect(result!.lastUsed).toBe(1000);

    // acquire() SHOULD update lastUsed
    const acquired = pool.acquire('/tmp', 'model');
    expect(acquired).toBe(session);
    expect(acquired!.lastUsed).toBeGreaterThan(1000);
  });
});
