export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authorize } from "@/lib/oc/authenticate";
import { getConfig } from "@/lib/oc/config";
import { getState } from "@/lib/oc/state";
import * as files from "@/lib/oc/files";

export async function POST(request: Request) {
  await ensureInitialized();

  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const config = getConfig();

  // Validate filename from header
  const rawFilename = request.headers.get("x-filename");
  if (!rawFilename) {
    return Response.json(
      { error: { message: "X-Filename header required", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  let decodedFilename: string;
  try {
    decodedFilename = decodeURIComponent(rawFilename);
  } catch {
    return Response.json(
      { error: { message: "Invalid X-Filename encoding", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const filename = files.validateFilename(decodedFilename);
  if (!filename) {
    return Response.json(
      { error: { message: "Invalid filename", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Read raw body
  let buffer: Buffer;
  try {
    const arrayBuffer = await request.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);

    if (buffer.length > config.maxFileSize) {
      return Response.json(
        { error: { message: `File too large (max ${config.maxFileSize} bytes)`, type: "invalid_request_error" } },
        { status: 413 },
      );
    }
    if (buffer.length === 0) {
      return Response.json(
        { error: { message: "Empty file body", type: "invalid_request_error" } },
        { status: 400 },
      );
    }
  } catch (err) {
    return Response.json(
      { error: { message: (err as Error).message, type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Get or create workspace
  let workspaceId = request.headers.get("x-workspace-id") || null;
  if (workspaceId) {
    const ws = files.getWorkspace(workspaceId);
    if (!ws) {
      return Response.json(
        { error: { message: "Workspace not found", type: "not_found" } },
        { status: 404 },
      );
    }
    if (ws.state === "running") {
      return Response.json(
        { error: { message: "Cannot upload while workspace is running", type: "conflict" } },
        { status: 409 },
      );
    }
    // Check workspace size limit
    if (ws.totalBytes + buffer.length > config.maxWorkspaceSize) {
      return Response.json(
        { error: { message: `Workspace size limit exceeded (max ${config.maxWorkspaceSize} bytes)`, type: "invalid_request_error" } },
        { status: 413 },
      );
    }
  } else {
    // Create new workspace
    const state = getState();
    let spriteName: string | undefined;
    let sandboxId: string | undefined;

    if (config.backend === "sprite") {
      // Round-robin: pick least-busy sprite (without incrementing busy counter)
      if (state.spritePool.length === 0) {
        return Response.json(
          { error: { message: "No sprites configured", type: "server_error" } },
          { status: 503 },
        );
      }
      let sprite = state.spritePool[0];
      for (let i = 1; i < state.spritePool.length; i++) {
        if (state.spritePool[i].busy < sprite.busy) sprite = state.spritePool[i];
      }
      spriteName = sprite.name;
    } else if (config.backend === "vercel") {
      // Pick least-busy sandbox (without incrementing busy counter)
      let sandbox = null;
      for (let i = 0; i < state.vercelPool.length; i++) {
        if (state.vercelPool[i].replacing) continue;
        if (!sandbox || state.vercelPool[i].busy < sandbox.busy) sandbox = state.vercelPool[i];
      }
      if (!sandbox) {
        return Response.json(
          { error: { message: "No healthy sandboxes available", type: "server_error" } },
          { status: 503 },
        );
      }
      sandboxId = sandbox.id;
    } else if (config.backend === "cloudflare") {
      // Pick least-busy Cloudflare sandbox (without incrementing busy counter)
      let sandbox = null;
      for (let i = 0; i < state.cloudflarePool.length; i++) {
        if (state.cloudflarePool[i].replacing) continue;
        if (!sandbox || state.cloudflarePool[i].busy < sandbox.busy) sandbox = state.cloudflarePool[i];
      }
      if (!sandbox) {
        return Response.json(
          { error: { message: "No healthy Cloudflare sandboxes available", type: "server_error" } },
          { status: 503 },
        );
      }
      sandboxId = sandbox.id;
    }

    try {
      const result = await files.createWorkspace(config.backend, spriteName, sandboxId);
      workspaceId = result.id;
      // Track binding
      if (spriteName) state.workspaceToSprite.set(workspaceId, spriteName);
      if (sandboxId && config.backend === "vercel") state.workspaceToSandbox.set(workspaceId, sandboxId);
      if (sandboxId && config.backend === "cloudflare") state.workspaceToCloudflare.set(workspaceId, sandboxId);
    } catch (err) {
      const code = (err as { code?: number }).code === 502 ? 502 : 500;
      return Response.json(
        { error: { message: `Failed to create workspace: ${(err as Error).message}`, type: "server_error" } },
        { status: code },
      );
    }
  }

  // Save file
  try {
    const fileInfo = await files.saveFile(workspaceId, filename, buffer);
    return Response.json({
      workspace_id: workspaceId,
      file: fileInfo,
    });
  } catch (err) {
    const errCode = (err as { code?: number | string }).code;
    if (errCode === "ENOSPC") {
      return Response.json(
        { error: { message: "Disk full", type: "server_error" } },
        { status: 507 },
      );
    }
    const status = errCode === 502 ? 502 : errCode === 409 ? 409 : 500;
    files.setWorkspaceState(workspaceId, "error");
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error" } },
      { status },
    );
  }
}
