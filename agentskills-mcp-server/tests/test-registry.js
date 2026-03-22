import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../src/registry.js';
import { SkillProvider } from '../src/providers/base.js';
import { createSkillMetadata, createSkillContent, createResourceContent } from '../src/models.js';

class MockProvider extends SkillProvider {
  constructor(skills = []) {
    super();
    this.skills = skills;
  }

  async listSkills() {
    return this.skills.map(s =>
      createSkillMetadata({ name: s.name, description: s.description, provider: 'mock' })
    );
  }

  async getSkill(name) {
    const skill = this.skills.find(s => s.name === name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    return createSkillContent({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      resources: [],
    });
  }

  async getResource(skillName, resourceUri) {
    return createResourceContent({ uri: resourceUri, content: 'mock content' });
  }
}

describe('SkillRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('returns empty list with no providers', async () => {
    const skills = await registry.listSkills();
    assert.deepEqual(skills, []);
  });

  it('lists skills from a single provider', async () => {
    registry.addProvider(new MockProvider([
      { name: 'skill-a', description: 'First skill', content: '# A' },
      { name: 'skill-b', description: 'Second skill', content: '# B' },
    ]));

    const skills = await registry.listSkills();
    assert.equal(skills.length, 2);
    assert.equal(skills[0].name, 'skill-a');
    assert.equal(skills[1].name, 'skill-b');
  });

  it('aggregates skills from multiple providers', async () => {
    registry.addProvider(new MockProvider([
      { name: 'alpha', description: 'Alpha', content: '# alpha' },
    ]));
    registry.addProvider(new MockProvider([
      { name: 'beta', description: 'Beta', content: '# beta' },
    ]));

    const skills = await registry.listSkills();
    assert.equal(skills.length, 2);
  });

  it('activates a skill by name', async () => {
    registry.addProvider(new MockProvider([
      { name: 'deploy', description: 'Deploy skill', content: '# Deploy\nDeploy instructions here.' },
    ]));

    const skill = await registry.activateSkill('deploy');
    assert.equal(skill.name, 'deploy');
    assert.ok(skill.content.includes('Deploy instructions'));
  });

  it('throws when skill not found', async () => {
    registry.addProvider(new MockProvider([]));
    await assert.rejects(
      () => registry.activateSkill('nonexistent'),
      { message: /not found/i }
    );
  });

  it('falls through providers until skill is found', async () => {
    registry.addProvider(new MockProvider([])); // empty
    registry.addProvider(new MockProvider([
      { name: 'fallback', description: 'Found it', content: '# Found' },
    ]));

    const skill = await registry.activateSkill('fallback');
    assert.equal(skill.name, 'fallback');
  });

  it('reads a resource', async () => {
    registry.addProvider(new MockProvider([
      { name: 'with-res', description: 'Has resources', content: '#' },
    ]));

    const resource = await registry.readResource('with-res', 'resources/file.txt');
    assert.equal(resource.content, 'mock content');
  });
});
