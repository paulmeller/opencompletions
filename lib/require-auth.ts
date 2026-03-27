import { withAuth } from "@workos-inc/authkit-nextjs";
import { timingSafeEqual } from "crypto";
import { authenticateRequest } from "@/lib/oc/auth-api";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Auth for dashboard management routes (/api/keys, /api/settings, /api/skills, /api/mcp).
 * Accepts:
 *   1. WorkOS session cookie (browser) via withAuth()
 *   2. SESSION_SECRET env var as Bearer token (internal MCP from CLI)
 *   3. WorkOS API key via authenticateRequest() (external programmatic access)
 *
 * Returns { ok: true } or { ok: false, response: Response }.
 */
export async function requireAuth(
  request: Request
): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Mode 1: Bearer token
  const auth = request.headers.get("authorization");
  if (auth) {
    const token = auth.replace("Bearer ", "");

    // SESSION_SECRET (internal MCP from CLI)
    const sessionSecret = process.env.SESSION_SECRET || "";
    if (sessionSecret && safeEqual(token, sessionSecret)) {
      return { ok: true };
    }

    // WorkOS API key (external programmatic access)
    const authContext = await authenticateRequest(request);
    if (authContext) return { ok: true };
  }

  // Mode 2: WorkOS session cookie (browser)
  try {
    const { user } = await withAuth();
    if (user) return { ok: true };
  } catch {}

  return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
}
