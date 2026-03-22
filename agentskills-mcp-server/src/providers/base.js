/**
 * Abstract base class for skill providers.
 */
export class SkillProvider {
  /**
   * Return lightweight metadata for every available skill.
   * @returns {Promise<import('../models.js').SkillMetadata[]>}
   */
  async listSkills() {
    throw new Error('listSkills() not implemented');
  }

  /**
   * Return full content for a single skill (activate).
   * @param {string} name
   * @returns {Promise<import('../models.js').SkillContent>}
   */
  async getSkill(name) {
    throw new Error('getSkill() not implemented');
  }

  /**
   * Return the content of a resource referenced by a skill.
   * @param {string} skillName
   * @param {string} resourceUri
   * @returns {Promise<import('../models.js').ResourceContent>}
   */
  async getResource(skillName, resourceUri) {
    throw new Error('getResource() not implemented');
  }
}
