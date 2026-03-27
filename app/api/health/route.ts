export const runtime = "nodejs";

import { ensureInitialized } from "@/lib/oc/init";
import { getConfig } from "@/lib/oc/config";
import { getState } from "@/lib/oc/state";

export async function GET() {
  await ensureInitialized();

  const config = getConfig();
  const state = getState();

  const info: Record<string, unknown> = {
    name: "opencompletions",
    status: "ok",
    cli: config.cli,
    backend: config.backend,
    active_workers: state.activeWorkers,
    queued: state.queue.length,
    max_concurrency: config.concurrency,
    endpoints: {
      openai_chat: "POST /v1/chat/completions",
      openai_completions: "POST /v1/completions",
      openai_responses: "POST /v1/responses",
      openai_embeddings: "POST /v1/embeddings",
      anthropic_messages: "POST /v1/messages",
      anthropic_count_tokens: "POST /v1/messages/count_tokens",
      agent: "POST /v1/agent",
      openapi_spec: "GET  /openapi.json",
      docs: "GET  /docs",
      models: "GET  /v1/models",
      model_detail: "GET  /v1/models/:id",
    },
  };

  if (config.backend === "sprite") {
    info.sprites = state.spritePool.map((s) => ({
      name: s.name,
      active_jobs: s.busy,
    }));
  }
  if (config.backend === "vercel") {
    info.sandboxes = state.vercelPool.map((s) => ({
      id: s.id,
      active_jobs: s.busy,
    }));
  }
  if (config.backend === "cloudflare") {
    info.cloudflare_sandboxes = state.cloudflarePool.map((s) => ({
      id: s.id,
      active_jobs: s.busy,
    }));
  }

  return Response.json(info);
}
