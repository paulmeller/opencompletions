export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getRunStats } from "@/lib/db";
import { getState } from "@/lib/oc/state";
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
  const since = searchParams.get("since")
    ? parseInt(searchParams.get("since")!, 10)
    : undefined;

  const stats = getRunStats({
    apiKeyId: searchParams.get("key_id") || undefined,
    orgId: authContext?.orgId || searchParams.get("org_id") || undefined,
    since,
  });

  const state = getState();

  return Response.json({
    ...stats,
    active_workers: state.activeWorkers,
    queued: state.queue.length,
    max_concurrency: config.concurrency,
    backend: config.backend,
  });
}
