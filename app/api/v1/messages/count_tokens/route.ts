export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getConfig } from "@/lib/oc/config";
import { extractAnthropicPrompt } from "@/lib/oc/response-builders";

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
