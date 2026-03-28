export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { enqueueAgent } from "@/lib/oc/queue";
import {
  extractOpenAIChatPrompt,
  buildOpenAIResponse,
} from "@/lib/oc/response-builders";
import { normalizeResponseFormat } from "@/lib/oc/helpers";
import { corsHeaders } from "@/lib/oc/cors";
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

  const { prompt, systemPrompt } = extractOpenAIChatPrompt(body as Parameters<typeof extractOpenAIChatPrompt>[0]);
  if (!prompt) {
    return Response.json(
      { error: { message: "messages array is required", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  const config = getConfig();
  const skillFilter = body.skill_filter as SkillFilter | undefined;
  const preloadSkills = body.preload_skills as PreloadSkill[] | undefined;
  const { systemPromptPrefix, remainingSkillNames } = resolveSkills(request, skillFilter, preloadSkills);

  if (remainingSkillNames.length > 0) {
    console.warn(`[chat/completions] ${remainingSkillNames.length} skill(s) not injected (no workspace for file-based delivery): ${remainingSkillNames.join(", ")}`);
  }

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
    mcpServers: (body.mcp_servers as AgentOpts["mcpServers"]) || undefined,
  };

  const model = (body.model as string) || "claude-code";

  if (body.stream) {
    // Stream: translate agent events to OpenAI chat completion chunks
    return streamOpenAIChat(prompt, agentOpts, model);
  }

  // Buffered: run agent, wrap result in OpenAI format
  return bufferedOpenAIChat(prompt, agentOpts, model);
}

function streamOpenAIChat(prompt: string, agentOpts: AgentOpts, model: string): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const handler = async () => {
    // Initial role chunk
    writer.write(encoder.encode(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`));

    try {
      await enqueueAgent(prompt, {
        ...agentOpts,
        onEvent: (event: Record<string, unknown>) => {
          // Extract text from assistant messages and send as OpenAI chunks
          if (event.type === "assistant" && event.message) {
            const msg = event.message as { content?: Array<{ type: string; text?: string }> };
            const textBlocks = (msg.content || []).filter((b) => b.type === "text");
            for (const b of textBlocks) {
              if (b.text) {
                writer.write(encoder.encode(`data: ${JSON.stringify({
                  id, object: "chat.completion.chunk", created, model,
                  choices: [{ index: 0, delta: { content: b.text }, finish_reason: null }],
                })}\n\n`));
              }
            }
          }
        },
      });

      // Stop chunk
      writer.write(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

async function bufferedOpenAIChat(prompt: string, agentOpts: AgentOpts, model: string): Promise<Response> {
  let resultText = "";

  try {
    await enqueueAgent(prompt, {
      ...agentOpts,
      onEvent: (event: Record<string, unknown>) => {
        if (event.type === "assistant" && event.message) {
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          const textBlocks = (msg.content || []).filter((b) => b.type === "text");
          if (textBlocks.length > 0) {
            resultText = textBlocks.map((b) => b.text).join("\n");
          }
        }
        if (event.type === "result" && event.result) {
          resultText = event.result as string;
        }
      },
    });

    return Response.json(buildOpenAIResponse(resultText, model, true));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
