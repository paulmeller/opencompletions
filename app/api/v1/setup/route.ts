export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { getConfig } from "@/lib/oc/config";
import { getState } from "@/lib/oc/state";
import { runLocalSetup, runSpriteSetup } from "@/lib/oc/setup";
import { withAuth } from "@workos-inc/authkit-nextjs";

export async function POST(request: Request) {
  await ensureInitialized();

  // Admin-only: require a WorkOS dashboard session (not just an API key).
  // The browser sends session cookies automatically.
  try {
    const { user } = await withAuth();
    if (!user) {
      return Response.json(
        { error: { message: "Setup commands can only be run by dashboard users", type: "forbidden", code: 403 } },
        { status: 403 },
      );
    }
  } catch {
    return Response.json(
      { error: { message: "Setup commands can only be run by dashboard users", type: "forbidden", code: 403 } },
      { status: 403 },
    );
  }

  const config = getConfig();

  if (config.setupCommands.length === 0) {
    return Response.json({ message: "No setup commands configured" });
  }

  const body = await request.json().catch(() => ({}));
  const force = body.force === true;

  const results: Array<{ backend: string; name?: string; status: string }> = [];

  // Run on local
  try {
    const success = await runLocalSetup(force);
    results.push({ backend: "local", status: success ? "ok" : "partial_failure" });
  } catch (err) {
    results.push({ backend: "local", status: `error: ${(err as Error).message}` });
  }

  // Run on sprites
  const state = getState();
  for (const sprite of state.spritePool) {
    try {
      const success = await runSpriteSetup(sprite.name, force);
      results.push({ backend: "sprite", name: sprite.name, status: success ? "ok" : "partial_failure" });
    } catch (err) {
      results.push({ backend: "sprite", name: sprite.name, status: `error: ${(err as Error).message}` });
    }
  }

  return Response.json({
    commands: config.setupCommands,
    results,
  });
}
