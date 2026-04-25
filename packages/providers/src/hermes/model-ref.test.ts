import { describe, expect, test } from 'bun:test';

import { isHermesModelCompatible, parseHermesModelRef } from './model-ref';

describe('parseHermesModelRef', () => {
  test('bare "hermes" returns null (use defaults)', () => {
    expect(parseHermesModelRef('hermes')).toBeNull();
  });

  test('parses model with default provider', () => {
    expect(parseHermesModelRef('hermes:qwen2.5-coder:32b', { provider: 'ollama' })).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
    });
  });

  test('parses provider/model with ollama', () => {
    expect(parseHermesModelRef('hermes:ollama/llama3.1')).toEqual({
      provider: 'ollama',
      model: 'llama3.1',
    });
  });

  test('parses provider/model with openrouter', () => {
    expect(parseHermesModelRef('hermes:openrouter/anthropic/claude-opus-4')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4',
    });
  });

  test('parses provider/model with openai', () => {
    expect(parseHermesModelRef('hermes:openai/gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  test('model only without default provider returns null', () => {
    expect(parseHermesModelRef('hermes:some-model', {})).toBeNull();
  });

  test('model only with default provider uses default', () => {
    expect(parseHermesModelRef('hermes:some-model', { provider: 'ollama' })).toEqual({
      provider: 'ollama',
      model: 'some-model',
    });
  });

  test('non-hermes prefix returns null', () => {
    expect(parseHermesModelRef('claude:sonnet')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parseHermesModelRef('')).toBeNull();
  });

  test('provider with empty model returns null', () => {
    expect(parseHermesModelRef('hermes:ollama/')).toBeNull();
  });

  test('empty provider with model returns null', () => {
    expect(parseHermesModelRef('hermes:/llama3.1')).toBeNull();
  });

  test('nested openrouter namespace preserved in model', () => {
    expect(parseHermesModelRef('hermes:openrouter/google/gemini-2.5-pro')).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-2.5-pro',
    });
  });

  test('deeply nested slashes preserved in model', () => {
    expect(parseHermesModelRef('hermes:openrouter/a/b/c/d-model')).toEqual({
      provider: 'openrouter',
      model: 'a/b/c/d-model',
    });
  });
});

describe('isHermesModelCompatible', () => {
  test('accepts bare "hermes"', () => {
    expect(isHermesModelCompatible('hermes')).toBe(true);
  });

  test('accepts hermes:qwen2.5-coder:32b', () => {
    expect(isHermesModelCompatible('hermes:qwen2.5-coder:32b')).toBe(true);
  });

  test('accepts hermes:ollama/llama3.1', () => {
    expect(isHermesModelCompatible('hermes:ollama/llama3.1')).toBe(true);
  });

  test('accepts hermes:openrouter/anthropic/claude-opus-4', () => {
    expect(isHermesModelCompatible('hermes:openrouter/anthropic/claude-opus-4')).toBe(true);
  });

  test('always returns true — Hermes CLI resolves its own models', () => {
    // Hermes CLI resolves model/provider from ~/.hermes/config.yaml at runtime.
    // Archon's workflow loader should not gatekeep models that Hermes itself can handle.
    expect(isHermesModelCompatible('claude')).toBe(true);
    expect(isHermesModelCompatible('codex')).toBe(true);
    expect(isHermesModelCompatible('')).toBe(true);
    expect(isHermesModelCompatible('sonnet')).toBe(true);
    expect(isHermesModelCompatible('google/gemini-2.5-pro')).toBe(true);
    expect(isHermesModelCompatible('hermes-ollama')).toBe(true);
  });

  test('accepts any string starting with "hermes:"', () => {
    expect(isHermesModelCompatible('hermes:anything-here')).toBe(true);
  });
});
