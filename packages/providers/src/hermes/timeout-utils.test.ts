import { describe, expect, mock, test } from 'bun:test';
import { withFirstEventTimeout, buildFirstEventHangDiagnostics } from './timeout-utils';

async function* slowGenerator(delayMs: number): AsyncGenerator<string> {
  await new Promise(r => setTimeout(r, delayMs));
  yield 'first';
  yield 'second';
}

async function* fastGenerator(): AsyncGenerator<string> {
  yield 'first';
  yield 'second';
  yield 'third';
}

describe('withFirstEventTimeout', () => {
  test('throws when first event is too slow', async () => {
    const gen = withFirstEventTimeout(slowGenerator(100), 50, 'test');
    await expect(async () => {
      for await (const _ of gen) {
        // consume
      }
    }).toThrow('Hermes subprocess produced no output within 50ms (test)');
  });

  test('passes through events normally when first event arrives in time', async () => {
    const gen = withFirstEventTimeout(slowGenerator(20), 100, 'test');
    const results: string[] = [];
    for await (const item of gen) results.push(item);
    expect(results).toEqual(['first', 'second']);
  });

  test('allows normal generator completion after first event', async () => {
    const gen = withFirstEventTimeout(fastGenerator(), 1000, 'test');
    const results: string[] = [];
    for await (const item of gen) results.push(item);
    expect(results).toEqual(['first', 'second', 'third']);
  });
});

describe('buildFirstEventHangDiagnostics', () => {
  const sampleInput = {
    timeoutMs: 30000,
    context: 'streaming chat',
    providerName: 'openai',
    model: 'gpt-4o',
    cwd: '/home/user/project',
  };

  test('returns a string containing all input fields', () => {
    const result = buildFirstEventHangDiagnostics(sampleInput);
    expect(result).toContain('Timestamp');
    expect(result).toContain('openai');
    expect(result).toContain('gpt-4o');
    expect(result).toContain('/home/user/project');
    expect(result).toContain('30000ms');
    expect(result).toContain('streaming chat');
  });

  test('includes actionable diagnostic suggestions', () => {
    const result = buildFirstEventHangDiagnostics(sampleInput);
    expect(result).toContain('hermes acp process');
    expect(result).toContain('state.db');
    expect(result).toContain('ConcurrencyLock');
  });

  test('starts and ends with delimiter lines', () => {
    const result = buildFirstEventHangDiagnostics(sampleInput);
    expect(result).toMatch(/^--- First-Event Timeout Diagnostics ---/);
    expect(result).toMatch(/--- End Diagnostics ---$/);
  });

  test('includes an ISO-8601 timestamp', () => {
    const result = buildFirstEventHangDiagnostics(sampleInput);
    // ISO 8601 pattern: 2026-04-28T...
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('is a pure function - same input produces structurally identical output', () => {
    const a = buildFirstEventHangDiagnostics(sampleInput);
    const b = buildFirstEventHangDiagnostics(sampleInput);
    // Only timestamp differs; strip it for structural comparison
    const strip = (s: string) => s.replace(/Timestamp\s+: .+/, '');
    expect(strip(a)).toEqual(strip(b));
  });
});
