export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { enqueueAgent } from "@/lib/oc/queue";
import { buildOpenAIResponse } from "@/lib/oc/response-builders";
import { normalizeResponseFormat } from "@/lib/oc/helpers";
import { resolveSkills } from "@/lib/oc/skill-loader";
import type { SkillFilter, PreloadSkill } from "@/lib/oc/skill-loader";
import type { AgentOpts } from "@/lib/oc/types";
import { randomUUID } from "crypto";

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

  const rawPrompt = body.prompt;
  if (!rawPrompt) {
    return Response.json(
      { error: { message: "prompt is required", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  let prompt = typeof rawPrompt === "string" ? rawPrompt : (rawPrompt as string[]).join("\n");
  if (body.suffix) {
    prompt = `Complete the code that goes between <prefix> and <suffix>. Return ONLY the infill code, nothing else.\n\n<prefix>\n${prompt}\n</prefix>\n\n<suffix>\n${body.suffix}\n</suffix>`;
  }

  const config = getConfig();
  const skillFilter = body.skill_filter as SkillFilter | undefined;
  const preloadSkills = body.preload_skills as PreloadSkill[] | undefined;
  const { systemPromptPrefix, mcpServers } = resolveSkills(request, skillFilter, preloadSkills);

  const agentOpts: AgentOpts = {
    prompt,
    systemPrompt: systemPromptPrefix || undefined,
    maxTurns: (body.max_turns as number) || config.agentMaxTurns,
    model: (body.model as string) || undefined,
    clientToken: forwardToken || undefined,
    backend: config.backend,
    responseFormat: normalizeResponseFormat(body.response_format as string | { type: string } | undefined),
    mcpServers: mcpServers || undefined,
  };

  const model = (body.model as string) || "claude-code";

  if (body.stream) {
    return streamOpenAICompletions(prompt, agentOpts, model);
  }
  return bufferedOpenAICompletions(prompt, agentOpts, model);
}

function streamOpenAICompletions(prompt: string, agentOpts: AgentOpts, model: string): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const id = `cmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const handler = async () => {
    try {
      await enqueueAgent(prompt, {
        ...agentOpts,
        onEvent: (event: Record<string, unknown>) => {
          if (event.type === "assistant" && event.message) {
            const msg = event.message as { content?: Array<{ type: string; text?: string }> };
            const textBlocks = (msg.content || []).filter((b) => b.type === "text");
            for (const b of textBlocks) {
              if (b.text) {
                writer.write(encoder.encode(`data: ${JSON.stringify({
                  id, object: "text_completion", created, model,
                  choices: [{ index: 0, text: b.text, finish_reason: null }],
                })}\n\n`));
              }
            }
          }
        },
      });

      writer.write(encoder.encode(`data: ${JSON.stringify({
        id, object: "text_completion", created, model,
        choices: [{ index: 0, text: "", finish_reason: "stop" }],
      })}\n\n`));
    } catch (err) {
      writer.write(encoder.encode(`data: ${JSON.stringify({
        error: { message: (err as Error).message, type: "server_error" },
      })}\n\n`));
    }

    writer.write(encoder.encode("data: [DONE]\n\n"));
    writer.close();
  };

  handler().catch(() => { try { writer.close(); } catch {} });

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

async function bufferedOpenAICompletions(prompt: string, agentOpts: AgentOpts, model: string): Promise<Response> {
  let resultText = "";
  try {
    await enqueueAgent(prompt, {
      ...agentOpts,
      onEvent: (event: Record<string, unknown>) => {
        if (event.type === "assistant" && event.message) {
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          const textBlocks = (msg.content || []).filter((b) => b.type === "text");
          if (textBlocks.length > 0) resultText = textBlocks.map((b) => b.text).join("\n");
        }
        if (event.type === "result" && event.result) resultText = event.result as string;
      },
    });
    return Response.json(buildOpenAIResponse(resultText, model, false));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
