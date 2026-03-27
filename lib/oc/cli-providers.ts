/**
 * CLI provider definitions for the OpenCompletions engine.
 *
 * Each provider knows how to build CLI args, set auth environment variables,
 * configure MCP, wrap prompts, and translate raw NDJSON events from the CLI
 * into normalized AgentEvent objects.
 *
 * Ported from server.js lines 628-1004.
 */

import { getConfig } from "./config";
import {
  buildAuthEnv,
  buildAgentCliArgs,
  mergeAgentMcpConfig,
  mcpConfigToOpenCode,
  sanitizeEvent,
} from "./helpers";
import type {
  CliProvider,
  AgentOpts,
  AgentEvent,
  EventTranslator,
} from "./types";

// ---------------------------------------------------------------------------
// CLI Provider: Claude (default)
// ---------------------------------------------------------------------------

const claudeProvider: CliProvider = {
  name: "claude",
  command: "claude",
  promptViaStdin: true,

  buildCompletionArgs(systemPrompt?: string): string[] {
    const config = getConfig();
    const args = ["-p", "--max-turns", "1", "--output-format", "text"];
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    return args;
  },

  buildAgentArgs(opts: AgentOpts): string[] {
    return buildAgentCliArgs(opts);
  },

  buildAuthEnv: buildAuthEnv,

  buildMcpEnv(): Record<string, string> {
    return {}; // Claude uses --mcp-config CLI arg
  },

  wrapPrompt(prompt: string): string {
    return prompt;
  },

  createEventTranslator(): EventTranslator {
    return ((event: Record<string, unknown>) =>
      sanitizeEvent(event as AgentEvent)) as EventTranslator;
  },

  errorLabel: "claude",
};

// ---------------------------------------------------------------------------
// CLI Provider: OpenCode
// ---------------------------------------------------------------------------

const opencodeProvider: CliProvider = {
  name: "opencode",
  command: "opencode",
  promptViaStdin: false,

  buildCompletionArgs(): string[] {
    return ["run"];
  },

  buildAgentArgs(opts: AgentOpts): string[] {
    const config = getConfig();
    const args = ["run", "--format", "json"];
    if (opts.sessionId) args.push("--session", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns && opts.maxTurns !== config.agentMaxTurns) {
      console.warn(
        `Warning: opencode does not support max_turns (requested ${opts.maxTurns}, ignored)`,
      );
    }
    return args;
  },

  buildAuthEnv(clientToken?: string): Record<string, string> {
    const config = getConfig();
    const env: Record<string, string> = {};
    const apiKey = clientToken || config.anthropicApiKey;
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    // Never forward OAuth tokens to opencode per Anthropic ToS
    if (config.claudeToken && !apiKey) {
      console.warn(
        "Warning: Claude OAuth token cannot be used with opencode -- set ANTHROPIC_API_KEY instead",
      );
    }
    return env;
  },

  buildMcpEnv(opts: AgentOpts): Record<string, string> {
    const mcpConfig = mergeAgentMcpConfig(opts);
    if (Object.keys(mcpConfig).length === 0) return {};
    const opencodeMcp = mcpConfigToOpenCode(mcpConfig);
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: opencodeMcp }) };
  },

  wrapPrompt(prompt: string, systemPrompt?: string): string {
    if (!systemPrompt) return prompt;
    return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
  },

  createEventTranslator(): EventTranslator {
    let seenFirstStep = false;
    let sessionId: string | null = null;
    let totalCost = 0;
    let totalTokens = { input: 0, output: 0 };
    let stepCount = 0;
    let lastText = "";

    return ((event: Record<string, unknown>) => {
      if (!event || typeof event !== "object") return null;
      sessionId = (event.sessionID as string) || sessionId;

      switch (event.type) {
        case "step_start": {
          stepCount++;
          if (!seenFirstStep) {
            seenFirstStep = true;
            return {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              tools: [],
              mcp_servers: [],
            } as AgentEvent;
          }
          return null;
        }
        case "text": {
          const part = event.part as Record<string, unknown> | undefined;
          const text = (part?.text as string) || "";
          if (text) lastText = text;
          return {
            type: "assistant",
            message: { content: [{ type: "text", text }] },
          } as AgentEvent;
        }
        case "tool_use": {
          const part = (event.part || {}) as Record<string, unknown>;
          return {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: (part.callID as string) || (part.id as string),
                name: (part.tool as string) || "unknown",
                input: (part.state as Record<string, unknown>)?.input || {},
              }],
            },
          } as AgentEvent;
        }
        case "step_finish": {
          const part = (event.part || {}) as Record<string, unknown>;
          totalCost += (part.cost as number) || 0;
          const tokens = part.tokens as Record<string, number> | undefined;
          if (tokens) {
            totalTokens.input += tokens.input || 0;
            totalTokens.output += tokens.output || 0;
          }
          if (part.reason === "stop") {
            return {
              type: "result",
              session_id: sessionId,
              total_cost_usd: totalCost,
              num_turns: stepCount,
              result: lastText,
              usage: {
                input_tokens: totalTokens.input,
                output_tokens: totalTokens.output,
              },
            } as AgentEvent;
          }
          return null; // tool-calls step_finish -- accumulate cost only
        }
        default:
          return null;
      }
    }) as EventTranslator;
  },

  errorLabel: "opencode",
};

