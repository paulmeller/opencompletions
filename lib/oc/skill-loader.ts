/**
 * Shared skill loading logic for all completion/agent endpoints.
 *
 * Resolves skill_filter and preload_skills fields, builds the system
 * prompt injection and filtered MCP server config.
 */

import { getSkill, listSkillsByTags } from "@/lib/db";
import type { AgentOpts } from "./types";

export interface SkillFilter {
  names?: string[];
  tags?: string[];
}

export interface PreloadSkill {
  name?: string;
  instructions?: string;
  resources?: Record<string, string>;
}

export interface SkillLoadResult {
  /** System prompt prefix with preloaded skill content (or empty string) */
  systemPromptPrefix: string;
  /** MCP server config to inject (or null to skip MCP) */
  mcpServers: AgentOpts["mcpServers"] | null;
}

const MAX_PRELOAD_SIZE = 100 * 1024; // 100KB

/**
 * Resolve skills and build the system prompt prefix + MCP config.
 */
export function resolveSkills(
  request: Request,
  skillFilter?: SkillFilter,
  preloadSkills?: PreloadSkill[],
): SkillLoadResult {
  // Resolve skill filter to concrete names
  let filterNames: string[] | null = null;
  if (skillFilter) {
    const nameSet = new Set<string>(skillFilter.names || []);
    if (skillFilter.tags?.length) {
      const tagSkills = listSkillsByTags(skillFilter.tags);
      for (const s of tagSkills) nameSet.add(s.name);
    }
    filterNames = Array.from(nameSet);
  }

  // Preload skills into system prompt
  const preloadedNames = new Set<string>();
  let preloadContent = "";
  let preloadSize = 0;

  if (preloadSkills?.length) {
    for (const item of preloadSkills) {
      let section = "";

      if (item.name) {
        const skill = getSkill(item.name);
        if (!skill) continue;
        preloadedNames.add(item.name);
        section = `## Skill: ${skill.display_name}\n\n${skill.instructions || ""}`;
        for (const r of skill.resources || []) {
          section += `\n\n### Reference: ${r.file_name}\n\n${r.content}`;
        }
      } else if (item.instructions) {
        section = `## Inline Skill\n\n${item.instructions}`;
        if (item.resources) {
          for (const [fname, content] of Object.entries(item.resources)) {
            section += `\n\n### Reference: ${fname}\n\n${content}`;
          }
        }
      }

      if (section) {
        if (preloadSize + section.length > MAX_PRELOAD_SIZE) break;
        preloadContent += (preloadContent ? "\n\n---\n\n" : "") + section;
        preloadSize += section.length;
      }
    }
  }

  // Deduplicate: remove preloaded skills from MCP filter
  if (filterNames && preloadedNames.size > 0) {
    filterNames = filterNames.filter((n) => !preloadedNames.has(n));
  }

  // Build MCP config
  const shouldInjectMcp = !preloadSkills?.length || (filterNames && filterNames.length > 0) || !skillFilter;

  let mcpServers: AgentOpts["mcpServers"] | null = null;
  if (shouldInjectMcp) {
    const host = request.headers.get("x-forwarded-host")
      || request.headers.get("host")
      || `localhost:${process.env.PORT || 3000}`;
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const dashboardUrl = process.env.MCP_BASE_URL || `${proto}://${host}`;
    const mcpAuthToken = process.env.SESSION_SECRET || "";

    let mcpUrl = `${dashboardUrl}/api/mcp`;
    if (filterNames && filterNames.length > 0) {
      mcpUrl += `?skills=${filterNames.join(",")}`;
    }

    mcpServers = {
      skills: {
        type: "http" as const,
        url: mcpUrl,
        headers: mcpAuthToken ? { Authorization: `Bearer ${mcpAuthToken}` } : {},
      },
    };
  }

  return { systemPromptPrefix: preloadContent, mcpServers };
}
