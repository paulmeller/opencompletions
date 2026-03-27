export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { getState } from "@/lib/oc/state";
import { getConfig } from "@/lib/oc/config";

export async function GET() {
  await ensureInitialized();

  const state = getState();
  const config = getConfig();

  return Response.json({
    status: "ok",
    active_workers: state.activeWorkers,
    queued: state.queue.length,
    max_concurrency: config.concurrency,
    backend: config.backend,
  });
}
