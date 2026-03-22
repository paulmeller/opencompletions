import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRegistry } from '../src/registry.js';
import { LocalFileSystemProvider } from '../src/providers/filesystem.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '..', 'examples', 'my-skills');

async function createTestClient() {
  const registry = new SkillRegistry();
  registry.addProvider(new LocalFileSystemProvider(SKILLS_DIR));
  const server = createServer(registry);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return client;
}

describe('MCP Server', () => {
  let client;

  beforeEach(async () => {
    client = await createTestClient();
  });

  it('lists resources (skill metadata)', async () => {
    const result = await client.listResources();
    assert.ok(result.resources.length > 0);
    assert.equal(result.resources[0].name, 'example-skill');
    assert.ok(result.resources[0].uri.startsWith('skill://'));
  });

  it('reads a resource by URI', async () => {
    const result = await client.readResource({ uri: 'skill://example-skill/metadata' });
    assert.ok(result.contents.length > 0);
    assert.ok(result.contents[0].text.includes('# Example Skill'));
  });

  it('lists tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    assert.ok(names.includes('list_skills'));
    assert.ok(names.includes('activate_skill'));
    assert.ok(names.includes('read_resource'));
  });

  it('calls list_skills tool', async () => {
    const result = await client.callTool({ name: 'list_skills', arguments: {} });
    assert.ok(result.content[0].text.includes('example-skill'));
  });

  it('calls activate_skill tool', async () => {
    const result = await client.callTool({
      name: 'activate_skill',
      arguments: { name: 'example-skill' },
    });
    const text = result.content[0].text;
    assert.ok(text.includes('# Example Skill'));
    assert.ok(text.includes('resources'));
  });

  it('returns error for nonexistent skill', async () => {
    const result = await client.callTool({
      name: 'activate_skill',
      arguments: { name: 'nonexistent' },
    });
    assert.ok(result.isError || result.content[0].text.includes('Error'));
  });

  it('calls read_resource tool', async () => {
    const result = await client.callTool({
      name: 'read_resource',
      arguments: { skill_name: 'example-skill', resource_uri: 'resources/template.txt' },
    });
    assert.ok(result.content[0].text.includes('Hello'));
  });

  it('returns error for unknown tool', async () => {
    const result = await client.callTool({
      name: 'unknown_tool',
      arguments: {},
    });
    assert.ok(result.isError || result.content[0].text.includes('Unknown tool'));
  });
});
