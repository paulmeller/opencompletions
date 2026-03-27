export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getRun } from "@/lib/db";
import { getConfig } from "@/lib/oc/config";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureInitialized();

  const authContext = await authenticateRequest(request);
  const config = getConfig();

  if (config.apiKey && !authContext) {
    return Response.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      { status: 401 },
    );
  }

  const { id } = await params;
  const runId = decodeURIComponent(id);
  const run = getRun(runId);

  if (!run) {
    return Response.json(
      { error: { message: "Run not found", type: "not_found" } },
      { status: 404 },
    );
  }

  return Response.json(run);
}
