import { beforeEach, describe, expect, test } from 'bun:test';
import { buildAcpRequests, type BuildAcpRequestsOptions } from './acp-bridge';
import { resetAcpIdCounter } from './acp-protocol';

describe('buildAcpRequests', () => {
  beforeEach(() => {
    resetAcpIdCounter(1);
  });

  test('returns initialize with correct protocolVersion, clientCapabilities, and clientInfo', () => {
    const result = buildAcpRequests({ cwd: '/tmp', prompt: 'hello' });
    expect(result.initialize.method).toBe('initialize');
    expect(result.initialize.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'archon', version: '0.3.9' },
    });
  });

  test('returns newSession with cwd and empty mcpServers array', () => {
    const result = buildAcpRequests({ cwd: '/tmp', prompt: 'hello' });
    expect(result.newSession.method).toBe('session/new');
    expect(result.newSession.params).toEqual({
      cwd: '/tmp',
      mcpServers: [],
    });
  });

  test('returns prompt with single text block when no systemPrompt', () => {
    const result = buildAcpRequests({ cwd: '/tmp', prompt: 'hello' });
    expect(result.prompt.method).toBe('session/prompt');
    expect(result.prompt.params).toEqual({
      prompt: [{ type: 'text', text: 'hello' }],
    });
  });

  test('returns prompt with systemPrompt prepended as first text block', () => {
    const result = buildAcpRequests({
      cwd: '/tmp',
      prompt: 'hello',
      systemPrompt: 'You are a helpful assistant.',
    });
    expect(result.prompt.method).toBe('session/prompt');
    expect(result.prompt.params).toEqual({
      prompt: [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'hello' },
      ],
    });
  });

  test('returns requests with auto-incrementing ids starting from 1', () => {
    const result = buildAcpRequests({ cwd: '/tmp', prompt: 'hello' });
    expect(result.initialize.id).toBe(1);
    expect(result.newSession.id).toBe(2);
    expect(result.prompt.id).toBe(3);
  });
});
