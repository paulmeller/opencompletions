/**
 * Shared skill loading logic for all completion/agent endpoints.
 *
 * Resolves skill_filter and preload_skills fields, builds the system
 * prompt injection. On-demand skills (not auto-applied or preloaded)
 * are returned as remainingSkillNames for file-based writing by the
 * agent endpoint.
 */

import { getSkill, listSkillsByTags, listAutoApplySkills } from "@/lib/db";

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
  /** Skills in filter but NOT preloaded/auto-applied — for file-based writing */
  remainingSkillNames: string[];
}

const MAX_PRELOAD_SIZE = 100 * 1024; // 100KB

/**
 * Resolve skills and build the system prompt prefix.
 *
 * Returns the remaining skill names (from the filter) that were not
 * injected via auto-apply or preload. The caller can write these to
 * the workspace as files for on-demand discovery.
 */
export function resolveSkills(
  request: Request,
  skillFilter?: SkillFilter,
  preloadSkills?: PreloadSkill[],
): SkillLoadResult {
  // Auto-apply skills: inject skills with auto_apply=true
  // Skip if skill_filter has explicit empty names (opt-out)
  const skipAutoApply = skillFilter?.names !== undefined && skillFilter.names.length === 0 && !skillFilter.tags?.length;

  let autoApplyContent = "";
  const autoApplyNames = new Set<string>();

  if (!skipAutoApply) {
    const autoSkills = listAutoApplySkills();
    for (const skill of autoSkills) {
      let section = `## Skill: ${skill.display_name}\n\n${skill.instructions || ""}`;
      for (const r of skill.resources || []) {
        section += `\n\n### Reference: ${r.file_name}\n\n${r.content}`;
      }
      autoApplyContent += (autoApplyContent ? "\n\n---\n\n" : "") + section;
      autoApplyNames.add(skill.name);
    }
  }

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
        // Skip if already injected via auto-apply
        if (autoApplyNames.has(item.name)) {
          preloadedNames.add(item.name);
          continue;
        }
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

  // Compute remaining skill names: filter names minus preloaded and auto-applied
  const allInjectedNames = new Set([...preloadedNames, ...autoApplyNames]);
  let remainingSkillNames: string[] = [];
  if (filterNames) {
    remainingSkillNames = filterNames.filter((n) => !allInjectedNames.has(n));
  }

  const combinedPrefix = [autoApplyContent, preloadContent].filter(Boolean).join("\n\n---\n\n");
  return { systemPromptPrefix: combinedPrefix, remainingSkillNames };
}
