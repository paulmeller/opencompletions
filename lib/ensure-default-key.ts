import { getSetting, setSetting } from "@/lib/db";

const WORKOS_API_KEY = process.env.WORKOS_API_KEY || "";
const SEED_CONFIG = process.env.SEED_CONFIG || "";

const globalForSeed = globalThis as typeof globalThis & { __ocSeeded?: boolean };

/**
 * Seed the DB from SEED_CONFIG env var if settings are empty.
 */
export function seedSettings(): void {
  if (!SEED_CONFIG) return;
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
 * Ensure the user has an active API key. Runs once per process.
 * If no key in DB, checks WorkOS for existing keys before creating one.
 */
export async function ensureDefaultKey(): Promise<void> {
  // Only run once per process lifetime
  if (globalForSeed.__ocSeeded) return;
  globalForSeed.__ocSeeded = true;

  seedSettings();

  if (getSetting("active_api_key")) return;
  if (!WORKOS_API_KEY) return;

  try {
    const orgId = process.env.WORKOS_ORG_ID || await discoverOrgId();
    if (!orgId) return;

    // Check if there are existing keys — reuse the first one if so
    // (we can't retrieve the value, but we know keys exist so skip creating)
    const listRes = await fetch(
      `https://api.workos.com/organizations/${orgId}/api_keys`,
      { headers: { Authorization: `Bearer ${WORKOS_API_KEY}` } },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const existingKeys = listData.data || [];
      if (existingKeys.length > 0) {
        console.log(`[seed] ${existingKeys.length} WorkOS key(s) exist but active_api_key not in DB. Creating a new one to store.`);
      }
    }

    // Create a new key (we need the value, which is only returned on creation)
    const res = await fetch(
      `https://api.workos.com/organizations/${orgId}/api_keys`,
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

async function discoverOrgId(): Promise<string | null> {
  try {
    const res = await fetch("https://api.workos.com/organizations?limit=1", {
      headers: { Authorization: `Bearer ${WORKOS_API_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.id || null;
  } catch {
    return null;
  }
}
