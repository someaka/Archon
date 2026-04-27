import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readHermesMcpConfig } from './hermes-mcp-reader';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hermes-mcp-reader-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<string> {
  // tempDir is the hermesHome; config.yaml goes inside it
  await writeFile(join(tempDir, 'config.yaml'), yaml, 'utf-8');
  return tempDir;
}

describe('readHermesMcpConfig', () => {
  test('returns empty array when config file does not exist', async () => {
    const result = await readHermesMcpConfig(tempDir);
    expect(result).toEqual([]);
  });

  test('returns empty array when config file is in a non-existent directory', async () => {
    const result = await readHermesMcpConfig('/tmp/nonexistent-hermes-dir-xyz');
    expect(result).toEqual([]);
  });

  test('converts stdio servers to ACP format', async () => {
    const yaml = `
mcp_servers:
  filesystem:
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
      - "/tmp"
    env:
      API_KEY: secret123
      DEBUG: "true"
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: ['API_KEY=secret123', 'DEBUG=true'],
      },
    ]);
  });

  test('skips disabled servers', async () => {
    const yaml = `
mcp_servers:
  enabled_server:
    command: node
    args: ["server.js"]
  disabled_server:
    command: python
    args: ["server.py"]
    enabled: false
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('enabled_server');
  });

  test('skips HTTP servers (with url instead of command)', async () => {
    const yaml = `
mcp_servers:
  local_server:
    command: node
    args: ["server.js"]
  remote_server:
    url: "https://mcp.example.com/sse"
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('local_server');
  });

  test('converts env object to array', async () => {
    const yaml = `
mcp_servers:
  test_server:
    command: python
    args:
      - server.py
    env:
      TOKEN: abc123
      PORT: "8080"
      HOST: localhost
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].env).toEqual(['TOKEN=abc123', 'PORT=8080', 'HOST=localhost']);
  });

  test('handles server with no env', async () => {
    const yaml = `
mcp_servers:
  simple:
    command: node
    args: ["server.js"]
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([
      {
        name: 'simple',
        command: 'node',
        args: ['server.js'],
        env: [],
      },
    ]);
  });

  test('handles server with no args', async () => {
    const yaml = `
mcp_servers:
  simple:
    command: /usr/bin/my-server
    env:
      KEY: value
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([
      {
        name: 'simple',
        command: '/usr/bin/my-server',
        args: [],
        env: ['KEY=value'],
      },
    ]);
  });

  test('returns empty array on parse error', async () => {
    await writeFile(join(tempDir, 'config.yaml'), '{{{{invalid yaml', 'utf-8');

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([]);
  });

  test('returns empty array when mcp_servers is missing', async () => {
    const yaml = `
model: qwen2.5-coder:32b
provider: ollama
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([]);
  });

  test('skips server with no command and no url', async () => {
    const yaml = `
mcp_servers:
  broken_server:
    args: ["something"]
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toEqual([]);
  });

  test('processes multiple servers', async () => {
    const yaml = `
mcp_servers:
  server_a:
    command: node
    args: ["a.js"]
  server_b:
    command: python
    args: ["b.py"]
    env:
      KEY: value
  disabled_c:
    command: ruby
    enabled: false
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.name).sort()).toEqual(['server_a', 'server_b']);
  });

  test('handles env values containing "=" characters', async () => {
    const yaml = `
mcp_servers:
  test_server:
    command: node
    args: ["server.js"]
    env:
      KEY: value=with=equals
      SIMPLE: plain
`;
    await writeConfig(yaml);

    const result = await readHermesMcpConfig(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].env).toEqual(['KEY=value=with=equals', 'SIMPLE=plain']);
  });
});
