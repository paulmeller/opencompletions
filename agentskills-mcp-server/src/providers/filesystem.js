/**
 * Local filesystem skill provider.
 *
 * Expects a directory layout like:
 *
 *   skills-root/
 *   ├── my-skill/
 *   │   ├── SKILL.md          # required – first line is description
 *   │   └── resources/        # optional
 *   │       ├── template.py
 *   │       └── config.yaml
 *   └── another-skill/
 *       └── SKILL.md
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

export class LocalFileSystemProvider extends SkillProvider {
  constructor(root) {
    super();
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new Error(`Skills directory not found: ${this.root}`);
    }
  }

  async listSkills() {
    const entries = await fsp.readdir(this.root, { withFileTypes: true });
    const skills = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(this.root, entry.name, 'SKILL.md');
      try {
        const content = await fsp.readFile(skillFile, 'utf-8');
        skills.push(createSkillMetadata({
          name: entry.name,
          description: extractDescription(content),
          provider: 'filesystem',
        }));
      } catch {
        // No SKILL.md — skip
      }
    }

    return skills;
  }

  async getSkill(name) {
    const skillDir = path.join(this.root, name);
    const skillFile = path.join(skillDir, 'SKILL.md');

    let content;
    try {
      content = await fsp.readFile(skillFile, 'utf-8');
    } catch {
      throw new Error(`Skill not found: ${name}`);
    }

    const resources = await this._discoverResources(name, skillDir);

    return createSkillContent({
      name,
      description: extractDescription(content),
      content,
      resources,
    });
  }

  async getResource(skillName, resourceUri) {
    const resourcePath = path.resolve(path.join(this.root, skillName, resourceUri));

    // Prevent path traversal
    if (!resourcePath.startsWith(this.root)) {
      throw new Error(`Access denied: ${resourceUri}`);
    }

    let content;
    try {
      content = await fsp.readFile(resourcePath, 'utf-8');
    } catch {
      throw new Error(`Resource not found: ${resourceUri}`);
    }

    return createResourceContent({ uri: resourceUri, content });
  }

  async _discoverResources(skillName, skillDir) {
    const resourcesDir = path.join(skillDir, 'resources');
    try {
      const stat = await fsp.stat(resourcesDir);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }

    const refs = [];
    const walk = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const rel = path.relative(skillDir, full);
          refs.push(createResourceRef({
            name: entry.name,
            uri: rel,
            description: `Resource file: ${entry.name}`,
          }));
        }
      }
    };

    await walk(resourcesDir);
    return refs;
  }
}
