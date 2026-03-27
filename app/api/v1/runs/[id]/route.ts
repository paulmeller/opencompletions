export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getRun } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

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
