export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { buildEmbeddingResponse } from "@/lib/oc/response-builders";

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
