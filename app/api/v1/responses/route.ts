export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { enqueue } from "@/lib/oc/queue";
import {
  extractResponsesPrompt,
  buildResponsesResponse,
} from "@/lib/oc/response-builders";
import { handleResponsesStream } from "@/lib/oc/streaming";

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

  if (body.stream) {
    return handleResponsesStream(
      prompt,
      systemPrompt,
      (body.model as string) || null,
      forwardToken,
    );
  }

  try {
    const text = await enqueue(prompt, systemPrompt ?? undefined, { token: forwardToken });
    return Response.json(buildResponsesResponse(text, body.model as string));
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
