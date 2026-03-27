import { getSetting, setSetting } from "@/lib/db";

const WORKOS_API_KEY = process.env.WORKOS_API_KEY || "";
const ORG_ID = process.env.WORKOS_ORG_ID || "org_01KA6B78CC8NMS5GK1VK5FYAP1";
const SEED_CONFIG = process.env.SEED_CONFIG || "";

/**
 * Seed the DB from SEED_CONFIG env var if settings are empty.
 * SEED_CONFIG is a JSON object mapping setting fields to values.
 * Called once on first dashboard page load after a deploy wipes the DB.
 */
export function seedSettings(): void {
  if (!SEED_CONFIG) return;
  // Skip if DB already has settings
  if (getSetting("active_api_key") || getSetting("backend")) return;

  try {
    const config = JSON.parse(SEED_CONFIG);
    const FIELD_MAP: Record<string, { key: string; type: "text" | "secret" }> = {
      claude_api_key: { key: "llm_key_claude_api", type: "secret" },
      claude_oauth_token: { key: "llm_key_claude_oauth", type: "secret" },
      openai_key: { key: "llm_key_openai", type: "secret" },
      gemini_key: { key: "llm_key_gemini", type: "secret" },
      backend: { key: "backend", type: "text" },
      cli: { key: "cli", type: "text" },
      sprite_token: { key: "sprite_token", type: "secret" },
      sprite_names: { key: "sprite_names", type: "text" },
      vercel_token: { key: "vercel_token", type: "secret" },
      vercel_team_id: { key: "vercel_team_id", type: "text" },
      vercel_project_id: { key: "vercel_project_id", type: "text" },
      vercel_snapshot_id: { key: "vercel_snapshot_id", type: "text" },
      concurrency: { key: "concurrency", type: "text" },
      timeout: { key: "timeout", type: "text" },
    };

    for (const [field, { key, type }] of Object.entries(FIELD_MAP)) {
      if (config[field]) {
        setSetting(key, String(config[field]), type);
      }
    }
    console.log("[seed] Settings seeded from SEED_CONFIG");
  } catch (err) {
    console.warn("[seed] Failed to parse SEED_CONFIG:", (err as Error).message);
  }
}

/**
 * Ensure the user has an active API key. If none is saved in the DB,
 * create a "Default" key via WorkOS and store it.
 */
export async function ensureDefaultKey(): Promise<void> {
  seedSettings();

  if (getSetting("active_api_key")) return;
  if (!WORKOS_API_KEY) return;

  try {
    const res = await fetch(
      `https://api.workos.com/organizations/${ORG_ID}/api_keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WORKOS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Default" }),
      }
    );

    if (!res.ok) return;

    const data = await res.json();
    const key = data.value;
    if (key) {
      setSetting("active_api_key", key, "secret");
      console.log("[seed] Default API key created and saved");
    }
  } catch {}
}
