import { describe, expect, test } from 'bun:test';
import { buildAcpRequests } from './acp-bridge';

describe('buildAcpRequests', () => {
  test('produces valid initialize request', () => {
    const reqs = buildAcpRequests({ prompt: 'hello', cwd: '/tmp' });
    expect(reqs.initialize.jsonrpc).toBe('2.0');
    expect(reqs.initialize.method).toBe('initialize');
    expect(reqs.initialize.params.protocolVersion).toBe(1);
  });

  test('produces valid session/new request with cwd', () => {
    const reqs = buildAcpRequests({
      prompt: 'hello',
      cwd: '/home/user/project',
    });
    expect(reqs.newSession.method).toBe('session/new');
    expect(reqs.newSession.params.cwd).toBe('/home/user/project');
  });

  test('prompt request includes text content blocks', () => {
    const reqs = buildAcpRequests({ prompt: 'review code', cwd: '/tmp' });
    expect(reqs.prompt.method).toBe('session/prompt');
    const blocks = reqs.prompt.params.prompt as Array<{
      type: string;
      text: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'review code' });
  });

  test('system prompt is prepended as separate block', () => {
    const reqs = buildAcpRequests({
      prompt: 'implement',
      cwd: '/tmp',
      systemPrompt: 'You are a tester.',
    });
    const blocks = reqs.prompt.params.prompt as Array<{
      type: string;
      text: string;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'You are a tester.' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'implement' });
  });

  test('request IDs are unique and sequential', () => {
    const reqs = buildAcpRequests({ prompt: 'test', cwd: '/tmp' });
    expect(reqs.initialize.id).not.toBe(reqs.newSession.id);
    expect(reqs.newSession.id).toBe(reqs.initialize.id + 1);
  });
});
