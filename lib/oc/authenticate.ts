/**
 * Unified auth for v1 API routes.
 * Accepts either:
 *   - Bearer token (external API consumers) via authenticateRequest()
 *   - WorkOS session cookie (dashboard browser) via requireAuth()
 *
 * Returns true if authorized, or a 401 Response if not.
 */

import { authenticateRequest } from "@/lib/oc/auth-api";
import { requireAuth } from "@/lib/require-auth";
import { getConfig } from "@/lib/oc/config";
import type { AuthContext } from "@/lib/oc/types";

export async function authorize(
  request: Request,
): Promise<{ ok: true; authContext: AuthContext | null } | { ok: false; response: Response }> {
  // Try API key auth first (Bearer token)
  const authContext = await authenticateRequest(request);
  if (authContext) return { ok: true, authContext };

  // Try WorkOS session cookie (browser)
  const session = await requireAuth(request);
  if (session.ok) return { ok: true, authContext: null };

  // If no API key is configured, allow unauthenticated access
  const config = getConfig();
  if (!config.apiKey) return { ok: true, authContext: null };

  return {
    ok: false,
    response: Response.json(
      { error: { message: "Unauthorized", type: "authentication_error", code: 401 } },
      { status: 401 },
    ),
  };
}
