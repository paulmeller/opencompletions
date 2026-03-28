export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { enqueueAgent } from "@/lib/oc/queue";
import {
  extractAnthropicPrompt,
  buildAnthropicResponse,
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

  const { prompt, systemPrompt } = extractAnthropicPrompt(body as Parameters<typeof extractAnthropicPrompt>[0]);
  if (!prompt) {
    return Response.json(
      { error: { message: "messages array is required", type: "invalid_request_error", code: 400 } },
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

  const model = (body.model as string) || "claude-code";

  if (body.stream) {
    return streamAnthropicMessages(prompt, agentOpts, model);
  }
  return bufferedAnthropicMessages(prompt, agentOpts, model);
}

function streamAnthropicMessages(prompt: string, agentOpts: AgentOpts, model: string): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const sse = (event: string, data: unknown) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const handler = async () => {
    sse("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sse("ping", { type: "ping" });

    try {
      await enqueueAgent(prompt, {
        ...agentOpts,
        onEvent: (event: Record<string, unknown>) => {
          if (event.type === "assistant" && event.message) {
            const msg = event.message as { content?: Array<{ type: string; text?: string }> };
            const textBlocks = (msg.content || []).filter((b) => b.type === "text");
            for (const b of textBlocks) {
              if (b.text) {
                sse("content_block_delta", {
                  type: "content_block_delta", index: 0,
                  delta: { type: "text_delta", text: b.text },
                });
              }
            }
          }
        },
      });

      sse("content_block_stop", { type: "content_block_stop", index: 0 });
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
    } catch (err) {
      sse("error", { type: "error", error: { type: "server_error", message: (err as Error).message } });
    }

    sse("message_stop", { type: "message_stop" });
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

async function bufferedAnthropicMessages(prompt: string, agentOpts: AgentOpts, model: string): Promise<Response> {
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
    return Response.json(buildAnthropicResponse(resultText, model));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
