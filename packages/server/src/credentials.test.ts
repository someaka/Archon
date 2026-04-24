import { describe, expect, it } from 'bun:test';
import { validateAiCredentials } from './credentials';

describe('validateAiCredentials', () => {
  it('returns true for Hermes-only (HERMES_MODEL)', () => {
    const result = validateAiCredentials({ HERMES_MODEL: 'my-model' });
    expect(result.hasHermesCredentials).toBe(true);
    expect(result.hasAnyCredentials).toBe(true);
    expect(result.hasClaudeCredentials).toBe(false);
    expect(result.hasCodexCredentials).toBe(false);
  });

  it('returns true for Hermes-only (HERMES_BINARY_PATH)', () => {
    const result = validateAiCredentials({ HERMES_BINARY_PATH: '/usr/bin/hermes' });
    expect(result.hasHermesCredentials).toBe(true);
    expect(result.hasAnyCredentials).toBe(true);
  });

  it('returns true for Hermes-only (HERMES_API_KEY)', () => {
    const result = validateAiCredentials({ HERMES_API_KEY: 'sk-hermes' });
    expect(result.hasHermesCredentials).toBe(true);
    expect(result.hasAnyCredentials).toBe(true);
  });

  it('returns false when no credentials are present', () => {
    const result = validateAiCredentials({});
    expect(result.hasClaudeCredentials).toBe(false);
    expect(result.hasCodexCredentials).toBe(false);
    expect(result.hasHermesCredentials).toBe(false);
    expect(result.hasAnyCredentials).toBe(false);
  });

  it('ignores empty string HERMES_MODEL', () => {
    const result = validateAiCredentials({ HERMES_MODEL: '' });
    expect(result.hasHermesCredentials).toBe(false);
    expect(result.hasAnyCredentials).toBe(false);
  });

  it('ignores empty string HERMES_BINARY_PATH', () => {
    const result = validateAiCredentials({ HERMES_BINARY_PATH: '' });
    expect(result.hasHermesCredentials).toBe(false);
    expect(result.hasAnyCredentials).toBe(false);
  });

  it('returns true when Claude and Hermes credentials are both present', () => {
    const result = validateAiCredentials({
      CLAUDE_API_KEY: 'sk-claude',
      HERMES_MODEL: 'my-model',
    });
    expect(result.hasClaudeCredentials).toBe(true);
    expect(result.hasHermesCredentials).toBe(true);
    expect(result.hasAnyCredentials).toBe(true);
  });
});
