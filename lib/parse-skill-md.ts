/**
 * SKILL.md parser — extracts YAML frontmatter and markdown body.
 * Zero dependencies, uses simple regex parsing (no YAML library).
 *
 * Format:
 * ---
 * name: Contract Risk Analyzer
 * slug: contract-risk-analyzer
 * description: Analyzes contracts clause by clause
 * tags: [legal, contracts]
 * ---
 *
 * # Instructions
 * When activated, analyze the contract...
 */

export interface ParsedSkillMd {
  /** Display name from frontmatter `name` field */
  displayName: string | null;
  /** Slug from frontmatter `slug` field, or slugified name */
  slug: string | null;
  /** Description from frontmatter */
  description: string | null;
  /** Tags array from frontmatter */
  tags: string[];
  /** Markdown body after frontmatter (the instructions) */
  instructions: string;
}

/**
 * Parse YAML-style frontmatter from a SKILL.md file.
 * Returns key-value pairs. Handles:
 * - Simple `key: value` lines
 * - Quoted values: `key: "value"` or `key: 'value'`
 * - Array values: `key: [item1, item2, item3]`
 */
function parseFrontmatter(content: string): Record<string, string | string[]> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;

    let value = m[2].trim();

    // Parse array syntax: [item1, item2]
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[m[1].trim()] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    meta[m[1].trim()] = value;
  }

  return meta;
}

/**
 * Convert a display name to a URL-safe slug.
 * "Contract Risk Analyzer" → "contract-risk-analyzer"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse a SKILL.md file content into structured data.
 */
export function parseSkillMd(raw: string): ParsedSkillMd {
  const fm = parseFrontmatter(raw);

  // Extract body (everything after the closing ---)
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  const instructions = bodyMatch ? bodyMatch[1].trim() : raw.trim();

  // Extract fields
  const displayName = typeof fm.name === "string" ? fm.name : null;
  const description = typeof fm.description === "string" ? fm.description : null;
  const tags = Array.isArray(fm.tags) ? fm.tags : [];

  // Slug: explicit slug field, or slugify the name
  let slug: string | null = null;
  if (typeof fm.slug === "string" && fm.slug) {
    slug = fm.slug;
  } else if (displayName) {
    slug = slugify(displayName);
  }

  return { displayName, slug, description, tags, instructions };
}
