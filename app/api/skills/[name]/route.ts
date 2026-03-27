export const runtime = "nodejs";

import { getSkill, updateSkill, deleteSkill } from "@/lib/db";
import { requireAuth } from "@/lib/require-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  const { name } = await params;
  const skill = getSkill(name);
  if (!skill) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return Response.json(skill);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  const { name } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { display_name, description, instructions, tags, resources } = body;

  const updated = updateSkill(name, {
    display_name,
    description,
    instructions,
    tags,
    resources,
  });

  if (!updated) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }

  return Response.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  const { name } = await params;
  const deleted = deleteSkill(name);
  if (!deleted) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
