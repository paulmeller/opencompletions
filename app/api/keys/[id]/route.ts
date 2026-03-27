export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";

const WORKOS_API_KEY = process.env.WORKOS_API_KEY || "";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const res = await fetch(`https://api.workos.com/api_keys/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${WORKOS_API_KEY}` },
  });

  if (!res.ok) {
    return Response.json({ error: "Failed to delete key" }, { status: res.status });
  }

  return new Response(null, { status: 204 });
}
