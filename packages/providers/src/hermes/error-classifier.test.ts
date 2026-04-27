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
