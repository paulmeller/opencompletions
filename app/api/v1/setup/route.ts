export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { getState } from "@/lib/oc/state";
import { runLocalSetup, runSpriteSetup } from "@/lib/oc/setup";

export async function POST(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const config = getConfig();

  if (config.setupCommands.length === 0) {
    return Response.json({ message: "No setup commands configured" });
  }

  const results: Array<{ backend: string; name?: string; status: string }> = [];

  // Run on local
  try {
    await runLocalSetup();
    results.push({ backend: "local", status: "ok" });
  } catch (err) {
    results.push({ backend: "local", status: `error: ${(err as Error).message}` });
  }

  // Run on sprites
  const state = getState();
  for (const sprite of state.spritePool) {
    try {
      await runSpriteSetup(sprite.name);
      results.push({ backend: "sprite", name: sprite.name, status: "ok" });
    } catch (err) {
      results.push({ backend: "sprite", name: sprite.name, status: `error: ${(err as Error).message}` });
    }
  }

  return Response.json({
    commands: config.setupCommands,
    results,
  });
}
