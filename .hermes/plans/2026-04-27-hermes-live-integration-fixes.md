# Live Integration Tests + Provider Routing Fix

> Three researchers confirmed: provider.ts drops provider/endpoint from temp config.yaml.
> Hermes CLI accepts nested dict format and reads HERMES_INFERENCE_PROVIDER env var.

---

## Changes Required

### Change 1: provider.ts — Write structured config (6 lines)

Lines 236-242. When assistantConfig has provider/endpoint, write nested dict:

```typescript
// BEFORE (flat string — CLI must infer provider):
Bun.YAML.stringify({ model: options.model });

// AFTER (nested dict — CLI uses explicit provider):
const modelConfig: Record<string, unknown> = { default: options.model };
if (config.provider) modelConfig.provider = config.provider;
if (config.endpoint) modelConfig.base_url = config.endpoint;
const hasStructured = config.provider || config.endpoint;
Bun.YAML.stringify({ model: hasStructured ? modelConfig : options.model });
```

### Change 2: provider.ts — Pool key includes provider

Line 167. Pool key `cwd\0model` should be `cwd\0provider\0model`:

```typescript
const poolKey = `${session.cwd}\0${config.provider ?? ''}\0${model}`;
```

### Change 3: live-integration.test.ts — Full rewrite

- Add loadHermesEnv() helper (reads ~/.hermes/.env, no dotenv dep)
- Ollama test: cloud model via assistantConfig with provider/endpoint
- OpenRouter test: free model (:free suffix)
- Remove isHermesConfiguredForOllama() — irrelevant
- Remove isOllamaReachable() localhost check — replaced by API key guard

### Change 4: options-translator.ts — resolveHermesEndpoint for Ollama

Reuse existing function to get default Ollama endpoint when not specified.

---

## Test Config

### Ollama Cloud

```typescript
{
  model: 'gemma4:e2b-cloud',
  assistantConfig: {
    provider: 'ollama-cloud',  // registered provider ID
    endpoint: 'https://ollama.com/v1',
  },
}
```

Guard: OLLAMA_API_KEY from ~/.hermes/.env

### OpenRouter Free

```typescript
{
  model: 'openrouter/google/gemma-4-31b-it:free',  // free, 262K ctx
}
```

Guard: OPENROUTER_API_KEY from ~/.hermes/.env

---

## Files Modified

1. packages/providers/src/hermes/provider.ts — structured config + pool key
2. packages/providers/src/hermes/live-integration.test.ts — full rewrite
3. packages/providers/src/hermes/provider.test.ts — update pool key test

---

## Verification

```bash
cd packages/providers
bun test src/hermes/provider.test.ts        # unit tests pass
bun test src/hermes/live-integration.test.ts # live tests pass (with keys)
bun run test                                 # full suite passes
```
