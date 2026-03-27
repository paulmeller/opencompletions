export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getState } from "@/lib/oc/state";
import { getConfig } from "@/lib/oc/config";

export async function GET(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const config = getConfig();
  const state = getState();

  const available: string[] = ["local"];
  const details: Record<string, unknown> = {
    local: { status: "ready" },
  };

  if (state.spritePool.length > 0) {
    available.push("sprite");
    details.sprite = {
      status: "ready",
      pool_size: state.spritePool.length,
      busy: state.spritePool.reduce((s, sp) => s + sp.busy, 0),
    };
  }

  if (state.vercelPool.length > 0) {
    available.push("vercel");
    details.vercel = {
      status: "ready",
      pool_size: state.vercelPool.length,
      busy: state.vercelPool.reduce((s, sb) => s + sb.busy, 0),
    };
  }

  return Response.json({
    default: config.backend,
    available,
    details,
  });
}
