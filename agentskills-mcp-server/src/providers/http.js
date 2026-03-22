/**
 * HTTP-based skill provider.
 *
 * Fetches skills from a remote HTTP endpoint (S3, CDN, GitHub Pages, etc.).
 *
 * Expected remote layout:
 *   GET {baseUrl}/index.json           → [{"name": "...", "description": "..."}, ...]
 *   GET {baseUrl}/{name}/SKILL.md      → full skill content
 *   GET {baseUrl}/{name}/{resource}    → resource content
 */

import { SkillProvider } from './base.js';
import { createSkillMetadata, createSkillContent, createResourceRef, createResourceContent } from '../models.js';

function extractDescription(content) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed;
    }
  }
  return '';
}

export class HttpProvider extends SkillProvider {
  constructor(baseUrl, { timeout = 30000 } = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = timeout;
  }

  async listSkills() {
    const resp = await fetch(`${this.baseUrl}/index.json`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(`Failed to fetch skill index: ${resp.status}`);
    const items = await resp.json();

    return items.map(item => createSkillMetadata({
      name: item.name,
      description: item.description || '',
      provider: 'http',
    }));
  }

  async getSkill(name) {
    const resp = await fetch(`${this.baseUrl}/${name}/SKILL.md`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(`Skill not found: ${name}`);
    const content = await resp.text();

    // Try to fetch resource index if available
    let resources = [];
    try {
      const resResp = await fetch(`${this.baseUrl}/${name}/resources.json`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      if (resResp.ok) {
        const items = await resResp.json();
        resources = items.map(item => createResourceRef({
          name: item.name,
          uri: item.uri,
          description: item.description || '',
        }));
      }
    } catch {
      // No resources index — that's fine
    }

    return createSkillContent({
      name,
      description: extractDescription(content),
      content,
      resources,
    });
  }

  async getResource(skillName, resourceUri) {
    const resp = await fetch(`${this.baseUrl}/${skillName}/${resourceUri}`, {
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(`Resource not found: ${resourceUri}`);
    const content = await resp.text();

    return createResourceContent({ uri: resourceUri, content });
  }
}
