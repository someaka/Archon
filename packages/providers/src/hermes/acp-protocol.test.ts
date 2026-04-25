import { describe, expect, test } from 'bun:test';
import { createRequest, createNotification, parseMessage, serializeMessage } from './acp-protocol';

describe('ACP protocol', () => {
  test('createRequest builds valid JSON-RPC 2.0 request', () => {
    const req = createRequest('session/new', { cwd: '/tmp' });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('session/new');
    expect(req.params).toEqual({ cwd: '/tmp' });
    expect(typeof req.id).toBe('number');
  });

  test('serializeMessage produces newline-terminated JSON', () => {
    const req = createRequest('initialize', { protocolVersion: 1 });
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

  test('createNotification has no id field', () => {
    const notif = createNotification('session/cancel', { sessionId: 'abc' });
    const serialized = JSON.parse(serializeMessage(notif).trim());
    expect(serialized.id).toBeUndefined();
    expect(serialized.method).toBe('session/cancel');
  });
});
