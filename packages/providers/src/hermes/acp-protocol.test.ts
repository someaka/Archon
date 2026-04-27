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

  test('AcpIdGenerator wraps at MAX_SAFE_INTEGER', () => {
    const gen = createAcpIdGenerator(Number.MAX_SAFE_INTEGER);
    const lastId = gen.next();
    expect(lastId).toBe(Number.MAX_SAFE_INTEGER);
    const wrappedId = gen.next();
    expect(wrappedId).toBe(1);
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
