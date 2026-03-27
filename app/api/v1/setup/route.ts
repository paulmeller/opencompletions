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

  // Admin permission gate: require a WorkOS dashboard session.
  // Placeholder until proper roles system exists — for now, only
  // browser-authenticated dashboard users may trigger setup commands.
  try {
    const { withAuth } = await import("@workos-inc/authkit-nextjs");
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
