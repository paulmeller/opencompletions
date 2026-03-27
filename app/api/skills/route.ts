export const runtime = "nodejs";

import { listSkills, createSkill } from "@/lib/db";
import { requireAuth } from "@/lib/require-auth";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  const skills = listSkills();
  return Response.json(skills);
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

  const { name, display_name, description, instructions, tags, resources, auto_apply } = body;

  if (!name || typeof name !== "string") {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (!NAME_RE.test(name)) {
    return Response.json(
      { error: "name must be lowercase alphanumeric with hyphens (e.g. my-skill)" },
      { status: 400 }
    );
  }

  try {
    const skill = createSkill({
      name,
      display_name,
      description,
      instructions,
      tags,
      resources,
      auto_apply,
    });
    return Response.json(skill, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("UNIQUE constraint")) {
      return Response.json(
        { error: `Skill "${name}" already exists` },
        { status: 409 }
      );
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
