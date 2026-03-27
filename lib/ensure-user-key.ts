import { getUserDefaultKey, setUserDefaultKey, getSetting, setSetting } from "@/lib/db";

const WORKOS_API_KEY = process.env.WORKOS_API_KEY || "";
const SEED_CONFIG = process.env.SEED_CONFIG || "";

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
 * Ensure the given user has a default API key.
 * If one exists in the DB, return it. Otherwise create one via WorkOS and store it.
 * Returns the key value, or null if provisioning is not possible.
 */
export async function ensureUserKey(userId: string): Promise<string | null> {
  // 1. Check DB for existing key
  const existing = getUserDefaultKey(userId);
  if (existing) return existing;

  if (!WORKOS_API_KEY) return null;

  try {
    // 2. Discover org ID
    const orgId = process.env.WORKOS_ORG_ID || (await discoverOrgId());
    if (!orgId) return null;

    // 3. Check if a "Default" key already exists in WorkOS
    const listRes = await fetch(
      `https://api.workos.com/organizations/${orgId}/api_keys`,
      {
        headers: { Authorization: `Bearer ${WORKOS_API_KEY}` },
      },
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const existingDefault = (listData.data || []).find(
        (k: any) => k.name === "Default",
      );
      if (existingDefault) {
        // Key exists in WorkOS but not in DB — we can't recover the value,
        // so just store the ID with a placeholder (value is only shown on create)
        return null;
      }
    }

    // 4. Create key via WorkOS API
    const res = await fetch(
      `https://api.workos.com/organizations/${orgId}/api_keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WORKOS_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Default" }),
      },
    );

    if (!res.ok) return null;

    const data = await res.json();
    const keyValue = data.value;
    const keyId = data.id;
    if (!keyValue) return null;

    // 4. Store encrypted in DB
    setUserDefaultKey(userId, keyId, keyValue);
    console.log(`[seed] Default API key created for user ${userId}`);
    return keyValue;
  } catch {
    return null;
  }
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
