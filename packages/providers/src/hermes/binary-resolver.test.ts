/**
 * Tests for the Hermes binary resolver.
 *
 * Uses dynamic imports with cache-busting query parameters so that a single
 * test file can verify both dev mode (BUNDLED_IS_BINARY=false) and binary
 * mode (BUNDLED_IS_BINARY=true). Each dynamic import re-evaluates the module
 * against the current mock.module() factory.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';

let importCounter = 0;

async function importResolver(bundledIsBinary: boolean) {
  mock.module('@archon/paths', () => ({
    BUNDLED_IS_BINARY: bundledIsBinary,
    createLogger: () => ({ info: () => {}, debug: () => {}, error: () => {} }),
  }));
  const mod = await import(`./binary-resolver?t=${importCounter++}`);
  return mod as typeof import('./binary-resolver');
}

describe('resolveHermesBinary', () => {
  const originalEnv = process.env.HERMES_BINARY_PATH;

  beforeEach(() => {
    delete process.env.HERMES_BINARY_PATH;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.HERMES_BINARY_PATH = originalEnv;
    } else {
      delete process.env.HERMES_BINARY_PATH;
    }
  });

  test('returns undefined in dev mode (BUNDLED_IS_BINARY=false)', async () => {
    const resolver = await importResolver(false);
    const result = await resolver.resolveHermesBinary();
    expect(result).toBeUndefined();
  });

  test('resolves from HERMES_BINARY_PATH env var when file exists', async () => {
    const resolver = await importResolver(true);
    process.env.HERMES_BINARY_PATH = '/usr/local/bin/hermes';
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveHermesBinary();
    expect(result).toBe('/usr/local/bin/hermes');
    spy.mockRestore();
  });

  test('resolves from config hermesBinaryPath when file exists', async () => {
    const resolver = await importResolver(true);
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveHermesBinary('/custom/hermes');
    expect(result).toBe('/custom/hermes');
    spy.mockRestore();
  });

  test('autodetects ~/.local/bin/hermes when it exists', async () => {
    const resolver = await importResolver(true);
    const spy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      return path.includes('.local/bin/hermes');
    });

    const result = await resolver.resolveHermesBinary();
    expect(result).toContain('.local/bin/hermes');
    spy.mockRestore();
  });

  test('throws when env path does not exist (binary mode)', async () => {
    const resolver = await importResolver(true);
    process.env.HERMES_BINARY_PATH = '/nonexistent/hermes';
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveHermesBinary()).rejects.toThrow('HERMES_BINARY_PATH');
    spy.mockRestore();
  });

  test('throws when config path does not exist (binary mode)', async () => {
    const resolver = await importResolver(true);
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveHermesBinary('/nonexistent/hermes')).rejects.toThrow(
      'hermesBinaryPath'
    );
    spy.mockRestore();
  });

  test('env var takes precedence over config path', async () => {
    const resolver = await importResolver(true);
    process.env.HERMES_BINARY_PATH = '/env/hermes';
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveHermesBinary('/config/hermes');
    expect(result).toBe('/env/hermes');
    spy.mockRestore();
  });

  test('returns undefined when nothing configured in binary mode', async () => {
    const resolver = await importResolver(true);
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    const result = await resolver.resolveHermesBinary();
    expect(result).toBeUndefined();
    spy.mockRestore();
  });
});
