export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { extractAnthropicPrompt } from "@/lib/oc/response-builders";

export async function POST(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

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

  // Rough estimate: ~4 characters per token
  const inputText = (systemPrompt || "") + (prompt || "");
  const inputTokens = Math.ceil(inputText.length / 4);

  return Response.json({ input_tokens: inputTokens });
}
