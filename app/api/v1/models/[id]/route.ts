export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { buildModelObject } from "@/lib/oc/response-builders";

const MODEL_NAME = "claude-code";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureInitialized();

  const { id } = await params;
  const modelId = decodeURIComponent(id);

  if (modelId === MODEL_NAME) {
    return Response.json(buildModelObject(MODEL_NAME));
  }

  return Response.json(
    {
      error: {
        message: `The model '${modelId}' does not exist`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    },
    { status: 404 },
  );
}