// ---------------------------------------------------------------------------
// CLI Provider: Codex (OpenAI)
// ---------------------------------------------------------------------------

const codexProvider: CliProvider = {
  name: "codex",
  command: "codex",
  promptViaStdin: true,

  buildCompletionArgs(): string[] {
    return ["exec", "--json", "--full-auto", "--skip-git-repo-check", "-"];
  },

  buildAgentArgs(opts: AgentOpts): string[] {
    const config = getConfig();
    const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns && opts.maxTurns !== config.agentMaxTurns) {
      console.warn(`Warning: Codex does not support --max-turns (requested ${opts.maxTurns})`);
    }
    // Inject MCP servers via -c flags
    const mcpConfig = mergeAgentMcpConfig(opts);
    for (const [name, server] of Object.entries(mcpConfig)) {
      if (server.type) args.push("-c", `mcp_servers.${name}.type="${server.type}"`);
      if (server.url) args.push("-c", `mcp_servers.${name}.url="${server.url}"`);
      if (typeof server.command === "string") {
        args.push("-c", `mcp_servers.${name}.command="${server.command}"`);
      }
      if (server.args) args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(server.args)}`);
      if (server.headers) {
        for (const [hk, hv] of Object.entries(server.headers)) {
          args.push("-c", `mcp_servers.${name}.http_headers.${hk}="${hv}"`);
        }
      }
    }
    args.push("-"); // read prompt from stdin
    return args;
  },

  buildAuthEnv(clientToken?: string): Record<string, string> {
    const config = getConfig();
    const token = clientToken || config.openaiApiKey;
    if (token && token.startsWith("sk-ant-")) {
      console.warn("Warning: Anthropic token cannot be used with Codex provider");
      return {};
    }
    return token ? { CODEX_API_KEY: token } : {};
  },

  buildMcpEnv(): Record<string, string> {
    return {}; // MCP via config file, not env
  },

  wrapPrompt(prompt: string, systemPrompt?: string): string {
    if (systemPrompt) return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
    return prompt;
  },

  // Parse NDJSON output and extract the last agent_message text (for completion mode)
  extractResult(stdout: string): string {
    let lastText = "";
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text
        ) {
          lastText = event.item.text;
        }
      } catch { /* skip */ }
    }
    return lastText;
  },

  createEventTranslator(): EventTranslator {
    let sessionId: string | null = null;
    let turnCount = 0;
    let lastText = "";
    let totalUsage: Record<string, number> = {};

    const translator = ((event: Record<string, unknown>) => {
      if (event.type === "thread.started") {
        sessionId = event.thread_id as string;
        return {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model: "codex",
          tools: [],
          mcp_servers: [],
        } as AgentEvent;
      }

      if (event.type === "item.completed" && event.item) {
        const item = event.item as Record<string, unknown>;

        if (item.type === "agent_message") {
          lastText = (item.text as string) || "";
          return {
            type: "assistant",
            message: { content: [{ type: "text", text: lastText }] },
          } as AgentEvent;
        }

        if (item.type === "command_execution") {
          const toolUse: AgentEvent = {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: item.id as string,
                name: "command",
                input: { command: (item.command as string) || "" },
              }],
            },
          };
          const toolResult: AgentEvent = {
            type: "user",
            message: {
              content: [{
                type: "tool_result",
                tool_use_id: item.id as string,
                content: (item.output as string) || (item.result as string) || "",
              }],
            },
          };
          return [toolUse, toolResult];
        }

        if (item.type === "mcp_tool_call") {
          const toolUse: AgentEvent = {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: item.id as string,
                name: (item.name as string) || "mcp_tool",
                input: (item.input as Record<string, unknown>) || {},
              }],
            },
          };
          const toolResult: AgentEvent = {
            type: "user",
            message: {
              content: [{
                type: "tool_result",
                tool_use_id: item.id as string,
                content: (item.output as string) || "",
              }],
            },
          };
          return [toolUse, toolResult];
        }

        if (item.type === "file_change") {
          return {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: item.id as string,
                name: "file_edit",
                input: {
                  path: (item.path as string) || "",
                  action: (item.action as string) || "edit",
                },
              }],
            },
          } as AgentEvent;
        }
      }

      if (event.type === "turn.completed") {
        turnCount++;
        if (event.usage) {
          for (const [k, v] of Object.entries(event.usage as Record<string, unknown>)) {
            totalUsage[k] = (totalUsage[k] || 0) + (typeof v === "number" ? v : 0);
          }
        }
        return null; // don't emit result yet -- finalize() handles it
      }

      if (event.type === "error") {
        return {
          type: "error",
          error: {
            message: (event.message as string) || JSON.stringify(event),
            type: "codex_error",
          },
        } as AgentEvent;
      }

      return null;
    }) as EventTranslator;

    // Called when the process exits to emit the final result event
    translator.finalize = (): AgentEvent => ({
      type: "result",
      session_id: sessionId ?? undefined,
      num_turns: turnCount,
      total_cost_usd: null,
      result: lastText,
      usage: totalUsage,
    });

    return translator;
  },

  errorLabel: "Codex",
};

// ---------------------------------------------------------------------------
// CLI Provider: Gemini (Google)
// ---------------------------------------------------------------------------

const geminiProvider: CliProvider = {
  name: "gemini",
  command: "gemini",
  promptViaStdin: false,
  promptArgPrefix: "-p",

  buildCompletionArgs(): string[] {
    return ["--output-format", "text", "--approval-mode", "yolo"];
  },

  buildAgentArgs(opts: AgentOpts): string[] {
    const config = getConfig();
    const args = ["--output-format", "stream-json", "--approval-mode", "yolo"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    if (opts.maxTurns && opts.maxTurns !== config.agentMaxTurns) {
      console.warn(`Warning: Gemini max_turns support unverified (requested ${opts.maxTurns})`);
    }
    return args;
  },

  buildAuthEnv(clientToken?: string): Record<string, string> {
    const config = getConfig();
    const token = clientToken || config.geminiApiKey;
    if (token && (token.startsWith("sk-ant-") || token.startsWith("sk-"))) {
      console.warn("Warning: Anthropic/OpenAI token cannot be used with Gemini provider");
      return {};
    }
    return token ? { GEMINI_API_KEY: token } : {};
  },

  buildMcpEnv(opts: AgentOpts): Record<string, string> {
    const mcpConfig = mergeAgentMcpConfig(opts);
    if (Object.keys(mcpConfig).length > 0) {
      console.warn("Warning: Gemini provider does not yet support per-request MCP configuration");
    }
    return {};
  },

  wrapPrompt(prompt: string, systemPrompt?: string): string {
    if (systemPrompt) return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
    return prompt;
  },

  extractResult(stdout: string): string {
    // --output-format text returns plain text
    return stdout.trim();
  },

  createEventTranslator(): EventTranslator {
    let sessionId: string | null = null;
    let lastText = "";

    return ((event: Record<string, unknown>) => {
      if (event.type === "init") {
        sessionId = event.session_id as string;
        return {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          model: (event.model as string) || "gemini",
          tools: [],
          mcp_servers: [],
        } as AgentEvent;
      }
      if (event.type === "message" && event.role === "assistant") {
        lastText += (event.content as string) || "";
        return {
          type: "assistant",
          message: { content: [{ type: "text", text: (event.content as string) || "" }] },
        } as AgentEvent;
      }
      if (event.type === "tool_use") {
        return {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: event.tool_id as string,
              name: event.tool_name as string,
              input: (event.parameters as Record<string, unknown>) || {},
            }],
          },
        } as AgentEvent;
      }
      if (event.type === "tool_result") {
        return {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: event.tool_id as string,
              content: (event.output as string) || "",
            }],
          },
        } as AgentEvent;
      }
      if (event.type === "result") {
        const stats = (event.stats || {}) as Record<string, unknown>;
        return {
          type: "result",
          session_id: sessionId ?? undefined,
          num_turns: (stats.tool_calls as number) || 1,
          total_cost_usd: null,
          result: lastText,
          usage: (event.stats || {}) as Record<string, number>,
        } as AgentEvent;
      }
      if (event.type === "error") {
        return {
          type: "error",
          error: {
            message: (event.message as string) || JSON.stringify(event),
            type: "gemini_error",
          },
        } as AgentEvent;
      }
      return null;
    }) as EventTranslator;
  },

  errorLabel: "Gemini",
};

// ---------------------------------------------------------------------------
// Provider map and resolver
// ---------------------------------------------------------------------------

export const CLI_PROVIDERS: Record<string, CliProvider> = {
  claude: claudeProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  gemini: geminiProvider,
};

/** Resolve a CLI provider by name, falling back to claude. */
export function getCliProvider(name?: string): CliProvider {
  return CLI_PROVIDERS[name || "claude"] || claudeProvider;
}

export {
  claudeProvider,
  opencodeProvider,
  codexProvider,
  geminiProvider,
};
