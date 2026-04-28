import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { MessageChunk } from '../types';
import { bridgeHermesSession, type AcpMcpServer } from './event-bridge';

// ─── Configuration types ──────────────────────────────────────────────

/** Spawn configuration for the Hermes ACP child process. */
export interface HermesAcpClientConfig {
  /** Path to the hermes binary. */
  binary: string;
  /** Arguments to pass (defaults to ['acp']). */
  args?: string[];
  /** Extra environment variables (merged with process.env). */
  env?: Record<string, string>;
  /** Working directory for the child process (must be absolute). */
  cwd: string;
}

/** Options for init() and prompt() calls. */
export interface HermesAcpClientPromptOptions {
  systemPrompt?: string;
  mcpServers?: AcpMcpServer[];
  abortSignal?: AbortSignal;
}

// ─── HermesAcpClient ──────────────────────────────────────────────────

/**
 * Encapsulates child process spawn + ACP protocol + handler lifecycle
 * into a single class.
 *
 * Usage:
 *   const client = new HermesAcpClient({ binary: 'hermes', cwd: '/tmp' });
 *   for await (const chunk of client.init('Hello')) { ... }
 *   for await (const chunk of client.prompt('Follow up')) { ... }
 *   client.dispose();
 *
 * The class wraps `bridgeHermesSession()` and manages the child process
 * lifecycle. `init()` runs the full ACP handshake (initialize → session/new
 * → session/prompt) and captures the sessionId. Subsequent `prompt()` calls
 * reuse the session via skipInit mode.
 */
export class HermesAcpClient {
  private _childProcess: ChildProcess;
  private _sessionId: string | undefined;
  private _activeBridge: AsyncGenerator<MessageChunk> | undefined;
  private _disposed = false;

  constructor(private config: HermesAcpClientConfig) {
    this._childProcess = spawn(config.binary, config.args ?? ['acp'], {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  // ── Getters ─────────────────────────────────────────────────────────

  /** Backward-compatible access to the underlying child process. */
  get childProcess(): ChildProcess {
    return this._childProcess;
  }

  /** Returns the captured session ID after init(), or undefined. */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  // ── Lifecycle methods ───────────────────────────────────────────────

  /**
   * Check if the child process is still running.
   * Returns false if the process has been killed or has exited.
   */
  isAlive(): boolean {
    return !this._childProcess.killed && this._childProcess.exitCode === null;
  }

  /**
   * Run full ACP handshake (initialize + session/new + first prompt).
   *
   * Creates a bridge with `keepAlive: true` so the child process survives
   * after the generator completes. Captures the sessionId from the terminal
   * result chunk for use by subsequent `prompt()` calls.
   */
  async *init(
    prompt: string,
    options?: HermesAcpClientPromptOptions
  ): AsyncGenerator<MessageChunk> {
    if (this._disposed) {
      throw new Error('HermesAcpClient has been disposed');
    }

    const bridge = bridgeHermesSession(
      this._childProcess,
      {
        prompt,
        cwd: this.config.cwd,
        systemPrompt: options?.systemPrompt,
        mcpServers: options?.mcpServers,
        keepAlive: true,
      },
      options?.abortSignal
    );

    this._activeBridge = bridge;

    try {
      for await (const chunk of bridge) {
        // Capture sessionId from the terminal result chunk.
        if (chunk.type === 'result' && chunk.sessionId) {
          this._sessionId = chunk.sessionId;
        }
        yield chunk;
      }
    } finally {
      this._activeBridge = undefined;
    }
  }

  /**
   * Send a prompt on an existing session (skipInit mode).
   *
   * Requires `init()` to have been called first to establish the session.
   * Creates a new bridge with `skipInit: true` and `keepAlive: true`,
   * reusing the same child process.
   */
  async *prompt(
    prompt: string,
    options?: HermesAcpClientPromptOptions
  ): AsyncGenerator<MessageChunk> {
    if (this._disposed) {
      throw new Error('HermesAcpClient has been disposed');
    }
    if (!this._sessionId) {
      throw new Error('No active session. Call init() first.');
    }

    const bridge = bridgeHermesSession(
      this._childProcess,
      {
        prompt,
        cwd: this.config.cwd,
        systemPrompt: options?.systemPrompt,
        mcpServers: options?.mcpServers,
        skipInit: true,
        existingSessionId: this._sessionId,
        keepAlive: true,
      },
      options?.abortSignal
    );

    this._activeBridge = bridge;

    try {
      for await (const chunk of bridge) {
        yield chunk;
      }
    } finally {
      this._activeBridge = undefined;
    }
  }

  /**
   * Kill the child process and clean up all handlers.
   *
   * If a bridge generator is active, signals it to return (triggering
   * handler cleanup in the bridge's finally block), then kills the
   * child process with SIGKILL.
   *
   * Idempotent — calling multiple times is safe (subsequent calls are no-ops).
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Signal active bridge to clean up handlers
    if (this._activeBridge) {
      void this._activeBridge.return(undefined);
      this._activeBridge = undefined;
    }

    // Kill the child process
    try {
      this._childProcess.kill('SIGKILL');
    } catch {
      // Process may already be dead (ESRCH) or we lack permissions (EPERM)
    }
  }
}
