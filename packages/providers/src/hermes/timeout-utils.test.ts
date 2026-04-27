import { describe, expect, mock, test } from 'bun:test';
import { withFirstEventTimeout } from './timeout-utils';

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
