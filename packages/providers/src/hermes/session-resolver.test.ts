import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../test/mocks/logger';

// ─── Mock @archon/paths logger before import ───────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { resolveHermesSession } from './session-resolver';

describe('resolveHermesSession', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.child.mockClear();
  });

  test('basic call with cwd returns context with cwd and env', () => {
    const result = resolveHermesSession({ cwd: '/tmp/project' });
    expect(result.cwd).toBe('/tmp/project');
    expect(result.env).toBeDefined();
    expect(typeof result.env).toBe('object');
    expect(result.sessionId).toBeUndefined();
  });

  test('env vars are merged into process.env', () => {
    const result = resolveHermesSession({
      cwd: '/tmp/project',
      env: { HERMES_API_KEY: 'secret-key', CUSTOM_VAR: 'value' },
    });
    expect(result.env.HERMES_API_KEY).toBe('secret-key');
    expect(result.env.CUSTOM_VAR).toBe('value');
    // process.env entries should still be present
    expect(result.env.PATH).toBeDefined();
  });

  test('provided env overrides process.env', () => {
    const originalPath = process.env.PATH;
    const result = resolveHermesSession({
      cwd: '/tmp/project',
      env: { PATH: '/custom/path' },
    });
    expect(result.env.PATH).toBe('/custom/path');
    // Restore
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
  });

  test('resumeSessionId returns context without throwing', () => {
    // Hermes doesn't support session resume, but it should not throw
    const result = resolveHermesSession({
      cwd: '/tmp/project',
      resumeSessionId: 'some-session-id',
    });
    expect(result.cwd).toBe('/tmp/project');
    expect(result.sessionId).toBeUndefined();
    // A warning may or may not be logged depending on logger state;
    // the key behavior is that the function doesn't throw.
  });

  test('invalid cwd (empty string) falls back to process.cwd()', () => {
    const result = resolveHermesSession({ cwd: '' });
    expect(result.cwd).toBe(process.cwd());
  });

  test('undefined cwd falls back to process.cwd()', () => {
    const result = resolveHermesSession({ cwd: undefined as unknown as string });
    expect(result.cwd).toBe(process.cwd());
  });

  test('session context shape validation', () => {
    const result = resolveHermesSession({
      cwd: '/workspace',
      env: { KEY: 'value' },
    });

    // Should have the expected shape
    expect(result).toHaveProperty('cwd');
    expect(result).toHaveProperty('env');
    expect(typeof result.cwd).toBe('string');
    expect(typeof result.env).toBe('object');
    expect(result.env.KEY).toBe('value');
  });

  test('non-string env values are skipped', () => {
    const result = resolveHermesSession({
      cwd: '/tmp/project',
      env: { GOOD: 'value', BAD: 123 as unknown as string, ALSO_BAD: null as unknown as string },
    });
    expect(result.env.GOOD).toBe('value');
    // Non-string values should not be set
    expect(result.env.BAD).toBeUndefined();
    expect(result.env.ALSO_BAD).toBeUndefined();
  });

  test('empty env object', () => {
    const result = resolveHermesSession({
      cwd: '/tmp/project',
      env: {},
    });
    expect(result.env).toBeDefined();
    expect(result.cwd).toBe('/tmp/project');
  });
});
