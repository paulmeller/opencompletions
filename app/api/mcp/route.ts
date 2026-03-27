export const runtime = "nodejs";

import { listSkills, getSkill, getSkillResource } from "@/lib/db";
import { requireAuth } from "@/lib/require-auth";

const SERVER_INFO = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "opencompletions-skills", version: "1.0.0" },
};

const TOOLS = [
  {
    name: "list_skills",
    description: "List all available skills",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "activate_skill",
    description: "Get a skill's instructions/content by name",
    inputSchema: {
      type: "object" as const,
      properties: { skill_name: { type: "string", description: "The skill name (slug)" } },
      required: ["skill_name"],
    },
  },
  {
    name: "read_resource",
    description: "Read a reference file associated with a skill",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_name: { type: "string", description: "The skill name (slug)" },
        file_name: { type: "string", description: "The resource file name" },
      },
      required: ["skill_name", "file_name"],
    },
  },
];

function jsonRpcOk(id: number | string, result: unknown) {
  return Response.json({ jsonrpc: "2.0", result, id });
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id });
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function handleToolCall(name: string, args: Record<string, string>, allowedSkills: string[] | null) {
  switch (name) {
    case "list_skills": {
      let skills = listSkills();
      if (allowedSkills) {
        const allowed = new Set(allowedSkills);
        skills = skills.filter((s) => allowed.has(s.name));
      }
      const summary = skills.map((s) => ({
        name: s.name,
        display_name: s.display_name,
        description: s.description,
        tags: JSON.parse(s.tags || "[]"),
        resources: s.resources.map((r) => r.file_name),
      }));
      return toolResult(JSON.stringify(summary));
    }

    case "activate_skill": {
      const skillName = args.skill_name;
      if (!skillName) return toolResult("Missing skill_name parameter", true);
      if (allowedSkills && !allowedSkills.includes(skillName)) {
        return toolResult(`Skill "${skillName}" is not in the allowed skill list`, true);
      }
      const skill = getSkill(skillName);
      if (!skill) return toolResult(`Skill "${skillName}" not found`, true);
      return toolResult(skill.instructions || "(no instructions)");
    }

    case "read_resource": {
      const { skill_name, file_name } = args;
      if (!skill_name || !file_name)
        return toolResult("Missing skill_name or file_name parameter", true);
      if (allowedSkills && !allowedSkills.includes(skill_name)) {
        return toolResult(`Skill "${skill_name}" is not in the allowed skill list`, true);
      }
      const resource = getSkillResource(skill_name, file_name);
      if (!resource)
        return toolResult(
          `Resource "${file_name}" not found in skill "${skill_name}"`,
          true
        );
      return toolResult(resource.content);
    }

    default:
      return toolResult(`Unknown tool: ${name}`, true);
  }
}

export async function POST(request: Request) {
  // Auth: accept Bearer token or WorkOS session
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  // Parse optional skill filter from query params
  const url = new URL(request.url);
  const skillsParam = url.searchParams.get("skills");
  const allowedSkills = skillsParam ? skillsParam.split(",").filter(Boolean) : null;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (!("id" in body)) {
    return new Response(null, { status: 202 });
  }

  const { method, params, id } = body;

  switch (method) {
    case "initialize":
      return jsonRpcOk(id, SERVER_INFO);

    case "tools/list":
      return jsonRpcOk(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params?.name;
      if (!toolName) {
        return jsonRpcError(id, -32602, "Missing tool name");
      }
      const result = handleToolCall(toolName, params.arguments || {}, allowedSkills);
      return jsonRpcOk(id, result);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
