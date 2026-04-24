import { describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { tmpdir } from 'os';

function waitForOutput(
  proc: ReturnType<typeof spawn>,
  searchString: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');
      proc.removeAllListeners('exit');
    };

    const timer = setTimeout(() => {
      if (!settled) {
        cleanup();
        proc.kill();
        reject(new Error(`Timed out waiting for "${searchString}". Output: ${output}`));
      }
    }, timeoutMs);

    const onData = (data: Buffer): void => {
      output += data.toString();
      if (!settled && output.includes(searchString)) {
        cleanup();
        resolve(output);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('exit', code => {
      if (!settled) {
        cleanup();
        if (output.includes(searchString)) {
          resolve(output);
        } else {
          reject(
            new Error(
              `Process exited with code ${code} before finding "${searchString}". Output: ${output}`
            )
          );
        }
      }
    });
  });
}

function getBaseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    WEB_UI_DEV: '1',
    PORT: '39990',
    CLAUDE_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_USE_GLOBAL_AUTH: '',
    CODEX_ID_TOKEN: '',
    CODEX_ACCESS_TOKEN: '',
    HERMES_MODEL: '',
    HERMES_BINARY_PATH: '',
    HERMES_API_KEY: '',
  };
}

function spawnServer(envOverrides: Record<string, string>): ReturnType<typeof spawn> {
  const serverPath = resolve(import.meta.dir, 'index.ts');
  return spawn('bun', [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpdir(),
    env: { ...getBaseEnv(), ...envOverrides },
  });
}

describe('boot e2e', () => {
  it('starts successfully with HERMES_MODEL as only credential', async () => {
    const proc = spawnServer({ HERMES_MODEL: 'qwen2.5-coder:32b' });
    try {
      const output = await waitForOutput(proc, 'server_listening', 10_000);
      expect(output).not.toContain('no_ai_credentials');
    } finally {
      proc.kill();
    }
  });

  it('fails to start when no AI credentials are configured', async () => {
    const proc = spawnServer({});
    try {
      const output = await waitForOutput(proc, 'no_ai_credentials', 10_000);
      expect(output).toContain('no_ai_credentials');
    } finally {
      proc.kill();
    }
  });
});
