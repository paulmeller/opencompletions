/**
 * Per-request plugin installation.
 *
 * Runs `claude plugin install <name>` on the target backend before
 * spawning the agent. Safe on remote backends (sandboxed VMs).
 * Blocked on local backend unless allowlisted.
 */

import { execSync } from "child_process";
import { getConfig } from "./config";

// Plugin name validation: allows npm packages, scoped packages, and plugin@registry format
// No shell metacharacters (;|&$`(){}!#<> etc)
const PLUGIN_NAME_RE = /^@?[a-z0-9][\w.\-/@]*$/i;
const MAX_PLUGIN_NAME_LENGTH = 214;

function validatePluginName(name: string): boolean {
  if (!name || name.length > MAX_PLUGIN_NAME_LENGTH) return false;
  return PLUGIN_NAME_RE.test(name);
}

/**
 * Install plugins on the local backend.
 * Only runs if the plugin name is in the server's allowed_plugins list.
 */
export function installPluginsLocal(
  plugins: string[],
  cwd?: string,
): void {
  if (!plugins.length) return;

  for (const plugin of plugins) {
    if (!validatePluginName(plugin)) {
      console.warn(`[plugins] Invalid plugin name: "${plugin}", skipping`);
      continue;
    }
    console.log(`[plugins] Installing ${plugin} (local)...`);
    try {
      execSync(`claude plugin install ${plugin}`, {
        cwd,
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err: any) {
      // Plugin install is idempotent — non-zero exit may mean already installed
      console.warn(`[plugins] ${plugin}: ${err.message?.split("\n")[0]}`);
    }
  }
}

/**
 * Install plugins on a remote sprite.
 * Sprite is a sandboxed VM — safe to install anything.
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
 * Sandbox is ephemeral — plugins need to be installed per-sandbox.
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
          body: JSON.stringify({ command: ["bash", "-c", `claude plugin install ${plugin}`] }),
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
