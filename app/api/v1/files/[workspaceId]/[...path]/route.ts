export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { getConfig } from "@/lib/oc/config";
import * as files from "@/lib/oc/files";

// ---------------------------------------------------------------------------
// GET /v1/files/:workspaceId/:path* — Download a file from workspace
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; path: string[] }> },
) {
  await ensureInitialized();

  const authContext = await authenticateRequest(request);
  const config = getConfig();

  if (config.apiKey && !authContext) {
    return Response.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      { status: 401 },
    );
  }

  const { workspaceId, path: pathSegments } = await params;

  // Decode each URL segment individually and join
  let decodedFilename: string;
  try {
    decodedFilename = pathSegments
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    return Response.json(
      { error: { message: "Invalid URL encoding", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Validate filename
  const safeName = files.validateFilename(decodedFilename);
  if (!safeName) {
    return Response.json(
      { error: { message: "Invalid filename", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  try {
    const fileStream = await files.readFile(workspaceId, safeName);
    const contentType = files.contentTypeForFile(safeName);

    // Convert Node.js Readable to a web ReadableStream for the Response
    const webStream = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        fileStream.on("end", () => {
          controller.close();
        });
        fileStream.on("error", (err: Error) => {
          console.error(`File stream error: ${err.message}`);
          controller.error(err);
        });
      },
      cancel() {
        fileStream.destroy();
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(safeName)}"`,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Expose-Headers": "X-Workspace-Id",
      },
    });
  } catch (err) {
    const code = (err as { code?: number }).code || 500;
    return Response.json(
      { error: { message: (err as Error).message, type: code === 404 ? "not_found" : "server_error" } },
      { status: code },
    );
  }
}
