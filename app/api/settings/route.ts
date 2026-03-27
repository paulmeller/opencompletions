export const runtime = "nodejs";

import { requireAuth } from "@/lib/require-auth";
import { listSettings, setSetting } from "@/lib/db";
import { invalidateConfigCache } from "@/lib/oc/config";

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;
  return Response.json(listSettings());
}

// Setting keys and their types
const SETTING_FIELDS: Record<string, { key: string; type: "text" | "secret" }> = {
  // LLM keys
  claude_api_key: { key: "llm_key_claude_api", type: "secret" },
  claude_oauth_token: { key: "llm_key_claude_oauth", type: "secret" },
  openai_key: { key: "llm_key_openai", type: "secret" },
  gemini_key: { key: "llm_key_gemini", type: "secret" },
  // Active API key (WorkOS key used by playground)
  active_api_key: { key: "active_api_key", type: "secret" },
  // Backend config
  backend: { key: "backend", type: "text" },
  cli: { key: "cli", type: "text" },
  sprite_token: { key: "sprite_token", type: "secret" },
  sprite_names: { key: "sprite_names", type: "text" },
  vercel_token: { key: "vercel_token", type: "secret" },
  vercel_team_id: { key: "vercel_team_id", type: "text" },
  vercel_project_id: { key: "vercel_project_id", type: "text" },
  vercel_snapshot_id: { key: "vercel_snapshot_id", type: "text" },
  cloudflare_account_id: { key: "cloudflare_account_id", type: "text" },
  cloudflare_api_token: { key: "cloudflare_api_token", type: "secret" },
  cloudflare_api_url: { key: "cloudflare_api_url", type: "text" },
  // Server config
  api_key: { key: "api_key", type: "secret" },
  concurrency: { key: "concurrency", type: "text" },
  timeout: { key: "timeout", type: "text" },
  queue_depth: { key: "queue_depth", type: "text" },
  agent_max_turns: { key: "agent_max_turns", type: "text" },
  agent_timeout: { key: "agent_timeout", type: "text" },
  setup_commands: { key: "setup_commands", type: "text" },
};

// Fields that can only be modified by dashboard users (WorkOS session),
// not via external API keys. These execute arbitrary commands on backends.
const ADMIN_ONLY_FIELDS = ["setup_commands"];

export async function PUT(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Guard admin-only fields: require WorkOS session (not just API key)
  for (const field of ADMIN_ONLY_FIELDS) {
    if (body[field] !== undefined) {
      try {
        const { withAuth } = await import("@workos-inc/authkit-nextjs");
        const { user } = await withAuth();
        if (!user) {
          return Response.json(
            { error: "Setup commands can only be modified by dashboard users" },
            { status: 403 },
          );
        }
      } catch {
        return Response.json(
          { error: "Setup commands can only be modified by dashboard users" },
          { status: 403 },
        );
      }
    }
  }

  for (const [field, { key, type }] of Object.entries(SETTING_FIELDS)) {
    if (body[field] !== undefined && body[field] !== "") {
      setSetting(key, String(body[field]), type);
    }
  }

  invalidateConfigCache();

  return Response.json(listSettings());
}
