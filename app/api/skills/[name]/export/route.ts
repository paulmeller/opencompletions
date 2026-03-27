export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";
import { getSkill } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  const { name } = await params;
  const skill = getSkill(decodeURIComponent(name));

  if (!skill) {
    return Response.json(
      { error: { message: "Skill not found", type: "not_found" } },
      { status: 404 },
    );
  }

  // Reconstruct SKILL.md format
  const frontmatter = [
    "---",
    `name: ${skill.display_name}`,
    `slug: ${skill.name}`,
    `description: ${skill.description}`,
    `tags: [${(JSON.parse(skill.tags || "[]") as string[]).join(", ")}]`,
    "---",
  ].join("\n");

  const skillMd = `${frontmatter}\n\n${skill.instructions || ""}`.trim();

  // Build resources map
  const resources: Record<string, string> = {};
  for (const r of skill.resources || []) {
    resources[r.file_name] = r.content;
  }

  return Response.json({
    skill_md: skillMd,
    resources,
  });
}
