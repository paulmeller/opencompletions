/**
 * CORS preflight helpers for OpenCompletions API routes.
 *
 * Usage: add `export { handleOptions as OPTIONS } from "@/lib/oc/cors";`
 * to any route file that external consumers call with Authorization headers.
 */

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Filename, X-Workspace-Id",
    "Access-Control-Max-Age": "86400",
  };
}

export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
