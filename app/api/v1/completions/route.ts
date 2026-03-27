export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getConfig } from "@/lib/oc/config";
import { enqueue } from "@/lib/oc/queue";
import { buildOpenAIResponse } from "@/lib/oc/response-builders";
import { handleOpenAICompletionsStream } from "@/lib/oc/streaming";

export async function POST(request: Request) {
  await ensureInitialized();

  const authContext = await authenticateRequest(request);
  const config = getConfig();

  if (config.apiKey && !authContext) {
    return Response.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      { status: 401 },
    );
  }

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

  let p = typeof rawPrompt === "string" ? rawPrompt : (rawPrompt as string[]).join("\n");

  // FIM (fill-in-the-middle): wrap prefix + suffix for infill
  if (body.suffix) {
    p = `Complete the code that goes between <prefix> and <suffix>. Return ONLY the infill code, nothing else.\n\n<prefix>\n${p}\n</prefix>\n\n<suffix>\n${body.suffix}\n</suffix>`;
  }

  if (body.stream) {
    return handleOpenAICompletionsStream(
      p,
      (body.model as string) || null,
      forwardToken,
    );
  }

  try {
    const text = await enqueue(p, undefined, { token: forwardToken });
    return Response.json(buildOpenAIResponse(text, body.model as string, false));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
