export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { enqueue } from "@/lib/oc/queue";
import { getConfig } from "@/lib/oc/config";
import { getSkill, listSkillsByTags } from "@/lib/db";
import {
  extractOpenAIChatPrompt,
  buildOpenAIResponse,
} from "@/lib/oc/response-builders";
import { handleOpenAIChatStream, handleAgentStream, handleAgentBuffered } from "@/lib/oc/streaming";
import { normalizeResponseFormat } from "@/lib/oc/helpers";
import type { AgentOpts } from "@/lib/oc/types";

export async function POST(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const forwardToken = request.headers.get("x-api-key") || null;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  const { prompt, systemPrompt } = extractOpenAIChatPrompt(body as Parameters<typeof extractOpenAIChatPrompt>[0]);

  if (!prompt) {
    return Response.json(
      { error: { message: "messages array is required", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  // Check if skills or tools are requested — route through agent pipeline
  const skillFilter = body.skill_filter as { names?: string[]; tags?: string[] } | undefined;
  const preloadSkills = body.preload_skills as Array<{
    name?: string;
    instructions?: string;
    resources?: Record<string, string>;
  }> | undefined;
  const hasSkills = skillFilter || preloadSkills?.length;

  if (hasSkills) {
    // Route through agent pipeline for skill/tool support
    return handleWithAgent(request, body, prompt, systemPrompt, forwardToken, skillFilter, preloadSkills);
  }

  // Simple path — no skills, direct CLI call
  if (body.stream) {
    return handleOpenAIChatStream(
      prompt,
      systemPrompt,
      (body.model as string) || null,
      forwardToken,
    );
  }

  try {
    const text = await enqueue(prompt, systemPrompt ?? undefined, { token: forwardToken });
    return Response.json(buildOpenAIResponse(text, body.model as string, true));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Agent pipeline for skill-aware requests
// ---------------------------------------------------------------------------

async function handleWithAgent(
  request: Request,
  body: Record<string, unknown>,
  prompt: string,
  systemPrompt: string | null,
  forwardToken: string | null,
  skillFilter?: { names?: string[]; tags?: string[] },
  preloadSkills?: Array<{ name?: string; instructions?: string; resources?: Record<string, string> }>,
): Promise<Response> {
  const config = getConfig();

  // Build system prompt with preloaded skills
  let finalSystemPrompt = systemPrompt || undefined;

  // Resolve skill filter
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
  const MAX_PRELOAD_SIZE = 100 * 1024;
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
    if (preloadContent) {
      finalSystemPrompt = finalSystemPrompt
        ? `${preloadContent}\n\n${finalSystemPrompt}`
        : preloadContent;
    }
  }

  // Deduplicate
  if (filterNames && preloadedNames.size > 0) {
    filterNames = filterNames.filter((n) => !preloadedNames.has(n));
  }

  // Build MCP config
  const host = request.headers.get("x-forwarded-host")
    || request.headers.get("host")
    || `localhost:${process.env.PORT || 3000}`;
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const dashboardUrl = process.env.MCP_BASE_URL || `${proto}://${host}`;
  const mcpAuthToken = process.env.SESSION_SECRET || "";

  let mcpServers: Record<string, unknown> | undefined;
  const shouldInjectMcp = !preloadSkills?.length || (filterNames && filterNames.length > 0) || !skillFilter;
  if (shouldInjectMcp) {
    let mcpUrl = `${dashboardUrl}/api/mcp`;
    if (filterNames && filterNames.length > 0) {
      mcpUrl += `?skills=${filterNames.join(",")}`;
    }
    mcpServers = {
      skills: {
        type: "http",
        url: mcpUrl,
        headers: mcpAuthToken ? { Authorization: `Bearer ${mcpAuthToken}` } : {},
      },
    };
  }

  const agentOpts: AgentOpts = {
    prompt,
    systemPrompt: finalSystemPrompt,
    maxTurns: (body.max_turns as number) || config.agentMaxTurns,
    model: (body.model as string) || undefined,
    clientToken: forwardToken || undefined,
    backend: config.backend,
    responseFormat: normalizeResponseFormat(body.response_format as string | { type: string } | undefined),
    mcpServers: mcpServers as AgentOpts["mcpServers"],
  };

  if (body.stream !== false) {
    return handleAgentStream(prompt, agentOpts);
  }
  return handleAgentBuffered(prompt, agentOpts);
}
