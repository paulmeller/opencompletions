import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFileSystemProvider } from '../src/providers/filesystem.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '..', 'examples', 'my-skills');

describe('LocalFileSystemProvider', () => {
  it('throws if directory does not exist', () => {
    assert.throws(
      () => new LocalFileSystemProvider('/nonexistent/path'),
      { message: /not found/i }
    );
  });

  it('lists skills from example directory', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    const skills = await provider.listSkills();

    assert.ok(skills.length > 0, 'Should find at least one skill');
    assert.equal(skills[0].name, 'example-skill');
    assert.equal(skills[0].provider, 'filesystem');
    assert.ok(skills[0].description.length > 0, 'Should have a description');
  });

  it('activates a skill and returns full content', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    const skill = await provider.getSkill('example-skill');

    assert.equal(skill.name, 'example-skill');
    assert.ok(skill.content.includes('# Example Skill'));
    assert.ok(skill.resources.length > 0, 'Should discover resources');
  });

  it('throws when activating a nonexistent skill', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    await assert.rejects(
      () => provider.getSkill('does-not-exist'),
      { message: /not found/i }
    );
  });

  it('reads a resource file', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    const resource = await provider.getResource('example-skill', 'resources/template.txt');

    assert.ok(resource.content.includes('Hello'));
    assert.equal(resource.uri, 'resources/template.txt');
  });

  it('rejects path traversal attempts', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    await assert.rejects(
      () => provider.getResource('example-skill', '../../package.json'),
      { message: /denied/i }
    );
  });

  it('discovers resources in subdirectory', async () => {
    const provider = new LocalFileSystemProvider(SKILLS_DIR);
    const skill = await provider.getSkill('example-skill');

    const templateRes = skill.resources.find(r => r.name === 'template.txt');
    assert.ok(templateRes, 'Should find template.txt resource');
    assert.ok(templateRes.uri.includes('resources/template.txt'));
  });
});
