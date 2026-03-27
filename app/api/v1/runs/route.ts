export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { listRuns } from "@/lib/db";
import { getConfig } from "@/lib/oc/config";

export async function GET(request: Request) {
  await ensureInitialized();

  const authContext = await authenticateRequest(request);
  const config = getConfig();

  if (config.apiKey && !authContext) {
    return Response.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  const result = listRuns({
    limit,
    offset,
    apiKeyId: searchParams.get("key_id") || undefined,
    orgId: authContext?.orgId || searchParams.get("org_id") || undefined,
    status: searchParams.get("status") || undefined,
  });

  return Response.json(result);
}
