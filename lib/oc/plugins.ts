/**
 * Per-request plugin installation.
 *
 * Runs `claude plugin install <name>` on the target backend before
 * spawning the agent. Handles marketplace registration automatically
 * when plugin names contain @marketplace (e.g. document-skills@anthropic-agent-skills).
 *
 * Known marketplaces are auto-registered on first use:
 *   - anthropic-agent-skills → anthropics/skills
 */

import { execSync } from "child_process";
import { getConfig } from "./config";

// Plugin name validation: allows npm packages, scoped packages, and plugin@marketplace format
// No shell metacharacters (;|&$`(){}!#<> etc)
const PLUGIN_NAME_RE = /^@?[a-z0-9][\w.\-/@]*$/i;
const MAX_PLUGIN_NAME_LENGTH = 214;

// Known marketplaces: marketplace name → GitHub repo
const KNOWN_MARKETPLACES: Record<string, string> = {
  "anthropic-agent-skills": "anthropics/skills",
};

// Track which marketplaces have been registered this process
const registeredMarketplaces = new Set<string>();

function validatePluginName(name: string): boolean {
  if (!name || name.length > MAX_PLUGIN_NAME_LENGTH) return false;
  return PLUGIN_NAME_RE.test(name);
}

/**
 * Ensure a marketplace is registered. Idempotent — only runs once per process.
 */
function ensureMarketplace(marketplace: string, execOpts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): void {
  if (registeredMarketplaces.has(marketplace)) return;

  const repo = KNOWN_MARKETPLACES[marketplace];
  if (!repo) {
    console.warn(`[plugins] Unknown marketplace "${marketplace}", skipping registration`);
    return;
  }

  console.log(`[plugins] Registering marketplace ${marketplace} (${repo})...`);
  try {
    execSync(`claude plugin marketplace add ${repo}`, {
      ...execOpts,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    // May already be registered
    console.warn(`[plugins] Marketplace ${marketplace}: ${err.message?.split("\n")[0]}`);
  }
  registeredMarketplaces.add(marketplace);
}

/**
 * Ensure a marketplace is registered on a remote sprite.
 */
async function ensureMarketplaceSprite(marketplace: string, spriteName: string): Promise<void> {
  if (registeredMarketplaces.has(`sprite:${spriteName}:${marketplace}`)) return;

  const repo = KNOWN_MARKETPLACES[marketplace];
  if (!repo) return;

  const config = getConfig();
  console.log(`[plugins] Registering marketplace ${marketplace} on sprite ${spriteName}...`);
  try {
    const params = new URLSearchParams();
    params.append("cmd", "bash");
    params.append("cmd", "-c");
    params.append("cmd", `claude plugin marketplace add ${repo}`);
    const url = `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.spriteToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    console.warn(`[plugins] Marketplace ${marketplace} on ${spriteName}: ${err.message}`);
  }
  registeredMarketplaces.add(`sprite:${spriteName}:${marketplace}`);
}

/**
 * Install plugins on the local backend.
 * Auto-registers known marketplaces when plugin names contain @marketplace.
 */
export function installPluginsLocal(
  plugins: string[],
  cwd?: string,
): void {
  if (!plugins.length) return;

  const execOpts = { cwd, timeout: 60_000, env: process.env };

  for (const plugin of plugins) {
    if (!validatePluginName(plugin)) {
      console.warn(`[plugins] Invalid plugin name: "${plugin}", skipping`);
      continue;
    }

    // Auto-register marketplace if plugin@marketplace format
    const atIdx = plugin.indexOf("@", plugin.startsWith("@") ? 1 : 0);
    if (atIdx > 0) {
      const marketplace = plugin.slice(atIdx + 1);
      ensureMarketplace(marketplace, execOpts);
    }

    console.log(`[plugins] Installing ${plugin} (local)...`);
    try {
      execSync(`claude plugin install ${plugin}`, {
        ...execOpts,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      console.warn(`[plugins] ${plugin}: ${err.message?.split("\n")[0]}`);
    }
  }
}

/**
 * Install plugins on a remote sprite.
 */
export async function installPluginsSprite(
  plugins: string[],
  spriteName: string,
): Promise<void> {
  if (!plugins.length) return;
  const config = getConfig();

  for (const plugin of plugins) {
    if (!validatePluginName(plugin)) {
      console.warn(`[plugins] Invalid plugin name: "${plugin}", skipping`);
      continue;
    }

    // Auto-register marketplace
    const atIdx = plugin.indexOf("@", plugin.startsWith("@") ? 1 : 0);
    if (atIdx > 0) {
      const marketplace = plugin.slice(atIdx + 1);
      await ensureMarketplaceSprite(marketplace, spriteName);
    }

    console.log(`[plugins] Installing ${plugin} on sprite ${spriteName}...`);
    try {
      const params = new URLSearchParams();
      params.append("cmd", "bash");
      params.append("cmd", "-c");
      params.append("cmd", `claude plugin install ${plugin}`);
      const url = `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.spriteToken}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        console.warn(`[plugins] ${plugin} on ${spriteName}: HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`[plugins] ${plugin} on ${spriteName}: ${err.message}`);
    }
  }
}

/**
 * Install plugins on a Vercel sandbox.
 */
export async function installPluginsVercel(
  plugins: string[],
  sandboxId: string,
): Promise<void> {
  if (!plugins.length) return;
  const config = getConfig();

  for (const plugin of plugins) {
    if (!validatePluginName(plugin)) {
      console.warn(`[plugins] Invalid plugin name: "${plugin}", skipping`);
      continue;
    }

    // For vercel, combine marketplace registration + plugin install in one command
    const atIdx = plugin.indexOf("@", plugin.startsWith("@") ? 1 : 0);
    let cmds = `claude plugin install ${plugin}`;
    if (atIdx > 0) {
      const marketplace = plugin.slice(atIdx + 1);
      const repo = KNOWN_MARKETPLACES[marketplace];
      if (repo) {
        cmds = `claude plugin marketplace add ${repo} 2>/dev/null; claude plugin install ${plugin}`;
      }
    }

    console.log(`[plugins] Installing ${plugin} on vercel sandbox ${sandboxId}...`);
    try {
      const res = await fetch(
        `https://api.vercel.com/v1/sandboxes/${sandboxId}/cmd?teamId=${encodeURIComponent(config.vercelTeamId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.vercelToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ command: ["bash", "-c", cmds] }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) {
        console.warn(`[plugins] ${plugin} on vercel ${sandboxId}: HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn(`[plugins] ${plugin} on vercel ${sandboxId}: ${err.message}`);
    }
  }
}
