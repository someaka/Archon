import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AcpMcpServer } from './event-bridge';
import { createLazyLogger } from '../utils/lazy-logger';

const getLog = createLazyLogger('provider.hermes.mcp-reader');

interface HermesMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  url?: string;
  [key: string]: unknown;
}

interface HermesConfig {
  mcp_servers?: Record<string, HermesMcpServer>;
  [key: string]: unknown;
}

/**
 * Read MCP server configuration from Hermes's config.yaml
 * (~/.hermes/config.yaml by default) and convert each enabled stdio server
 * to ACP format.
 *
 * - Skips servers where `enabled: false`
 * - Skips HTTP servers (those with `url` instead of `command`) with a warning
 * - Converts env from object `{ KEY: VALUE }` to array `['KEY=VALUE']`
 * - Returns empty array if config file doesn't exist or can't be parsed
 */
export async function readHermesMcpConfig(hermesHome?: string): Promise<AcpMcpServer[]> {
  const home = hermesHome ?? join(homedir(), '.hermes');
  const configPath = join(home, 'config.yaml');

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      getLog().debug({ configPath }, 'hermes.mcp.config_not_found');
      return [];
    }
    getLog().warn({ err, configPath }, 'hermes.mcp.config_read_error');
    return [];
  }

  let config: HermesConfig;
  try {
    config = Bun.YAML.parse(raw) as HermesConfig;
  } catch (err) {
    getLog().warn({ err, configPath }, 'hermes.mcp.config_parse_error');
    return [];
  }

  if (!config.mcp_servers || typeof config.mcp_servers !== 'object') {
    return [];
  }

  const servers: AcpMcpServer[] = [];

  for (const [name, server] of Object.entries(config.mcp_servers)) {
    // Skip disabled servers
    if (server.enabled === false) {
      getLog().debug({ name }, 'hermes.mcp.server_disabled');
      continue;
    }

    // Skip HTTP servers (remote/SSE) — only stdio servers are supported
    if (server.url && !server.command) {
      getLog().warn({ name }, 'hermes.mcp.http_server_skipped');
      continue;
    }

    // Must have a command for stdio
    if (!server.command) {
      getLog().warn({ name }, 'hermes.mcp.server_no_command');
      continue;
    }

    // Convert env from object to array
    const envArray = server.env
      ? Object.entries(server.env).map(([key, value]) => `${key}=${value}`)
      : [];

    servers.push({
      name,
      command: server.command,
      args: server.args ?? [],
      env: envArray,
    });
  }

  return servers;
}
