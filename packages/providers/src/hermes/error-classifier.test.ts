import { describe, expect, test } from 'bun:test';
import { classifyHermesError } from './error-classifier';
import type { ClassifiedError } from './error-classifier';

describe('classifyHermesError', () => {
  test('classifies rate limit', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      '429 Too Many Requests',
      [],
      0
    );
    expect(errorClass).toBe('rate_limit');
    expect(shouldRetry).toBe(true);
  });

  test('classifies rate limit from stderr', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'something went wrong',
      ['rate limit exceeded'],
      0
    );
    expect(errorClass).toBe('rate_limit');
    expect(shouldRetry).toBe(true);
  });

  test('classifies timeout as rate limit', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'request timed out',
      [],
      0
    );
    expect(errorClass).toBe('rate_limit');
    expect(shouldRetry).toBe(true);
  });

  test('classifies "no output within Nms" as crash (first-event timeout)', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'Hermes subprocess produced no output within 30000ms (hermes-preflight)',
      [],
      0
    );
    expect(errorClass).toBe('crash');
    expect(shouldRetry).toBe(false);
  });

  test('classifies auth failure', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError('Unauthorized', [], 0);
    expect(errorClass).toBe('auth');
    expect(shouldRetry).toBe(false);
  });

  test('classifies invalid api key as auth', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'Invalid API key provided',
      [],
      0
    );
    expect(errorClass).toBe('auth');
    expect(shouldRetry).toBe(false);
  });

  test('classifies EACCES as permission', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'EACCES: permission denied',
      [],
      0
    );
    expect(errorClass).toBe('permission');
    expect(shouldRetry).toBe(false);
  });

  test('classifies ENOENT as permission', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'ENOENT: no such file or directory',
      [],
      0
    );
    expect(errorClass).toBe('permission');
    expect(shouldRetry).toBe(false);
  });

  test('classifies ENOTDIR as permission', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'ENOTDIR: not a directory',
      [],
      0
    );
    expect(errorClass).toBe('permission');
    expect(shouldRetry).toBe(false);
  });

  test('classifies permission error from stderr', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'failed to open file',
      ['EACCES'],
      0
    );
    expect(errorClass).toBe('permission');
    expect(shouldRetry).toBe(false);
  });

  test('classifies crash from exit code', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'process exited',
      [],
      1
    );
    expect(errorClass).toBe('crash');
    expect(shouldRetry).toBe(true);
  });

  test('classifies panic as crash', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'runtime panic: nil pointer',
      [],
      0
    );
    expect(errorClass).toBe('crash');
    expect(shouldRetry).toBe(true);
  });

  // ── Object-style API tests ──────────────────────────────────────────

  test('classifies JSON-RPC parse error (-32700)', () => {
    const result = classifyHermesError('fail', { jsonRpcCode: -32700 });
    expect(result.errorClass).toBe('protocol');
    expect(result.shouldRetry).toBe(false);
  });

  test('classifies JSON-RPC invalid request (-32600)', () => {
    const result = classifyHermesError('fail', { jsonRpcCode: -32600 });
    expect(result.errorClass).toBe('protocol');
    expect(result.shouldRetry).toBe(false);
  });

  test('classifies JSON-RPC method not found (-32601)', () => {
    const result = classifyHermesError('fail', { jsonRpcCode: -32601 });
    expect(result.errorClass).toBe('protocol');
    expect(result.shouldRetry).toBe(false);
  });

  test('classifies JSON-RPC invalid params (-32602)', () => {
    const result = classifyHermesError('fail', { jsonRpcCode: -32602 });
    expect(result.errorClass).toBe('protocol');
    expect(result.shouldRetry).toBe(false);
  });

  test('classifies JSON-RPC internal error (-32603)', () => {
    // -32603 is classified as crash, shouldRetry false per implementation.
    const result = classifyHermesError('fail', { jsonRpcCode: -32603 });
    expect(result.errorClass).toBe('crash');
    expect(result.shouldRetry).toBe(false);
  });

  test('classifies unrecognized JSON-RPC code as unknown', () => {
    // Unrecognized JSON-RPC codes fall through to 'unknown' with shouldRetry true.
    const result = classifyHermesError('fail', { jsonRpcCode: -99999 });
    expect(result.errorClass).toBe('unknown');
    expect(result.shouldRetry).toBe(true);
  });

  test('enrichedMessage contains JSON-RPC code', () => {
    const result = classifyHermesError('fail', { jsonRpcCode: -32603 });
    expect(result.enrichedMessage).toContain('-32603');
  });

  test('classifies with stderr array in object context', () => {
    const result = classifyHermesError('fail', { stderr: ['rate limit exceeded'] });
    expect(result.errorClass).toBe('rate_limit');
    expect(result.shouldRetry).toBe(true);
  });

  test('classifies with empty context', () => {
    const result = classifyHermesError('some error');
    expect(result.errorClass).toBeDefined();
    expect(result.shouldRetry).toBeDefined();
  });

  test('classifies unknown errors with shouldRetry true', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'some random error',
      [],
      0
    );
    expect(errorClass).toBe('unknown');
    expect(shouldRetry).toBe(true);
  });

  test('non-zero exit code takes priority over unknown text', () => {
    const { errorClass, shouldRetry }: ClassifiedError = classifyHermesError(
      'weird output',
      [],
      137
    );
    expect(errorClass).toBe('crash');
    expect(shouldRetry).toBe(true);
  });
});
