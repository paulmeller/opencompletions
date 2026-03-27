export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { buildOpenAIModelsResponse } from "@/lib/oc/response-builders";

export async function GET() {
  await ensureInitialized();

  return Response.json(buildOpenAIModelsResponse());
}
