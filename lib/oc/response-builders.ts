/**
 * Response builders and prompt extractors for the OpenCompletions engine.
 *
 * Builds OpenAI-compatible, Anthropic-compatible, and Responses API
 * response objects. Also includes deterministic hash-based pseudo-embeddings
 * and prompt extraction from various API formats.
 *
 * Ported from server.js lines 1898-2074, 2567-2614.
 */

import { randomUUID, createHash } from "crypto";

const MODEL_NAME = "claude-code";

// ---------------------------------------------------------------------------
// OpenAI response builders
// ---------------------------------------------------------------------------

export function buildOpenAIResponse(
  text: string,
  model?: string | null,
  isChat = true,
): Record<string, unknown> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (isChat) {
    return {
      id,
      object: "chat.completion",
      created,
      model: model || MODEL_NAME,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  return {
    id: id.replace("chatcmpl", "cmpl"),
    object: "text_completion",
    created,
    model: model || MODEL_NAME,
    choices: [{ index: 0, text, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic response builder
// ---------------------------------------------------------------------------

export function buildAnthropicResponse(
  text: string,
  model?: string | null,
): Record<string, unknown> {
  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: model || MODEL_NAME,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Model object builders
// ---------------------------------------------------------------------------

export function buildModelObject(id: string): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "local",
    capabilities: { chat: true, completions: true, agent: true, embeddings: false },
    context_length: 200000,
    max_output_tokens: 16384,
  };
}

export function buildOpenAIModelsResponse(): Record<string, unknown> {
  return {
    object: "list",
    data: [buildModelObject(MODEL_NAME)],
  };
}

// ---------------------------------------------------------------------------
// Embeddings stub -- deterministic hash-based pseudo-embeddings
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 1536; // Match OpenAI ada-002 dimension

export function hashEmbedding(text: string): number[] {
  // Generate a deterministic float vector from text via repeated hashing
  const vec = new Float64Array(EMBEDDING_DIM);
  let hash = createHash("sha256").update(text).digest();
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    if (i % 32 === 0 && i > 0) {
      hash = createHash("sha256").update(hash).digest();
    }
    // Convert byte to float in [-1, 1]
    vec[i] = (hash[i % 32] / 127.5) - 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const result: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) result.push(vec[i] / norm);
  return result;
}

export function buildEmbeddingResponse(
  inputs: Array<string | unknown>,
  model?: string | null,
): Record<string, unknown> {
  const data = inputs.map((text, i) => ({
    object: "embedding",
    index: i,
    embedding: hashEmbedding(typeof text === "string" ? text : String(text)),
  }));
  return {
    object: "list",
    data,
    model: model || MODEL_NAME,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Prompt extractors
// ---------------------------------------------------------------------------

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[];
}

interface PromptResult {
  prompt: string | null;
  systemPrompt: string | null;
}

/**
 * Extract prompt and system prompt from an OpenAI chat completions body.
 * Ported from server.js lines 2567-2590.
 */
export function extractOpenAIChatPrompt(body: {
  messages?: ChatMessage[];
  [key: string]: unknown;
}): PromptResult {
  const messages = body.messages || [];
  if (!messages.length) return { prompt: null, systemPrompt: null };

  let systemPrompt: string | null = null;
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as ContentBlock[])?.map((c) => c.text || "").join("\n");
    } else {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as ContentBlock[])?.map((c) => c.text || "").join("\n");
      parts.push(`${msg.role}: ${content}`);
    }
  }

  return { prompt: parts.join("\n\n"), systemPrompt };
}

/**
 * Extract prompt and system prompt from an Anthropic messages body.
 * Ported from server.js lines 2592-2614.
 */
export function extractAnthropicPrompt(body: {
  messages?: ChatMessage[];
  system?: string | ContentBlock[];
  [key: string]: unknown;
}): PromptResult {
  const messages = body.messages || [];
  let systemPrompt: string | null = null;

  if (typeof body.system === "string") {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    const text = (body.system as ContentBlock[])
      .map((block) => block.text || "")
      .filter(Boolean)
      .join("\n");
    if (text) systemPrompt = text;
  }

  const parts = messages.map((msg) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content as ContentBlock[])?.map((c) => c.text || "").join("\n");
    return `${msg.role}: ${content}`;
  });

  return { prompt: parts.join("\n\n") || null, systemPrompt };
}

/**
 * Extract prompt and system prompt from an OpenAI Responses API body.
 * Ported from server.js lines 2010-2049.
 */
export function extractResponsesPrompt(body: {
  input?: string | Array<string | ChatMessage>;
  instructions?: string;
  [key: string]: unknown;
}): PromptResult {
  const input = body.input;
  if (!input) return { prompt: null, systemPrompt: null };

  // String input
  if (typeof input === "string") {
    return { prompt: input, systemPrompt: (body.instructions as string) || null };
  }

  // Array of message objects
  if (Array.isArray(input)) {
    let systemPrompt: string | null = (body.instructions as string) || null;
    const parts: string[] = [];
    for (const item of input) {
      // String item in array
      if (typeof item === "string") {
        parts.push(`user: ${item}`);
        continue;
      }
      const msg = item as ChatMessage;
      if (msg.role === "system" || msg.role === "developer") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as ContentBlock[]).map((c) => c.text || "").join("\n")
              : "";
        systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      } else {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as ContentBlock[]).map((c) => c.text || "").join("\n")
              : "";
        parts.push(`${msg.role}: ${text}`);
      }
    }
    return { prompt: parts.join("\n\n") || null, systemPrompt };
  }

  return { prompt: null, systemPrompt: null };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API response builder
// ---------------------------------------------------------------------------

export function buildResponsesResponse(
  text: string,
  model?: string | null,
): Record<string, unknown> {
  const id = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || MODEL_NAME,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

export function errorResponse(
  status: number,
  message: string,
  type = "invalid_request_error",
): { status: number; body: Record<string, unknown> } {
  return { status, body: { error: { message, type, code: status } } };
}
