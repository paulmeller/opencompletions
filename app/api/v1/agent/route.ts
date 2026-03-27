export const runtime = "nodejs";
export { handleOptions as OPTIONS } from "@/lib/oc/cors";

import { ensureInitialized } from "@/lib/oc/init";
import { authenticateRequest } from "@/lib/oc/auth-api";
import { handleAgentStream, handleAgentBuffered } from "@/lib/oc/streaming";
import { getConfig } from "@/lib/oc/config";
import { getState } from "@/lib/oc/state";
import { normalizeResponseFormat } from "@/lib/oc/helpers";
import { CLI_PROVIDERS, getCliProvider } from "@/lib/oc/cli-providers";
import * as files from "@/lib/oc/files";
import { logRunStart, logRunComplete, logRunEvents } from "@/lib/db";
import type { AgentOpts } from "@/lib/oc/types";

export async function POST(request: Request) {
  await ensureInitialized();

  const authContext = await authenticateRequest(request);
  const config = getConfig();

  if (config.apiKey && !authContext) {
    return Response.json(
      { error: { message: "Invalid API key", type: "authentication_error", code: 401 } },
      { status: 401 },
    );
  }

  // Parse JSON body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Validate prompt
  if (!body.prompt) {
    return Response.json(
      { error: { message: "prompt is required", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Per-request backend selection (falls back to server default)
  const state = getState();
  const requestBackend = (body.backend as string) || config.backend;

  // Determine available backends
  const availableBackends = new Set<string>(["local"]);
  if (state.spritePool.length > 0) availableBackends.add("sprite");
  if (state.vercelPool.length > 0) availableBackends.add("vercel");

  if (!availableBackends.has(requestBackend)) {
    return Response.json(
      { error: { message: `Backend "${requestBackend}" is not available. Available: ${Array.from(availableBackends).join(", ")}`, type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Per-request CLI provider selection
  const requestCli = getCliProvider(body.cli as string | undefined);
  if (body.cli && !CLI_PROVIDERS[body.cli as string]) {
    return Response.json(
      { error: { message: `Unknown CLI provider "${body.cli}". Available: ${Object.keys(CLI_PROVIDERS).join(", ")}`, type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  if (requestCli.name !== "claude" && requestBackend !== "local") {
    return Response.json(
      { error: { message: `CLI provider "${requestCli.name}" only supports local backend`, type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Validate unsupported features for non-claude CLIs
  if (requestCli.name === "opencode") {
    if ((body.allowed_tools as string[] | undefined)?.length) {
      return Response.json(
        { error: { message: "opencode backend does not support allowed_tools", type: "invalid_request_error" } },
        { status: 400 },
      );
    }
    if ((body.disallowed_tools as string[] | undefined)?.length) {
      return Response.json(
        { error: { message: "opencode backend does not support disallowed_tools", type: "invalid_request_error" } },
        { status: 400 },
      );
    }
    if (body.max_budget_usd != null) {
      return Response.json(
        { error: { message: "opencode backend does not support max_budget_usd", type: "invalid_request_error" } },
        { status: 400 },
      );
    }
  }

  // Workspace integration
  const wsId = (body.workspace_id as string) || null;
  if (wsId && body.cwd) {
    return Response.json(
      { error: { message: "workspace_id and cwd are mutually exclusive", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  let workspaceCwd: string | null = null;
  if (wsId) {
    const ws = files.getWorkspace(wsId);
    if (!ws) {
      return Response.json(
        { error: { message: "Workspace not found", type: "not_found" } },
        { status: 404 },
      );
    }
    if (ws.state !== "created" && ws.state !== "completed") {
      return Response.json(
        { error: { message: `Workspace is in '${ws.state}' state, expected 'created' or 'completed'`, type: "conflict" } },
        { status: 409 },
      );
    }

    // Validate session_id + workspace_id don't conflict on backend binding
    if (body.session_id) {
      if (requestBackend === "sprite") {
        const wsSprite = state.workspaceToSprite.get(wsId);
        const sessSprite = state.sessionToSprite.get(body.session_id as string);
        if (wsSprite && sessSprite && wsSprite !== sessSprite) {
          return Response.json(
            { error: { message: "workspace_id and session_id are bound to different sprites", type: "conflict" } },
            { status: 409 },
          );
        }
      } else if (requestBackend === "vercel") {
        const wsSandbox = state.workspaceToSandbox.get(wsId);
        const sessSandbox = state.sessionToSandbox.get(body.session_id as string);
        if (wsSandbox && sessSandbox && wsSandbox !== sessSandbox) {
          return Response.json(
            { error: { message: "workspace_id and session_id are bound to different sandboxes", type: "conflict" } },
            { status: 409 },
          );
        }
      }
    }

    // Pre-run validation: verify workspace dir still exists on remote
    if (requestBackend !== "local") {
      const exists = await files.validateWorkspaceExists(wsId);
      if (!exists) {
        files.setWorkspaceState(wsId, "error");
        return Response.json(
          { error: { message: "Workspace directory no longer exists on remote", type: "gone" } },
          { status: 410 },
        );
      }
    }
    workspaceCwd = files.getWorkspaceCwd(wsId);
    files.setWorkspaceState(wsId, "running");
  }

  // Forward x-api-key to the backend as the provider token
  const forwardToken = request.headers.get("x-api-key") || null;

  // Build agent options
  const agentOpts: AgentOpts & { _beforeEvent?: (event: Record<string, unknown>) => void } = {
    prompt: body.prompt as string,
    sessionId: (body.session_id as string) || undefined,
    maxTurns: (body.max_turns as number) || config.agentMaxTurns,
    systemPrompt: (body.system_prompt as string) || undefined,
    model: (body.model as string) || undefined,
    allowedTools: (body.allowed_tools as string[]) || undefined,
    disallowedTools: (body.disallowed_tools as string[]) || undefined,
    maxBudgetUsd: body.max_budget_usd != null ? (body.max_budget_usd as number) : undefined,
    cwd: (body.cwd as string) || undefined,
    includePartialMessages: (body.include_partial_messages as boolean) || false,
    mcpServers: (body.mcp_servers as AgentOpts["mcpServers"]) || undefined,
    clientToken: forwardToken || undefined,
    timeoutMs: (body.timeout_ms as number) || undefined,
    workspaceId: wsId || undefined,
    workspaceCwd: workspaceCwd || undefined,
    backend: requestBackend as AgentOpts["backend"],
    cliProvider: requestCli,
    responseFormat: normalizeResponseFormat(body.response_format as string | { type: string } | undefined),
  };

  // Auto-inject skills MCP server if not provided in mcp_servers
  if (!agentOpts.mcpServers) {
    const host = request.headers.get("x-forwarded-host")
      || request.headers.get("host")
      || `localhost:${process.env.PORT || 3000}`;
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const dashboardUrl = process.env.MCP_BASE_URL || `${proto}://${host}`;

    // Use the active API key for MCP auth (same server, same DB)
    const { getSetting } = await import("@/lib/db");
    const mcpAuthToken = getSetting("active_api_key") || config.apiKey || "";
    agentOpts.mcpServers = {
      skills: {
        type: "http",
        url: `${dashboardUrl}/api/mcp`,
        headers: mcpAuthToken ? { Authorization: `Bearer ${mcpAuthToken}` } : {},
      },
    };
  }

  // Auto-inject file manifest into system prompt
  if (wsId) {
    const manifest = files.buildFileManifest(wsId);
    if (manifest) {
      agentOpts.systemPrompt = agentOpts.systemPrompt
        ? `${manifest}\n\n${agentOpts.systemPrompt}`
        : manifest;
    }
  }

  // Auto-inject JSON format instruction
  if (agentOpts.responseFormat === "json") {
    const jsonInstruction = "IMPORTANT: You MUST respond with valid JSON only. Do not wrap in markdown code fences. Do not include text before or after. Your entire response must be a single valid JSON object or array.";
    agentOpts.systemPrompt = agentOpts.systemPrompt
      ? `${agentOpts.systemPrompt}\n\n${jsonInstruction}`
      : jsonInstruction;
  }

  const stream = body.stream !== false; // default true

  // Log run start
  const runId = logRunStart({
    apiKeyId: authContext?.keyId,
    orgId: authContext?.orgId,
    sessionId: body.session_id as string | undefined,
    workspaceId: wsId || undefined,
    prompt: body.prompt as string,
    systemPrompt: body.system_prompt as string | undefined,
    backend: requestBackend,
    cli: requestCli.name,
    model: (body.model as string) || undefined,
  });

  // Capture events for db logging
  const runResult: {
    sessionId: string | null;
    numTurns: number | null;
    totalCostUsd: number | null;
    usage: Record<string, unknown> | null;
  } = { sessionId: null, numTurns: null, totalCostUsd: null, usage: null };
  const runEvents: Array<{ type: string; ts: number }> = [];

  agentOpts._beforeEvent = (event: Record<string, unknown>) => {
    runEvents.push({ type: event.type as string, ts: Date.now() });
    if (event.type === "result") {
      runResult.sessionId = (event.session_id as string) || null;
      runResult.numTurns = (event.num_turns as number) || null;
      runResult.totalCostUsd = (event.total_cost_usd as number) || null;
      runResult.usage = (event.usage as Record<string, unknown>) || null;

      // For streaming: log run completion when the result event fires
      // (the response was already returned to the client, so we can't wait)
      if (stream && runId) {
        if (wsId) files.setWorkspaceState(wsId, "completed");
        logRunComplete(runId, {
          sessionId: runResult.sessionId || undefined,
          numTurns: runResult.numTurns || undefined,
          totalCostUsd: runResult.totalCostUsd || undefined,
          usage: runResult.usage || undefined,
        });
        logRunEvents(runId, runEvents);
      }
    }
  };

  try {
    let response: Response;
    if (stream) {
      response = handleAgentStream(body.prompt as string, agentOpts);
    } else {
      response = await handleAgentBuffered(body.prompt as string, agentOpts);

      // For buffered: log after handleAgentBuffered resolves (agent is done)
      if (wsId) files.setWorkspaceState(wsId, "completed");
      if (runId) {
        logRunComplete(runId, {
          sessionId: runResult.sessionId || undefined,
          numTurns: runResult.numTurns || undefined,
          totalCostUsd: runResult.totalCostUsd || undefined,
          usage: runResult.usage || undefined,
        });
        logRunEvents(runId, runEvents);
      }
    }

    return response;
  } catch (err) {
    if (wsId) files.setWorkspaceState(wsId, "error");
    if (runId) {
      logRunComplete(runId, { error: (err as Error).message });
    }
    return Response.json(
      { error: { message: (err as Error).message, type: "server_error", code: 500 } },
      { status: 500 },
    );
  }
}
