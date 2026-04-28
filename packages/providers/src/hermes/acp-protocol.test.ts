import { describe, expect, test } from 'bun:test';
import {
  createRequest,
  createNotification,
  parseMessage,
  serializeMessage,
  createAcpIdGenerator,
  isSessionUpdateParams,
} from './acp-protocol';

describe('ACP protocol', () => {
  test('createRequest builds valid JSON-RPC 2.0 request', () => {
    const req = createRequest('session/new', { cwd: '/tmp' }, createAcpIdGenerator());
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('session/new');
    expect(req.params).toEqual({ cwd: '/tmp' });
    expect(typeof req.id).toBe('number');
  });

  test('serializeMessage produces newline-terminated JSON', () => {
    const req = createRequest('initialize', { protocolVersion: 1 }, createAcpIdGenerator());
    const line = serializeMessage(req);
    expect(line.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test('parseMessage extracts success response', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"abc"}}\n';
    const msg = parseMessage(line.trim());
    expect(msg).not.toBeNull();
    expect(msg!.jsonrpc).toBe('2.0');
    if ('result' in msg!) {
      expect(msg.result).toEqual({ sessionId: 'abc' });
    }
  });

  test('parseMessage extracts notification', () => {
    const line =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"abc","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n';
    const msg = parseMessage(line.trim());
    expect(msg).not.toBeNull();
    if ('method' in msg!) {
      expect(msg.method).toBe('session/update');
    }
  });

  test('parseMessage returns null for invalid JSON', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('{"not":"jsonrpc"}')).toBeNull();
  });

  test('parseMessage accepts response with string id (JSON-RPC 2.0)', () => {
    const line = '{"jsonrpc":"2.0","id":"abc","result":{}}';
    const msg = parseMessage(line);
    expect(msg).not.toBeNull();
    expect(msg).toHaveProperty('id', 'abc');
  });

  test('parseMessage rejects response with non-string-non-number id', () => {
    const line = '{"jsonrpc":"2.0","id":true,"result":{}}';
    expect(parseMessage(line)).toBeNull();
  });

  test('parseMessage rejects message with both result and method', () => {
    const line = '{"jsonrpc":"2.0","id":1,"result":{},"method":"foo"}';
    expect(parseMessage(line)).toBeNull();
  });

  test('parseMessage rejects error with non-numeric code', () => {
    const line = '{"jsonrpc":"2.0","id":1,"error":{"code":"BAD","message":"fail"}}';
    expect(parseMessage(line)).toBeNull();
  });

  test('parseMessage rejects notification with non-string method', () => {
    const line = '{"jsonrpc":"2.0","method":123}';
    expect(parseMessage(line)).toBeNull();
  });

  test('createNotification has no id field', () => {
    const notif = createNotification('session/cancel', { sessionId: 'abc' });
    const serialized = JSON.parse(serializeMessage(notif).trim());
    expect(serialized.id).toBeUndefined();
    expect(serialized.method).toBe('session/cancel');
  });

  test('AcpIdGenerator always returns positive IDs (> 0)', () => {
    const gen = createAcpIdGenerator();
    // Generate many IDs — none should be zero or negative
    for (let i = 0; i < 100; i++) {
      expect(gen.next()).toBeGreaterThan(0);
    }
  });

  test('AcpIdGenerator IDs are strictly monotonically increasing', () => {
    const gen = createAcpIdGenerator();
    let prev = gen.next();
    for (let i = 0; i < 100; i++) {
      const curr = gen.next();
      expect(curr).toBeGreaterThan(prev);
      prev = curr;
    }
  });

  test('two generators produce non-overlapping ID sequences', () => {
    const genA = createAcpIdGenerator();
    const genB = createAcpIdGenerator();
    const idsA = new Set<number>();
    const idsB = new Set<number>();
    for (let i = 0; i < 50; i++) {
      idsA.add(genA.next());
      idsB.add(genB.next());
    }
    // No ID from genA should appear in genB
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  test('produces globally unique IDs across multiple instances', () => {
    const generators = Array.from({ length: 10 }, () => createAcpIdGenerator());
    const allIds = new Set<number>();
    for (const gen of generators) {
      for (let i = 0; i < 100; i++) {
        const id = gen.next();
        // All IDs must be unique (no duplicates across any generators)
        expect(allIds.has(id)).toBe(false);
        allIds.add(id);
      }
    }
    expect(allIds.size).toBe(1000);
  });

  test('parseMessage returns null for empty string', () => {
    expect(parseMessage('')).toBeNull();
  });

  test('parseMessage returns null for whitespace-only', () => {
    expect(parseMessage('   ')).toBeNull();
  });

  test('parseMessage returns null for error with null error object', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"error":null}')).toBeNull();
  });

  test('parseMessage accepts notification with no params', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"session/update"}');
    expect(msg).not.toBeNull();
    if (msg && 'method' in msg) {
      expect(msg.method).toBe('session/update');
      expect(msg.params).toBeUndefined();
    }
  });

  test('parseMessage handles deeply nested result object', () => {
    const complexResult = {
      sessionId: 'abc',
      capabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, maxTokens: 128000 },
        mcpCapabilities: { toolDiscovery: true },
      },
      agentInfo: { name: 'hermes', title: 'Hermes Agent', version: '1.0.0' },
      authMethods: [{ type: 'oauth2', name: 'Google', scopes: ['read', 'write'] }],
    };
    const line = JSON.stringify({ jsonrpc: '2.0', id: 42, result: complexResult });
    const msg = parseMessage(line);
    expect(msg).not.toBeNull();
    if (msg && 'result' in msg) {
      expect((msg.result as any).capabilities.promptCapabilities.maxTokens).toBe(128000);
    }
  });
});

describe('isSessionUpdateParams', () => {
  test('accepts valid agent_message_chunk', () => {
    const input = {
      sessionId: 'abc',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    expect(isSessionUpdateParams(input)).toBe(true);
  });

  test('accepts valid agent_thought_chunk', () => {
    const input = {
      sessionId: 'abc',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    };
    expect(isSessionUpdateParams(input)).toBe(true);
  });

  test('rejects missing sessionId', () => {
    const input = {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    expect(isSessionUpdateParams(input)).toBe(false);
  });

  test('rejects non-string sessionId', () => {
    const input = {
      sessionId: 123,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    expect(isSessionUpdateParams(input)).toBe(false);
  });

  test('rejects unknown sessionUpdate value', () => {
    const input = {
      sessionId: 'abc',
      update: { sessionUpdate: 'unknown_type', content: { type: 'text', text: 'hi' } },
    };
    expect(isSessionUpdateParams(input)).toBe(false);
  });

  test('rejects null input', () => {
    expect(isSessionUpdateParams(null)).toBe(false);
  });

  test('rejects undefined input', () => {
    expect(isSessionUpdateParams(undefined)).toBe(false);
  });

  test('rejects missing update', () => {
    expect(isSessionUpdateParams({ sessionId: 'abc' })).toBe(false);
  });

  test('rejects non-object update', () => {
    expect(isSessionUpdateParams({ sessionId: 'abc', update: 'not-an-object' })).toBe(false);
  });
});
