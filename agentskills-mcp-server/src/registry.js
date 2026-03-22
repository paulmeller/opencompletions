/**
 * Skill registry that aggregates one or more providers.
 */
export class SkillRegistry {
  constructor() {
    /** @type {import('./providers/base.js').SkillProvider[]} */
    this._providers = [];
  }

  addProvider(provider) {
    this._providers.push(provider);
  }

  /** Collect metadata from all registered providers. */
  async listSkills() {
    const all = [];
    for (const provider of this._providers) {
      const skills = await provider.listSkills();
      all.push(...skills);
    }
    return all;
  }

  /** Find and return full content for a skill by name. */
  async activateSkill(name) {
    for (const provider of this._providers) {
      try {
        return await provider.getSkill(name);
      } catch {
        continue;
      }
    }
    throw new Error(`Skill not found in any provider: ${name}`);
  }

  /** Find and return a resource from a skill. */
  async readResource(skillName, resourceUri) {
    for (const provider of this._providers) {
      try {
        return await provider.getResource(skillName, resourceUri);
      } catch {
        continue;
      }
    }
    throw new Error(`Resource not found: ${resourceUri} in skill ${skillName}`);
  }
}
