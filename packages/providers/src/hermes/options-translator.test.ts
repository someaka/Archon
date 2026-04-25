import { describe, expect, test } from 'bun:test';

import {
  resolveHermesEndpoint,
  resolveHermesModel,
  resolveHermesProvider,
} from './options-translator';

// ─── resolveHermesModel ────────────────────────────────────────────────────

describe('resolveHermesModel', () => {
  test('resolves from modelRef with provider prefix', () => {
    const result = resolveHermesModel('hermes:ollama/llama3.1', {});
    expect(result).toEqual({ provider: 'ollama', model: 'llama3.1' });
  });

  test('resolves from modelRef with default provider', () => {
    const result = resolveHermesModel('hermes:qwen2.5-coder:32b', { provider: 'ollama' });
    expect(result).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:32b' });
  });

  test('falls back to config model and provider', () => {
    const result = resolveHermesModel(undefined, { provider: 'ollama', model: 'llama3.1' });
    expect(result).toEqual({ provider: 'ollama', model: 'llama3.1' });
  });

  test('falls back to config model only with placeholder provider', () => {
    const result = resolveHermesModel(undefined, { model: 'llama3.1' });
    expect(result).toEqual({ provider: '<default>', model: 'llama3.1' });
  });

  test('returns null when nothing resolvable', () => {
    const result = resolveHermesModel(undefined, {});
    expect(result).toBeNull();
  });

  test('modelRef overrides config model', () => {
    const result = resolveHermesModel('hermes:openrouter/gpt-4o', {
      provider: 'ollama',
      model: 'llama3.1',
    });
    expect(result).toEqual({ provider: 'openrouter', model: 'gpt-4o' });
  });

  test('bare "hermes" modelRef falls back to config', () => {
    const result = resolveHermesModel('hermes', { provider: 'ollama', model: 'llama3.1' });
    expect(result).toEqual({ provider: 'ollama', model: 'llama3.1' });
  });
});

// ─── resolveHermesProvider ─────────────────────────────────────────────────

describe('resolveHermesProvider', () => {
  test('resolves provider from modelRef', () => {
    expect(resolveHermesProvider('hermes:ollama/llama3.1', {})).toBe('ollama');
  });

  test('falls back to config provider', () => {
    expect(resolveHermesProvider(undefined, { provider: 'openrouter' })).toBe('openrouter');
  });

  test('returns undefined when no provider available', () => {
    expect(resolveHermesProvider(undefined, {})).toBeUndefined();
  });

  test('modelRef provider wins over config provider', () => {
    expect(resolveHermesProvider('hermes:anthropic/claude-3-sonnet', { provider: 'ollama' })).toBe(
      'anthropic'
    );
  });
});

// ─── resolveHermesEndpoint ─────────────────────────────────────────────────

describe('resolveHermesEndpoint', () => {
  test('returns config endpoint when set', () => {
    expect(resolveHermesEndpoint({ endpoint: 'http://custom:11434/v1' })).toBe(
      'http://custom:11434/v1'
    );
  });

  test('returns Ollama default when provider is ollama and no endpoint', () => {
    expect(resolveHermesEndpoint({ provider: 'ollama' })).toBe('http://localhost:11434/v1');
  });

  test('returns OpenRouter custom endpoint when set', () => {
    expect(
      resolveHermesEndpoint({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1' })
    ).toBe('https://openrouter.ai/api/v1');
  });

  test('returns undefined for non-ollama provider without endpoint', () => {
    expect(resolveHermesEndpoint({ provider: 'openai' })).toBeUndefined();
  });

  test('returns undefined for empty config', () => {
    expect(resolveHermesEndpoint({})).toBeUndefined();
  });

  test('config endpoint takes precedence over ollama default', () => {
    expect(resolveHermesEndpoint({ provider: 'ollama', endpoint: 'http://custom:11434/v1' })).toBe(
      'http://custom:11434/v1'
    );
  });
});
