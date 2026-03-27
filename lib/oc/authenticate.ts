/**
 * Unified auth for v1 API routes.
 * Accepts Bearer token (external API consumers) via authenticateRequest().
 * Returns true if authorized, or a 401 Response if not.
 */

import { authenticateRequest } from "@/lib/oc/auth-api";
import type { AuthContext } from "@/lib/oc/types";

export async function authorize(
  request: Request,
): Promise<{ ok: true; authContext: AuthContext | null } | { ok: false; response: Response }> {
  // Try API key auth (Bearer token — WorkOS API key or admin bypass)
  const authContext = await authenticateRequest(request);
  if (authContext) return { ok: true, authContext };

  // Unauthorized
  return {
    ok: false,
    response: Response.json(
      { error: { message: "Unauthorized", type: "authentication_error", code: 401 } },
      { status: 401 },
    ),
  };
}
