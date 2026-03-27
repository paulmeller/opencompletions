import { withAuth } from "@workos-inc/authkit-nextjs";
import { timingSafeEqual } from "crypto";
import { getSetting } from "@/lib/db";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Dual-mode auth: Bearer token (machine) or WorkOS session (browser).
 * Returns { ok: true } or { ok: false, response: Response }.
 */
export async function requireAuth(
  request: Request
): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Mode 1: Bearer token (machine-to-machine)
  // Accept CONFIG_TOKEN, SESSION_SECRET (internal MCP), or active_api_key from DB
  const auth = request.headers.get("authorization");
  if (auth) {
    const token = auth.replace("Bearer ", "");
    const configToken = process.env.CONFIG_TOKEN || "";
    const sessionSecret = process.env.SESSION_SECRET || "";
    const activeKey = getSetting("active_api_key");
    if ((configToken && safeEqual(token, configToken))
      || (sessionSecret && safeEqual(token, sessionSecret))
      || (activeKey && safeEqual(token, activeKey))) {
      return { ok: true };
    }
  }

  // Mode 2: WorkOS session cookie (browser)
  try {
    const { user } = await withAuth();
    if (user) return { ok: true };
  } catch {}

  return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
}
