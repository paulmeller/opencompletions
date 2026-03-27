export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";
import { parseSkillMd } from "@/lib/parse-skill-md";
import { createSkill, updateSkill, getSkill } from "@/lib/db";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

interface ImportItem {
  skill_md: string;
  resources?: Record<string, string>;
  name?: string;
  upsert?: boolean;
  auto_apply?: boolean;
}

interface ImportResult {
  name: string;
  status: "created" | "updated" | "error";
  error?: string;
}

function processItem(item: ImportItem): ImportResult {
  if (!item.skill_md || typeof item.skill_md !== "string") {
    return { name: "", status: "error", error: "skill_md is required and must be a string" };
  }

  const parsed = parseSkillMd(item.skill_md);

  // Determine slug
  const slug = item.name || parsed.slug;
  if (!slug) {
    return { name: "", status: "error", error: "Could not determine skill name. Provide a 'name' field or add 'name:' to frontmatter." };
  }
  if (!NAME_RE.test(slug)) {
    return { name: slug, status: "error", error: `Invalid name "${slug}". Must be lowercase alphanumeric with hyphens (e.g. "contract-risk-analyzer").` };
  }

  // Convert resources map to array
  const resources = item.resources
    ? Object.entries(item.resources).map(([file_name, content]) => ({ file_name, content }))
    : [];

  // auto_apply: explicit item field takes precedence, then parsed frontmatter
  const autoApply = item.auto_apply !== undefined ? item.auto_apply : parsed.autoApply;

  const input = {
    name: slug,
    display_name: parsed.displayName || slug,
    description: parsed.description || "",
    instructions: parsed.instructions,
    tags: parsed.tags,
    resources,
    auto_apply: autoApply,
  };

  const existing = getSkill(slug);

  if (existing) {
    if (item.upsert) {
      updateSkill(slug, input);
      return { name: slug, status: "updated" };
    }
    return { name: slug, status: "error", error: `Skill "${slug}" already exists. Set upsert: true to overwrite.` };
  }

  createSkill(input);
  return { name: slug, status: "created" };
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Accept single item or array
  const items: ImportItem[] = Array.isArray(body) ? body : [body as ImportItem];

  if (items.length === 0) {
    return Response.json(
      { error: { message: "Empty request", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const results: ImportResult[] = [];
  for (const item of items) {
    try {
      results.push(processItem(item));
    } catch (err) {
      results.push({
        name: item.name || "",
        status: "error",
        error: (err as Error).message,
      });
    }
  }

  // For single imports, use appropriate status code
  if (!Array.isArray(body)) {
    const r = results[0];
    if (r.status === "error") {
      const code = r.error?.includes("already exists") ? 409 : 400;
      return Response.json({ error: { message: r.error, type: "invalid_request_error" } }, { status: code });
    }
    return Response.json(
      { name: r.name, status: r.status },
      { status: r.status === "created" ? 201 : 200 },
    );
  }

  return Response.json({ results });
}
