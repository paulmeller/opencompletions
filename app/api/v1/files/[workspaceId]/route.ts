export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getState } from "@/lib/oc/state";
import * as files from "@/lib/oc/files";

// ---------------------------------------------------------------------------
// GET /v1/files/:workspaceId — List files in workspace
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const { workspaceId } = await params;

  try {
    const fileList = await files.listFiles(workspaceId);
    return Response.json({ workspace_id: workspaceId, files: fileList });
  } catch (err) {
    const code = (err as { code?: number }).code || 500;
    return Response.json(
      { error: { message: (err as Error).message, type: code === 404 ? "not_found" : "server_error" } },
      { status: code },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/files/:workspaceId — Delete workspace
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const { workspaceId } = await params;
  const state = getState();

  const ws = files.getWorkspace(workspaceId);
  if (!ws) {
    return Response.json(
      { error: { message: "Workspace not found", type: "not_found" } },
      { status: 404 },
    );
  }

  // Fire-and-forget cleanup
  files.deleteWorkspace(workspaceId);
  state.workspaceToSprite.delete(workspaceId);
  state.workspaceToSandbox.delete(workspaceId);

  return Response.json({ deleted: true, workspace_id: workspaceId });
}
