/**
 * Setup commands module for the OpenCompletions engine.
 *
 * Runs one-time shell commands (e.g. `claude plugin install ...`) on backend
 * instances. Uses a content-addressed sentinel to skip re-runs when the
 * command list hasn't changed.
 */

import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getConfig } from "./config";

const SENTINEL_DIR = join(homedir(), ".opencompletions");
const SENTINEL_FILE = join(SENTINEL_DIR, ".setup-done");

/** Hash the command list so we re-run when it changes. */
function commandsHash(commands: string[]): string {
  return createHash("sha256").update(commands.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Run setup commands on the local machine.
 * Idempotent: skips if the sentinel matches the current command list hash.
 * @param force - If true, bypass sentinel check and re-run commands.
 * @returns true if all commands succeeded, false if any failed.
 */
export async function runLocalSetup(force = false): Promise<boolean> {
  const { setupCommands } = getConfig();
  if (setupCommands.length === 0) return true;

  const fingerprint = commandsHash(setupCommands);

  // Check sentinel
  if (!force) {
    try {
      if (existsSync(SENTINEL_FILE)) {
        const existing = readFileSync(SENTINEL_FILE, "utf-8").trim();
        if (existing === fingerprint) {
          console.log("[oc/setup] Local setup already done (sentinel matches), skipping.");
          return true;
        }
      }
    } catch {}
  }

  console.log(`[oc/setup] Running ${setupCommands.length} setup command(s) on local backend...`);

  let allSuccess = true;
  for (const cmd of setupCommands) {
    console.log(`[oc/setup]   $ ${cmd}`);
    try {
      execSync(cmd, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
        env: process.env,
      });
    } catch (err: any) {
      allSuccess = false;
      // Log but don't fail — commands like plugin install are idempotent
      // and may exit non-zero if already installed
      console.warn(`[oc/setup]   Warning: "${cmd}" exited with error: ${err.message?.split("\n")[0]}`);
    }
  }

  // Only write sentinel if all commands succeeded
  if (allSuccess) {
    try {
      mkdirSync(SENTINEL_DIR, { recursive: true });
      writeFileSync(SENTINEL_FILE, fingerprint, "utf-8");
    } catch {}
  }

  console.log("[oc/setup] Local setup complete.");
  return allSuccess;
}

/**
 * Run setup commands on a remote sprite.
 * Idempotent: checks a sentinel file on the sprite filesystem.
 * @param spriteName - Name of the sprite to run commands on.
 * @param force - If true, bypass sentinel check and re-run commands.
 * @returns true if all commands succeeded, false if any failed.
 */
export async function runSpriteSetup(spriteName: string, force = false): Promise<boolean> {
  const config = getConfig();
  const { setupCommands } = config;
  if (setupCommands.length === 0) return true;

  const fingerprint = commandsHash(setupCommands);
  // Validate fingerprint contains only hex chars before shell interpolation
  if (!/^[0-9a-f]+$/.test(fingerprint)) throw new Error("Invalid fingerprint");
  const sentinelPath = "/root/.oc-setup-done";

  // Check sentinel on sprite
  if (!force) {
    try {
      const checkParams = new URLSearchParams();
      checkParams.append("cmd", "cat");
      checkParams.append("cmd", sentinelPath);
      const checkUrl = `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${checkParams.toString()}`;
      const checkRes = await fetch(checkUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.spriteToken}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (checkRes.ok) {
        const body = await checkRes.json().catch(() => null);
        const stdout = (body?.stdout || "").trim();
        if (stdout === fingerprint) {
          console.log(`[oc/setup] Sprite ${spriteName} setup already done, skipping.`);
          return true;
        }
      }
    } catch {}
  }

  console.log(`[oc/setup] Running ${setupCommands.length} setup command(s) on sprite ${spriteName}...`);

  let allSuccess = true;
  for (const cmd of setupCommands) {
    console.log(`[oc/setup]   [${spriteName}] $ ${cmd}`);
    try {
      const params = new URLSearchParams();
      params.append("cmd", "bash");
      params.append("cmd", "-c");
      params.append("cmd", cmd);
      const url = `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.spriteToken}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        allSuccess = false;
        console.warn(`[oc/setup]   Warning: "${cmd}" on ${spriteName} returned ${res.status}`);
      }
    } catch (err: any) {
      allSuccess = false;
      console.warn(`[oc/setup]   Warning: "${cmd}" on ${spriteName} failed: ${err.message}`);
    }
  }

  // Only write sentinel if all commands succeeded
  if (allSuccess) {
    try {
      const writeParams = new URLSearchParams();
      writeParams.append("cmd", "bash");
      writeParams.append("cmd", "-c");
      writeParams.append("cmd", `printf '%s' '${fingerprint}' > ${sentinelPath}`);
      const writeUrl = `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${writeParams.toString()}`;
      await fetch(writeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.spriteToken}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {}
  }

  console.log(`[oc/setup] Sprite ${spriteName} setup complete.`);
  return allSuccess;
}
