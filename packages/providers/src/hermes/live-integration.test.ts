/**
 * Live integration tests for HermesProvider.
 *
 * These tests call real backends (Ollama, OpenRouter) and are skipped when
 * the required infrastructure is not available. They are NOT run in CI by
 * default — they serve as developer-facing smoke tests for the full
 * Hermes CLI → Provider → Archon pipeline.
 *
 * NOTE: The HERMES_HOME temp config approach (provider.ts) only overrides
 * the model name — it does NOT override the provider. This means the test
 * will use whatever provider is configured in ~/.hermes/config.yaml.
 * To test against a specific provider, configure it in your real Hermes config.
 *
 * Required environment:
 *   - Ollama: local daemon on http://localhost:11434 with a pulled model
 *   - OpenRouter: OPENROUTER_API_KEY in ~/.hermes/.env or environment
 */

import { describe, expect, test } from 'bun:test';
import { HermesProvider } from './provider';
import type { MessageChunk } from '../types';

// ─── Ollama live tests ──────────────────────────────────────────────────────
//
// These tests require:
// 1. Ollama running at localhost:11434
// 2. A model pulled locally (e.g., ollama pull gemma4:e2b)
// 3. Hermes config set to use ollama provider:
//    model:
//      default: "gemma4:e2b"
//      provider: "ollama"
//      base_url: "http://localhost:11434"

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = 'gemma4:e2b';

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.some(m => m.name === OLLAMA_MODEL) ?? false;
  } catch {
    return false;
  }
}

// Also check if Hermes config is set to use ollama provider
// (HERMES_HOME temp config only overrides model, not provider)
async function isHermesConfiguredForOllama(): Promise<boolean> {
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const configPath = join(process.env.HOME || '/root', '.hermes', 'config.yaml');
    const config = readFileSync(configPath, 'utf-8');
    // Check the top-level model.provider setting (not custom_providers entries)
    // The model config block looks like: "model:\n  provider: ollama"
    const modelBlock = config.split('model:')[1]?.split(/\n[a-z]/)[0] ?? '';
    return modelBlock.includes('provider: ollama');
  } catch {
    return false;
  }
}

const ollamaReady = (await isOllamaReachable()) && (await isHermesConfiguredForOllama());
const describeOllama = ollamaReady ? describe : describe.skip;

describeOllama('Hermes live integration — Ollama', () => {
  test('sendQuery with Ollama model returns response', async () => {
    const provider = new HermesProvider();
    const chunks: MessageChunk[] = [];

    for await (const chunk of provider.sendQuery(
      'Say exactly: "Hello from Ollama via Hermes"',
      '/tmp',
      undefined,
      { model: OLLAMA_MODEL }
    )) {
      chunks.push(chunk);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    expect(assistantChunks.length).toBeGreaterThan(0);

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect((resultChunk as any).isError).toBeFalsy();
  }, 300_000);
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
