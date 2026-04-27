import type { ChildProcess } from 'node:child_process';

export interface PooledSession {
  childProcess: ChildProcess;
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsed: number;
}

export interface SessionPoolConfig {
  idleTimeoutMs: number; // default 5 min (300_000)
  maxAgeMs: number; // default 30 min (1_800_000)
  cleanupIntervalMs: number; // default 1 min (60_000)
}

export class HermesSessionPool {
  private sessions: Map<string, PooledSession> = new Map();
  private config: Required<SessionPoolConfig>;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config?: Partial<SessionPoolConfig>) {
    this.config = {
      idleTimeoutMs: config?.idleTimeoutMs ?? 5 * 60 * 1000,
      maxAgeMs: config?.maxAgeMs ?? 30 * 60 * 1000,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? 60 * 1000,
    };
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
    // Allow process to exit even if timer is running
    this.cleanupTimer.unref();
  }

  private makeKey(cwd: string, model: string): string {
    return `${cwd}\0${model}`;
  }

  get(cwd: string, model: string): PooledSession | undefined {
    const key = this.makeKey(cwd, model);
    const session = this.sessions.get(key);
    if (session) {
      session.lastUsed = Date.now();
    }
    return session;
  }

  set(cwd: string, model: string, session: PooledSession): void {
    const key = this.makeKey(cwd, model);
    // Unref the child process so it doesn't prevent Node from exiting
    session.childProcess.unref();
    this.sessions.set(key, session);
  }

  delete(cwd: string, model: string): void {
    const key = this.makeKey(cwd, model);
    const session = this.sessions.get(key);
    if (session) {
      this.killSession(session);
      this.sessions.delete(key);
    }
  }

  private killSession(session: PooledSession): void {
    try {
      session.childProcess.kill('SIGKILL');
    } catch {
      // Process may already be dead
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      const idleMs = now - session.lastUsed;
      const ageMs = now - session.createdAt;
      if (idleMs > this.config.idleTimeoutMs || ageMs > this.config.maxAgeMs) {
        this.killSession(session);
        this.sessions.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const [, session] of this.sessions) {
      this.killSession(session);
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
