export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getConfig } from "@/lib/oc/config";
import { buildEmbeddingResponse } from "@/lib/oc/response-builders";

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

  const input = body.input;
  if (!input) {
    return Response.json(
      { error: { message: "input is required", type: "invalid_request_error", code: 400 } },
      { status: 400 },
    );
  }

  // Normalize to array
  const inputs = Array.isArray(input) ? input : [input];

  return Response.json(buildEmbeddingResponse(inputs as Array<string | unknown>, body.model as string));
}
