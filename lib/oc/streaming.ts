/**
 * SSE streaming handlers adapted for Next.js Web Streams API.
 *
 * Each handler returns a Response with a ReadableStream body.
 * Ported from server.js lines 2170-2485.
 */

import { randomUUID } from "crypto";
import { enqueue, enqueueAgent } from "./queue";
import { applyJsonFormat } from "./helpers";
import type { AgentOpts } from "./types";

const MODEL_NAME = "claude-code";

// ---------------------------------------------------------------------------
// SSE helpers (Web Streams)
// ---------------------------------------------------------------------------

function sseData(writer: WritableStreamDefaultWriter, encoder: TextEncoder, data: unknown) {
  writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

function sseEvent(writer: WritableStreamDefaultWriter, encoder: TextEncoder, event: string, data: unknown) {
  writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function createSSEResponse(
  handler: (writer: WritableStreamDefaultWriter, encoder: TextEncoder, signal: AbortSignal) => Promise<void>,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const abortController = new AbortController();

  handler(writer, encoder, abortController.signal)
    .catch(() => {})
    .finally(() => {
      try { writer.close(); } catch {}
    });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions stream
// ---------------------------------------------------------------------------

export function handleOpenAIChatStream(
  prompt: string,
  systemPrompt: string | null,
  model: string | null,
  clientToken: string | null,
): Response {
  return createSSEResponse(async (writer, encoder) => {
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const m = model || MODEL_NAME;

    // Initial role chunk
    sseData(writer, encoder, {
      id, object: "chat.completion.chunk", created, model: m,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    try {
      await enqueue(prompt, systemPrompt ?? undefined, {
        token: clientToken,
        onChunk: (text: string) => {
          sseData(writer, encoder, {
            id, object: "chat.completion.chunk", created, model: m,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        },
      });

      sseData(writer, encoder, {
        id, object: "chat.completion.chunk", created, model: m,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } catch (err) {
      sseData(writer, encoder, {
        error: { message: (err as Error).message, type: "server_error" },
      });
    }

    writer.write(encoder.encode("data: [DONE]\n\n"));
  });
}

// ---------------------------------------------------------------------------
// OpenAI Completions stream (legacy)
// ---------------------------------------------------------------------------

export function handleOpenAICompletionsStream(
  prompt: string,
  model: string | null,
  clientToken: string | null,
): Response {
  return createSSEResponse(async (writer, encoder) => {
    const id = `cmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const m = model || MODEL_NAME;

    try {
      await enqueue(prompt, undefined, {
        token: clientToken,
        onChunk: (text: string) => {
          sseData(writer, encoder, {
            id, object: "text_completion", created, model: m,
            choices: [{ index: 0, text, finish_reason: null }],
          });
        },
      });

      sseData(writer, encoder, {
        id, object: "text_completion", created, model: m,
        choices: [{ index: 0, text: "", finish_reason: "stop" }],
      });
    } catch (err) {
      sseData(writer, encoder, {
        error: { message: (err as Error).message, type: "server_error" },
      });
    }

    writer.write(encoder.encode("data: [DONE]\n\n"));
  });
}

// ---------------------------------------------------------------------------
// Anthropic Messages stream
// ---------------------------------------------------------------------------

export function handleAnthropicStream(
  prompt: string,
  systemPrompt: string | null,
  model: string | null,
  clientToken: string | null,
): Response {
  return createSSEResponse(async (writer, encoder) => {
    const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const m = model || MODEL_NAME;

    sseEvent(writer, encoder, "message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model: m,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    sseEvent(writer, encoder, "content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    });

    sseEvent(writer, encoder, "ping", { type: "ping" });

    try {
      await enqueue(prompt, systemPrompt ?? undefined, {
        token: clientToken,
        onChunk: (text: string) => {
          sseEvent(writer, encoder, "content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text },
          });
        },
      });

      sseEvent(writer, encoder, "content_block_stop", { type: "content_block_stop", index: 0 });
      sseEvent(writer, encoder, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
    } catch (err) {
      sseEvent(writer, encoder, "error", {
        type: "error", error: { type: "server_error", message: (err as Error).message },
      });
    }

    sseEvent(writer, encoder, "message_stop", { type: "message_stop" });
  });
}

// ---------------------------------------------------------------------------
// Responses stream (OpenAI responses API format)
// ---------------------------------------------------------------------------

export function handleResponsesStream(
  prompt: string,
  systemPrompt: string | null,
  model: string | null,
  clientToken: string | null,
): Response {
  return createSSEResponse(async (writer, encoder) => {
    const id = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const m = model || MODEL_NAME;
    let fullText = "";

    try {
      await enqueue(prompt, systemPrompt ?? undefined, {
        token: clientToken,
        onChunk: (text: string) => {
          fullText += text;
          sseEvent(writer, encoder, "response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: 0, content_index: 0, delta: text,
          });
        },
      });

      sseEvent(writer, encoder, "response.output_text.done", {
        type: "response.output_text.done",
        output_index: 0, content_index: 0, text: fullText,
      });

      sseEvent(writer, encoder, "response.completed", {
        type: "response.completed",
        response: {
          id, object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: fullText }] }],
          model: m,
        },
      });
    } catch (err) {
      sseEvent(writer, encoder, "error", {
        type: "error", error: { type: "server_error", message: (err as Error).message },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Agent SSE stream
// ---------------------------------------------------------------------------

export function handleAgentStream(
  prompt: string,
  agentOpts: AgentOpts & { _beforeEvent?: (event: Record<string, unknown>) => void },
): Response {
  return createSSEResponse(async (writer, encoder, signal) => {
    const keepalive = setInterval(() => {
      // Send as data event (not SSE comment) so proxies like Cloudflare
      // recognize it as response activity and don't enforce idle timeouts.
      // SSE comments (":ping") are not treated as data by some CDN/proxies.
      try { writer.write(encoder.encode("data: {\"type\":\"ping\"}\n\n")); } catch {}
    }, 15000);

    let aborted = false;
    const onAbort = () => { aborted = true; clearInterval(keepalive); };
    signal.addEventListener("abort", onAbort);

    agentOpts.abortSignal = signal;
    let streamedText = "";

    try {
      await enqueueAgent(prompt, {
        ...agentOpts,
        onEvent: (event: Record<string, unknown>) => {
          if (aborted) return;
          if (agentOpts._beforeEvent) agentOpts._beforeEvent(event);

          // Accumulate assistant text for JSON post-processing
          if (agentOpts.responseFormat === "json" && event.type === "assistant" && event.message) {
            const msg = event.message as { content?: Array<{ type: string; text?: string }> };
            const textBlocks = (msg.content || []).filter((b) => b.type === "text");
            for (const b of textBlocks) { if (b.text) streamedText += b.text; }
          }

          // Inject workspace info into result events
          if (event.type === "result" && agentOpts.workspaceId) {
            event = { ...event, workspace_id: agentOpts.workspaceId };
          }

          // Post-process result for JSON response format
          if (event.type === "result" && agentOpts.responseFormat === "json") {
            const source = (event.result as string) || streamedText;
            if (source) {
              const formatted = applyJsonFormat(source);
              event = { ...event, result: formatted.result };
              if (formatted.json_error) (event as Record<string, unknown>).json_error = formatted.json_error;
            }
          }

          sseEvent(writer, encoder, (event.type as string) || "message", event);
        },
      });

      if (!aborted) {
        writer.write(encoder.encode("event: done\ndata: [DONE]\n\n"));
      }
    } catch (err) {
      if (!aborted) {
        sseEvent(writer, encoder, "error", {
          type: "error", error: { message: (err as Error).message, type: "server_error" },
        });
        writer.write(encoder.encode("event: done\ndata: [DONE]\n\n"));
      }
    } finally {
      clearInterval(keepalive);
    }
  });
}

// ---------------------------------------------------------------------------
// Agent buffered (non-streaming)
// ---------------------------------------------------------------------------

export async function handleAgentBuffered(
  prompt: string,
  agentOpts: AgentOpts & { _beforeEvent?: (event: Record<string, unknown>) => void },
): Promise<Response> {
  const events: Record<string, unknown>[] = [];
  let sessionId: string | null = null;
  let totalCostUsd = 0;
  let numTurns = 0;
  let resultText = "";
  let usage: Record<string, unknown> = {};

  try {
    await enqueueAgent(prompt, {
      ...agentOpts,
      onEvent: (event: Record<string, unknown>) => {
        events.push(event);
        if (agentOpts._beforeEvent) agentOpts._beforeEvent(event);

        if (event.type === "system" && event.subtype === "init") {
          sessionId = event.session_id as string;
        }
        if (event.type === "result") {
          sessionId = (event.session_id as string) || sessionId;
          totalCostUsd = (event.total_cost_usd as number) || 0;
          numTurns = (event.num_turns as number) || 0;
          usage = (event.usage as Record<string, unknown>) || {};
          resultText = (event.result as string) || resultText;
        }
        if (event.type === "assistant" && event.message) {
          const msg = event.message as { content?: Array<{ type: string; text?: string }> };
          const textBlocks = (msg.content || []).filter((b) => b.type === "text");
          if (textBlocks.length > 0) {
            resultText = textBlocks.map((b) => b.text).join("\n");
          }
        }
      },
    });

    let jsonError: string | undefined;
    if (agentOpts.responseFormat === "json") {
      const formatted = applyJsonFormat(resultText);
      resultText = formatted.result;
      jsonError = formatted.json_error;
    }

    const response: Record<string, unknown> = {
      session_id: sessionId,
      result: resultText,
      num_turns: numTurns,
      total_cost_usd: totalCostUsd,
      usage, events,
    };
    if (agentOpts.workspaceId) response.workspace_id = agentOpts.workspaceId;
    if (jsonError) response.json_error = jsonError;

    return Response.json(response);
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
