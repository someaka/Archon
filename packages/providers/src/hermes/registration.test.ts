import { describe, test, expect, beforeEach } from 'bun:test';
import {
  clearRegistry,
  getRegistration,
  getRegisteredProviders,
  isRegisteredProvider,
} from '../registry';
import { registerHermesProvider } from './registration';
import { HERMES_CAPABILITIES } from './capabilities';

describe('registerHermesProvider', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('registers with correct id, displayName, and builtIn=true', () => {
    registerHermesProvider();

    expect(isRegisteredProvider('hermes')).toBe(true);
    const reg = getRegistration('hermes');
    expect(reg.id).toBe('hermes');
    expect(reg.displayName).toBe('Hermes Agent (Nous Research)');
    expect(reg.builtIn).toBe(true);
  });

  test('is idempotent — does not throw on second call', () => {
    registerHermesProvider();
    expect(() => registerHermesProvider()).not.toThrow();
    const entries = getRegisteredProviders().filter(p => p.id === 'hermes');
    expect(entries).toHaveLength(1);
  });

  test('isModelCompatible returns true for any model string', () => {
    registerHermesProvider();
    const reg = getRegistration('hermes');

    expect(reg.isModelCompatible('gpt-4')).toBe(true);
    expect(reg.isModelCompatible('')).toBe(true);
    expect(reg.isModelCompatible('hermes:ollama/llama3.1')).toBe(true);
    expect(reg.isModelCompatible('sonnet')).toBe(true);
    expect(reg.isModelCompatible('arbitrary-model-name')).toBe(true);
  });

  test('factory creates a HermesProvider instance', () => {
    registerHermesProvider();
    const reg = getRegistration('hermes');
    const provider = reg.factory();

    expect(provider.getType()).toBe('hermes');
    expect(typeof provider.sendQuery).toBe('function');
    expect(typeof provider.getCapabilities).toBe('function');
  });

  test('capabilities match HERMES_CAPABILITIES constant', () => {
    registerHermesProvider();
    const reg = getRegistration('hermes');

    expect(reg.capabilities).toEqual(HERMES_CAPABILITIES);
    // Spot-check a few flags
    expect(reg.capabilities.sessionResume).toBe(true);
    expect(reg.capabilities.mcp).toBe(true);
    expect(reg.capabilities.envInjection).toBe(true);
    expect(reg.capabilities.hooks).toBe(false);
    expect(reg.capabilities.skills).toBe(false);
    expect(reg.capabilities.sandbox).toBe(false);
  });
});
