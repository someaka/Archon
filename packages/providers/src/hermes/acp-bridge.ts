import { createRequest, type ContentBlock } from './acp-protocol';
import type { HermesProviderDefaults } from '../types';

export interface AcpRequests {
  initialize: ReturnType<typeof createRequest>;
  newSession: ReturnType<typeof createRequest>;
  prompt: ReturnType<typeof createRequest>;
}

export interface BuildAcpRequestsOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  mcpServers?: unknown[];
  config?: HermesProviderDefaults;
}

export function buildAcpRequests(options: BuildAcpRequestsOptions): AcpRequests {
  const initialize = createRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'archon', version: '0.3.9' },
  });

  const newSession = createRequest('session/new', {
    cwd: options.cwd,
    mcpServers: options.mcpServers ?? [],
  });

  const blocks: ContentBlock[] = options.systemPrompt
    ? [
        { type: 'text', text: options.systemPrompt },
        { type: 'text', text: options.prompt },
      ]
    : [{ type: 'text', text: options.prompt }];

  const prompt = createRequest('session/prompt', {
    prompt: blocks,
  });

  return { initialize, newSession, prompt };
}
