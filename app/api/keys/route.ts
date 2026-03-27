export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";

const WORKOS_API_KEY = process.env.WORKOS_API_KEY || "";
const ORG_ID = process.env.WORKOS_ORG_ID || "org_01KA6B78CC8NMS5GK1VK5FYAP1";

async function workosRequest(path: string, opts: RequestInit = {}) {
  const res = await fetch(`https://api.workos.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${WORKOS_API_KEY}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  return res;
}

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const res = await workosRequest(`/organizations/${ORG_ID}/api_keys`);
  if (!res.ok) {
    return Response.json({ error: "Failed to list keys" }, { status: res.status });
  }
  const data = await res.json();
  return Response.json(data.data || []);
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name } = body;
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const res = await workosRequest(`/organizations/${ORG_ID}/api_keys`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return Response.json({ error: err.message || "Failed to create key" }, { status: res.status });
  }

  const data = await res.json();
  return Response.json(data.data || data, { status: 201 });
}
