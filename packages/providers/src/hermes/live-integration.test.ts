/**
 * Live integration tests for HermesProvider.
 *
 * These tests call real backends (Ollama Cloud, OpenRouter Free) and are
 * skipped when the required API keys are not available. They are NOT run in
 * CI by default — they serve as developer-facing smoke tests for the full
 * Hermes CLI → Provider → Archon pipeline.
 *
 * Required environment (set in ~/.hermes/.env or shell):
 *   OLLAMA_API_KEY     — Get from https://ollama.com/settings/keys (free tier)
 *   OPENROUTER_API_KEY — Get from https://openrouter.ai/settings/keys (free models)
 *
 * Both are free to obtain. No credits or payment required.
 * The test loads ~/.hermes/.env automatically.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadHermesEnv(): void {
  try {
    const content = readFileSync(join(process.env.HOME || '/root', '.hermes', '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* no .env file — guards will skip */
  }
}
loadHermesEnv();
process.env.ARCHON_HERMES_FIRST_EVENT_TIMEOUT_MS = '180000'; // 3 minutes for cloud API cold-starts

import { describe, expect, test } from 'bun:test';
import { HermesProvider } from './provider';
import type { MessageChunk } from '../types';

// ─── Ollama Cloud live tests ─────────────────────────────────────────────────
//
// Uses Ollama's cloud API (not local daemon).
// Requires OLLAMA_API_KEY from https://ollama.com/settings/keys (free tier).

const describeOllama = process.env.OLLAMA_API_KEY ? describe : describe.skip;

describeOllama('Hermes live integration — Ollama Cloud', () => {
  test('sendQuery with Ollama Cloud model returns response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from Ollama Cloud via Hermes"',
      '/tmp',
      undefined,
      {
        model: 'gemma4:31b-cloud',
        assistantConfig: { provider: 'ollama-cloud', endpoint: 'https://ollama.com/v1' },
      }
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();

    // Verify response has actual content
    const fullText = assistantChunks
      .filter(c => 'content' in c && typeof c.content === 'string')
      .map(c => (c as { content: string }).content)
      .join('');
    expect(fullText.length).toBeGreaterThan(0);
  }, 300_000);
});

// ─── OpenRouter Free live tests ──────────────────────────────────────────────
//
// Uses OpenRouter free-tier models (no credits needed).
// Requires OPENROUTER_API_KEY from https://openrouter.ai/settings/keys.

const describeOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

describeOpenRouter('Hermes live integration — OpenRouter Free', () => {
  test('sendQuery with free OpenRouter model returns response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from OpenRouter Free via Hermes"',
      '/tmp',
      undefined,
      { model: 'openrouter/free' }
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();

    // Verify response has actual content
    const fullText = assistantChunks
      .filter(c => 'content' in c && typeof c.content === 'string')
      .map(c => (c as { content: string }).content)
      .join('');
    expect(fullText.length).toBeGreaterThan(0);
  }, 120_000);
});
