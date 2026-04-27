/**
 * Live integration tests for HermesProvider.
 *
 * These tests call real backends (Ollama, OpenRouter) and are skipped when
 * the required infrastructure is not available. They are NOT run in CI by
 * default — they serve as developer-facing smoke tests for the full
 * Hermes CLI → Provider → Archon pipeline.
 *
 * Required environment:
 *   - Ollama: local daemon on http://localhost:11434 (default) with a pulled model
 *   - OpenRouter: OPENROUTER_API_KEY in ~/.hermes/.env or environment
 */

import { describe, expect, test } from 'bun:test';
import { HermesProvider } from './provider';
import type { MessageChunk } from '../types';

// ─── Ollama live tests ──────────────────────────────────────────────────────

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// We'll resolve this once at module load and use it for the describe guard.
const ollamaReady = await isOllamaReachable();
const describeOllama = ollamaReady ? describe : describe.skip;

describeOllama('Hermes live integration — Ollama', () => {
  test('sendQuery with Ollama model returns response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from Ollama via Hermes"',
      '/tmp',
      undefined,
      { model: 'ollama/qwen3:4b' }
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();
  }, 120_000);
});

// ─── OpenRouter live tests ──────────────────────────────────────────────────
//
// Requires OPENROUTER_API_KEY in environment or ~/.hermes/.env.
// Uses gemini-2.5-flash (cheap) to minimize costs.

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const describeOpenRouter = OPENROUTER_KEY ? describe : describe.skip;

describeOpenRouter('Hermes live integration — OpenRouter', () => {
  test('sendQuery with OpenRouter model returns response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from OpenRouter via Hermes"',
      '/tmp',
      undefined,
      { model: 'openrouter/google/gemini-2.5-flash' }
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();
  }, 120_000);
});
