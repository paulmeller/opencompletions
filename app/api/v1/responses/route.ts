export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { extractResponsesPrompt } from "@/lib/oc/response-builders";
import { handleAgentStream, handleAgentBuffered } from "@/lib/oc/streaming";
import { normalizeResponseFormat } from "@/lib/oc/helpers";
import { resolveSkills } from "@/lib/oc/skill-loader";
import type { SkillFilter, PreloadSkill } from "@/lib/oc/skill-loader";
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

  const { prompt, systemPrompt } = extractResponsesPrompt(body as Parameters<typeof extractResponsesPrompt>[0]);
  if (!prompt) {
    return Response.json(
      { error: { message: "input is required", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  const config = getConfig();
  const skillFilter = body.skill_filter as SkillFilter | undefined;
  const preloadSkills = body.preload_skills as PreloadSkill[] | undefined;
  const { systemPromptPrefix, mcpServers } = resolveSkills(request, skillFilter, preloadSkills);

  let finalSystemPrompt = systemPrompt || undefined;
  if (systemPromptPrefix) {
    finalSystemPrompt = finalSystemPrompt
      ? `${systemPromptPrefix}\n\n${finalSystemPrompt}`
      : systemPromptPrefix;
  }

  const agentOpts: AgentOpts = {
    prompt,
    systemPrompt: finalSystemPrompt,
    maxTurns: (body.max_turns as number) || config.agentMaxTurns,
    model: (body.model as string) || undefined,
    clientToken: forwardToken || undefined,
    backend: config.backend,
    responseFormat: normalizeResponseFormat(body.response_format as string | { type: string } | undefined),
    mcpServers: mcpServers || undefined,
  };

  if (body.stream !== false) {
    return handleAgentStream(prompt, agentOpts);
  }
  return handleAgentBuffered(prompt, agentOpts);
}
