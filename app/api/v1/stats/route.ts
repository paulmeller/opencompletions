export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getRunStats } from "@/lib/db";
import { getState } from "@/lib/oc/state";
import { getConfig } from "@/lib/oc/config";

export async function GET(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const config = getConfig();
  const { searchParams } = new URL(request.url);
  const since = searchParams.get("since")
    ? parseInt(searchParams.get("since")!, 10)
    : undefined;

  const stats = getRunStats({
    apiKeyId: searchParams.get("key_id") || undefined,
    orgId: auth.authContext?.orgId || searchParams.get("org_id") || undefined,
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
