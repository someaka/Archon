import { describe, expect, test } from 'bun:test';

import {
  buildHermesCliArgs,
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

// ─── buildHermesCliArgs ────────────────────────────────────────────────────

describe('buildHermesCliArgs', () => {
  test('basic args with prompt only', () => {
    const args = buildHermesCliArgs({ prompt: 'Hello', cwd: '/tmp' });
    expect(args).toEqual(['chat', '--json', '--cwd', '/tmp', '--prompt', 'Hello']);
  });

  test('includes --model from config', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { provider: 'ollama', model: 'llama3.1' },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('llama3.1');
  });

  test('includes --provider from config', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { provider: 'ollama' },
    });
    expect(args).toContain('--provider');
    expect(args[args.indexOf('--provider') + 1]).toBe('ollama');
  });

  test('includes --endpoint from config', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { endpoint: 'http://localhost:11434/v1' },
    });
    expect(args).toContain('--endpoint');
    expect(args[args.indexOf('--endpoint') + 1]).toBe('http://localhost:11434/v1');
  });

  test('includes OpenRouter custom endpoint from config', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { provider: 'openrouter', model: 'gpt-4o', endpoint: 'https://openrouter.ai/api/v1' },
    });
    expect(args).toContain('--endpoint');
    expect(args[args.indexOf('--endpoint') + 1]).toBe('https://openrouter.ai/api/v1');
    expect(args).toContain('--provider');
    expect(args[args.indexOf('--provider') + 1]).toBe('openrouter');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-4o');
  });

  test('includes --system with system prompt', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      systemPrompt: 'You are a helpful assistant.',
    });
    expect(args).toContain('--system');
    expect(args[args.indexOf('--system') + 1]).toBe('You are a helpful assistant.');
  });

  test('Ollama default endpoint when provider is ollama and no endpoint set', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { provider: 'ollama', model: 'llama3.1' },
    });
    expect(args).toContain('--endpoint');
    expect(args[args.indexOf('--endpoint') + 1]).toBe('http://localhost:11434/v1');
  });

  test('modelRef overrides config model', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      modelRef: 'hermes:openrouter/gpt-4o',
      config: { provider: 'ollama', model: 'llama3.1' },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-4o');
    expect(args).toContain('--provider');
    expect(args[args.indexOf('--provider') + 1]).toBe('openrouter');
  });

  test('includes --env flags for env vars', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      env: { API_KEY: 'secret', URL: 'http://example.com' },
    });
    expect(args).toContain('--env');
    // There should be two --env flags
    const envIndices = args.map((a, i) => (a === '--env' ? i : -1)).filter(i => i !== -1);
    expect(envIndices).toHaveLength(2);
  });

  test('env var key=value format', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      env: { FOO: 'bar' },
    });
    const envIdx = args.indexOf('--env');
    expect(args[envIdx + 1]).toBe('FOO=bar');
  });

  test('empty env object produces no --env flags', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      env: {},
    });
    expect(args).not.toContain('--env');
  });

  test('all CLI flags present in correct order', () => {
    const args = buildHermesCliArgs({
      prompt: 'Write a test',
      cwd: '/workspace',
      modelRef: 'hermes:ollama/llama3.1',
      config: { provider: 'ollama' },
      systemPrompt: 'Be concise.',
      env: { DEBUG: '1' },
    });

    // Verify all expected flags are present
    expect(args[0]).toBe('chat');
    expect(args[1]).toBe('--json');
    expect(args).toContain('--model');
    expect(args).toContain('--provider');
    expect(args).toContain('--endpoint');
    expect(args).toContain('--system');
    expect(args).toContain('--cwd');
    expect(args).toContain('--env');
    expect(args).toContain('--prompt');

    // --prompt should be last (always last)
    expect(args[args.length - 2]).toBe('--prompt');
    expect(args[args.length - 1]).toBe('Write a test');
  });

  test('empty system prompt omitted', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      systemPrompt: '',
    });
    expect(args).not.toContain('--system');
  });

  test('undefined system prompt omitted', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
    });
    expect(args).not.toContain('--system');
  });

  test('model flag included when config has model even without provider', () => {
    const args = buildHermesCliArgs({
      prompt: 'Hello',
      cwd: '/tmp',
      config: { model: 'some-model' },
    });
    // model exists but provider is undefined, so resolvedModel.provider is '<default>'
    // but the model itself is still 'some-model' — so --model is included
    expect(args).toContain('--model');
    expect(args).toContain('some-model');
  });
});
