/**
 * Data models for skills and resources.
 *
 * These are plain object factories — no class overhead needed.
 */

/**
 * @typedef {Object} SkillMetadata
 * @property {string} name
 * @property {string} description
 * @property {string} provider
 * @property {string[]} tags
 */

/**
 * @typedef {Object} SkillContent
 * @property {string} name
 * @property {string} description
 * @property {string} content
 * @property {ResourceRef[]} resources
 */

/**
 * @typedef {Object} ResourceRef
 * @property {string} name
 * @property {string} uri
 * @property {string} description
 * @property {string} mimeType
 */

/**
 * @typedef {Object} ResourceContent
 * @property {string} uri
 * @property {string} content
 * @property {string} mimeType
 */

export function createSkillMetadata({ name, description, provider = '', tags = [] }) {
  return { name, description, provider, tags };
}

export function createSkillContent({ name, description, content, resources = [] }) {
  return { name, description, content, resources };
}

export function createResourceRef({ name, uri, description = '', mimeType = 'text/plain' }) {
  return { name, uri, description, mimeType };
}

export function createResourceContent({ uri, content, mimeType = 'text/plain' }) {
  return { uri, content, mimeType };
}
