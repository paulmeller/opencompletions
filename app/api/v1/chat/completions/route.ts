export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { enqueue } from "@/lib/oc/queue";
import {
  extractOpenAIChatPrompt,
  buildOpenAIResponse,
} from "@/lib/oc/response-builders";
import { handleOpenAIChatStream } from "@/lib/oc/streaming";

export async function POST(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  // Forward x-api-key to the backend as the provider token
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
