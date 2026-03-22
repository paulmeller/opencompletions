/**
 * MCP server that exposes Agent Skills as tools and resources.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Create and configure an MCP server backed by the given registry.
 * @param {import('./registry.js').SkillRegistry} registry
 * @returns {Server}
 */
export function createServer(registry) {
  const server = new Server(
    { name: 'agentskills-mcp-server', version: '0.1.0' },
    { capabilities: { resources: {}, tools: {} } }
  );

  // --- Resources: expose skill catalog ---

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const skills = await registry.listSkills();
    return {
      resources: skills.map(skill => ({
        uri: `skill://${skill.name}/metadata`,
        name: skill.name,
        description: skill.description,
        mimeType: 'text/plain',
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (!uri.startsWith('skill://')) {
      throw new Error(`Unknown resource URI scheme: ${uri}`);
    }
    const parts = uri.slice('skill://'.length).split('/');
    const skillName = parts[0];

    const skill = await registry.activateSkill(skillName);
    return {
      contents: [
        {
          uri,
          mimeType: 'text/plain',
          text: skill.content,
        },
      ],
    };
  });

  // --- Tools ---

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_skills',
          description:
            'List all available skills with their names and descriptions. Use this to discover what skills are available before activating one.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'activate_skill',
          description:
            'Load the full content of a skill by name. Returns the complete SKILL.md content and a list of available resources.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The name of the skill to activate',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'read_resource',
          description:
            'Read a resource file referenced by a skill. Use the resource URI returned by activate_skill.',
          inputSchema: {
            type: 'object',
            properties: {
              skill_name: {
                type: 'string',
                description: 'The name of the skill that owns the resource',
              },
              resource_uri: {
                type: 'string',
                description: 'The URI of the resource to read',
              },
            },
            required: ['skill_name', 'resource_uri'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'list_skills') {
      const skills = await registry.listSkills();
      const lines = skills.map(s => `- **${s.name}**: ${s.description}`);
      const text = lines.length > 0 ? lines.join('\n') : 'No skills available.';
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'activate_skill') {
      const skillName = args?.name || '';
      try {
        const skill = await registry.activateSkill(skillName);
        const parts = [skill.content];
        if (skill.resources.length > 0) {
          parts.push('\n---\n**Available resources:**');
          for (const r of skill.resources) {
            parts.push(`- \`${r.uri}\` — ${r.description}`);
          }
        }
        return { content: [{ type: 'text', text: parts.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }

    if (name === 'read_resource') {
      const skillName = args?.skill_name || '';
      const resourceUri = args?.resource_uri || '';
      try {
        const resource = await registry.readResource(skillName, resourceUri);
        return { content: [{ type: 'text', text: resource.content }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  return server;
}
