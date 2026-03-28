/**
 * Shared types for the OpenCompletions engine.
 *
 * Ported from server.js — covers CLI providers, agent options,
 * auth context, queue jobs, and backend pool entries.
 */

// ---------------------------------------------------------------------------
// CLI Provider
// ---------------------------------------------------------------------------

/** Normalized agent event emitted over SSE. */
export interface AgentEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content: Array<{
      type: string;
      id?: string;
      name?: string;
      text?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string;
    }>;
  };
  error?: { message: string; type: string };
  result?: string;
  num_turns?: number;
  total_cost_usd?: number | null;
  usage?: Record<string, number>;
  model?: string;
  tools?: Array<string | { name: string; type?: string }>;
  mcp_servers?: string[] | Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Translator function returned by createEventTranslator().
 * Optionally includes a finalize() method (used by Codex provider).
 */
export interface EventTranslator {
  (event: Record<string, unknown>): AgentEvent | AgentEvent[] | null;
  finalize?: () => AgentEvent;
}

export interface CliProvider {
  name: string;
  command: string;
  promptViaStdin: boolean;
  promptArgPrefix?: string;

  /** Build CLI args for a single-turn completion. */
  buildCompletionArgs(systemPrompt?: string): string[];

  /** Build CLI args for a multi-turn agent run. */
  buildAgentArgs(opts: AgentOpts): string[];

  /** Build env vars that carry auth credentials to the CLI process. */
  buildAuthEnv(clientToken?: string): Record<string, string>;

  /** Build env vars for MCP configuration (e.g. OPENCODE_CONFIG_CONTENT). */
  buildMcpEnv(opts: AgentOpts): Record<string, string>;

  /** Optionally prepend system prompt into the user prompt text. */
  wrapPrompt(prompt: string, systemPrompt?: string): string;

  /** Create a stateful translator that converts raw CLI NDJSON events into normalized AgentEvents. */
  createEventTranslator(): EventTranslator;

  /** Human-readable label used in error messages. */
  errorLabel: string;

  /** Optional: extract result text from raw stdout (for non-streaming completion mode). */
  extractResult?: (stdout: string) => string;
}

// ---------------------------------------------------------------------------
// Agent Options
// ---------------------------------------------------------------------------

export interface AgentOpts {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  maxTurns?: number;
  model?: string;
  backend?: "local" | "sprite" | "vercel" | "cloudflare";
  cli?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  includePartialMessages?: boolean;
  workspaceId?: string;
  responseFormat?: string | { type: string };
  token?: string;
  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;

  /** Filter which skills the MCP server exposes (by name and/or tag). */
  skillFilter?: { names?: string[]; tags?: string[] };
  /** Inject skill content directly into the system prompt (no MCP round-trip). */
  preloadSkills?: Array<{ name?: string; instructions?: string; resources?: Record<string, string> }>;
  /** Per-request client token forwarded to the CLI for LLM auth. */
  clientToken?: string;
  /** Timeout for the agent run (overrides config.agentTimeout). */
  timeoutMs?: number;
  /** Working directory within a workspace (absolute path for local, relative for remote). */
  workspaceCwd?: string;
  /** Explicit working directory override (local backend only). */
  cwd?: string;
  /** Abort signal from the client connection — used to kill the subprocess on disconnect. */
  abortSignal?: AbortSignal;
  /** Override the CLI provider for this request (e.g. switch from claude to codex). */
  cliProvider?: CliProvider;
  /** Plugins to install before spawning the agent (e.g. ["docx-skill", "@anthropic-ai/mcp-server-fetch"]). */
  plugins?: string[];
  /** Custom environment variables forwarded to the CLI process. */
  env?: Record<string, string>;
}

export interface McpServerConfig {
  type?: string;
  command?: string | string[];
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Auth Context
// ---------------------------------------------------------------------------

export interface AuthContext {
  keyId: string;
  orgId?: string;
  orgName?: string;
  permissions?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueueJob {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  prompt: string;
  systemPrompt?: string;
  token?: string | null;
  onChunk?: ((chunk: string) => void) | null;
  isAgent?: boolean;
  agentOpts?: AgentOpts;
  onEvent?: (event: AgentEvent) => void;
  retried?: boolean;
}

// ---------------------------------------------------------------------------
// Backend Pool Entries
// ---------------------------------------------------------------------------

export interface SpriteEntry {
  name: string;
  busy: number;
}

export interface VercelSandbox {
  id: string;
  busy: number;
  replacing?: boolean;
  dead?: boolean;
  /** Internal: promise for in-flight replacement (mutex). */
  _replacePromise?: Promise<void> | null;
}

export interface CloudflareSandbox {
  id: string;
  busy: number;
  replacing?: boolean;
  dead?: boolean;
  /** Internal: promise for in-flight replacement (mutex). */
  _replacePromise?: Promise<void> | null;
}

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface OcConfig {
  backend: "local" | "sprite" | "vercel" | "cloudflare";
  cli: string;
  concurrency: number;
  timeout: number;
  queueDepth: number;
  agentMaxTurns: number;
  agentTimeout: number;
  apiKey: string;
  spriteToken: string;
  spriteNames: string[];
  spriteApi: string;
  vercelToken: string;
  vercelTeamId: string;
  vercelProjectId: string;
  vercelSnapshotId: string;

  // Cloudflare Sandbox
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  cloudflareApiUrl: string;

  anthropicApiKey: string;
  claudeToken: string;
  openaiApiKey: string;
  geminiApiKey: string;
  maxFileSize: number;
  maxWorkspaceSize: number;
  workspaceTtl: number;

  /** Shell commands to run once per backend instance (e.g. plugin installs). */
  setupCommands: string[];
  /** Server-wide custom environment variables forwarded to agent processes. */
  customEnv: Record<string, string>;
}
