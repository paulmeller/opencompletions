export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";
import { deleteSetting } from "@/lib/db";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  const { key } = await params;
  const deleted = deleteSetting(key);
  if (!deleted) {
    return Response.json({ error: "Setting not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
