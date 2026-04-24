import { describe, expect, test } from 'bun:test';

import { parseHermesConfig } from './config';

describe('parseHermesConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseHermesConfig({})).toEqual({});
  });

  test('parses valid model string', () => {
    expect(parseHermesConfig({ model: 'qwen2.5-coder:32b' })).toEqual({
      model: 'qwen2.5-coder:32b',
    });
  });

  test('parses valid provider string', () => {
    expect(parseHermesConfig({ provider: 'ollama' })).toEqual({
      provider: 'ollama',
    });
  });

  test('parses valid endpoint URL', () => {
    expect(parseHermesConfig({ endpoint: 'http://localhost:11434/v1' })).toEqual({
      endpoint: 'http://localhost:11434/v1',
    });
  });

  test('drops invalid endpoint URL silently (not a URL)', () => {
    expect(parseHermesConfig({ endpoint: 'not-a-url' })).toEqual({});
  });

  test('drops malformed endpoint URL silently', () => {
    expect(parseHermesConfig({ endpoint: 'http://[bad' })).toEqual({});
  });

  test('parses valid globalAuth boolean', () => {
    expect(parseHermesConfig({ globalAuth: true })).toEqual({
      globalAuth: true,
    });
    expect(parseHermesConfig({ globalAuth: false })).toEqual({
      globalAuth: false,
    });
  });

  test('parses valid hermesBinaryPath', () => {
    expect(parseHermesConfig({ hermesBinaryPath: '/usr/local/bin/hermes' })).toEqual({
      hermesBinaryPath: '/usr/local/bin/hermes',
    });
  });

  test('mixed valid and invalid fields — valid kept, invalid dropped', () => {
    expect(
      parseHermesConfig({
        model: 'qwen2.5-coder:32b',
        provider: 'ollama',
        endpoint: 'not-a-url',
        globalAuth: true,
      })
    ).toEqual({
      model: 'qwen2.5-coder:32b',
      provider: 'ollama',
      globalAuth: true,
    });
  });

  test('unknown fields are dropped (HermesProviderDefaults has no index signature)', () => {
    expect(
      parseHermesConfig({
        model: 'llama3.1',
        unknownField: 'should-be-dropped',
        anotherUnknown: 42,
      })
    ).toEqual({
      model: 'llama3.1',
    });
  });

  test('does not throw on null/undefined input values', () => {
    expect(() => parseHermesConfig({ model: null })).not.toThrow();
    expect(() => parseHermesConfig({ model: undefined })).not.toThrow();
    expect(() => parseHermesConfig({ provider: null })).not.toThrow();
    expect(() => parseHermesConfig({ endpoint: null })).not.toThrow();
    expect(() => parseHermesConfig({ globalAuth: null })).not.toThrow();
    expect(() => parseHermesConfig({ hermesBinaryPath: null })).not.toThrow();
  });

  test('drops non-string model silently', () => {
    expect(parseHermesConfig({ model: 123 })).toEqual({});
    expect(parseHermesConfig({ model: true })).toEqual({});
    expect(parseHermesConfig({ model: {} })).toEqual({});
  });

  test('drops non-string provider silently', () => {
    expect(parseHermesConfig({ provider: 123 })).toEqual({});
    expect(parseHermesConfig({ provider: ['ollama'] })).toEqual({});
  });

  test('drops non-boolean globalAuth silently', () => {
    expect(parseHermesConfig({ globalAuth: 'yes' })).toEqual({});
    expect(parseHermesConfig({ globalAuth: 1 })).toEqual({});
    expect(parseHermesConfig({ globalAuth: {} })).toEqual({});
  });

  test('drops non-string hermesBinaryPath silently', () => {
    expect(parseHermesConfig({ hermesBinaryPath: 42 })).toEqual({});
    expect(parseHermesConfig({ hermesBinaryPath: true })).toEqual({});
  });

  test('parses HTTPS endpoint URL', () => {
    expect(parseHermesConfig({ endpoint: 'https://api.example.com/v1' })).toEqual({
      endpoint: 'https://api.example.com/v1',
    });
  });

  test('parses all valid fields together', () => {
    const result = parseHermesConfig({
      model: 'qwen2.5-coder:32b',
      provider: 'ollama',
      endpoint: 'http://localhost:11434/v1',
      globalAuth: false,
      hermesBinaryPath: '/opt/hermes/bin/hermes',
    });
    expect(result).toEqual({
      model: 'qwen2.5-coder:32b',
      provider: 'ollama',
      endpoint: 'http://localhost:11434/v1',
      globalAuth: false,
      hermesBinaryPath: '/opt/hermes/bin/hermes',
    });
  });
});
