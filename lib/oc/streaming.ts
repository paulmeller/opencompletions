/**
 * Agent SSE streaming and buffered handlers for Next.js Web Streams API.
 *
 * Each streaming handler returns a Response with a ReadableStream body.
 */

import { enqueueAgent } from "./queue";
import { applyJsonFormat } from "./helpers";
import { corsHeaders } from "./cors";
import type { AgentOpts } from "./types";

// ---------------------------------------------------------------------------
// SSE helpers (Web Streams)
// ---------------------------------------------------------------------------

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
      ...corsHeaders(),
    },
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
