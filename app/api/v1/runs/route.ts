export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { listRuns } from "@/lib/db";

export async function GET(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  const result = listRuns({
    limit,
    offset,
    apiKeyId: searchParams.get("key_id") || undefined,
    orgId: auth.authContext?.orgId || searchParams.get("org_id") || undefined,
    status: searchParams.get("status") || undefined,
  });

  return Response.json(result);
}
