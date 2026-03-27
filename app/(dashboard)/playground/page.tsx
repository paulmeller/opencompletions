"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Settings, Copy, ChevronRight, ChevronDown, Cog, ArrowDown, Square, SendHorizonal, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "default", label: "Default" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Opus 4.6" },
    { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  opencode: [
    { value: "default", label: "Default" },
  ],
  codex: [
    { value: "default", label: "Default" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "o3", label: "o3" },
  ],
  gemini: [
    { value: "default", label: "Default" },
    { value: "pro", label: "Pro" },
    { value: "flash", label: "Flash" },
    { value: "flash-lite", label: "Flash Lite" },
  ],
};
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;
  data: Record<string, unknown> | null;
  raw: string;
}

interface ResultData {
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  workspace_id?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

interface ConversationItem {
  kind: "text" | "tool" | "system" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  toolIsError?: boolean;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PlaygroundPage() {
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "You have MCP skill tools available (list_skills, activate_skill, read_resource). " +
    "When asked about skills or tools, call the mcp__skills__list_skills tool to discover registered skills. " +
    "Do not just list your built-in tools — actually invoke list_skills to show what domain skills are available."
  );
  const [backends, setBackends] = useState<string[]>(["local"]);
  const [selectedBackend, setSelectedBackend] = useState("local");
  const [maxTurns, setMaxTurns] = useState(10);
  const [responseFormat, setResponseFormat] = useState<"text" | "json">("text");
  const [cliProvider, setCliProvider] = useState<"claude" | "opencode" | "codex" | "gemini">("claude");
  const [model, setModel] = useState("default");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [result, setResult] = useState<ResultData | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const autoScrollRef = useRef(true);

  // Load backends, history, and check for API key on mount
  useEffect(() => {
    fetch("/api/v1/backends").then((r) => r.json()).then((d) => {
      if (d.available?.length) {
        setBackends(d.available);
        setSelectedBackend(d.default || d.available[0]);
      }
    }).catch(() => {});
    try {
      const h = JSON.parse(localStorage.getItem("oc-playground-history") || "[]");
      setHistory(h);
    } catch {}
  }, []);

  // Autoscroll
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setUserScrolledUp(false);
      autoScrollRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 80;
    if (!atBottom && running) {
      setUserScrolledUp(true);
      autoScrollRef.current = false;
    } else if (atBottom) {
      setUserScrolledUp(false);
      autoScrollRef.current = true;
    }
  }, [running]);

  // Send
  const handleSend = useCallback(async () => {
    if (!prompt.trim() || running) return;

    const h = [prompt.trim(), ...history.filter((x) => x !== prompt.trim())].slice(0, 5);
    setHistory(h);
    localStorage.setItem("oc-playground-history", JSON.stringify(h));

    setRunning(true);
    setEvents([]);
    setResult(null);
    setError(null);
    setStartTime(Date.now());
    autoScrollRef.current = true;
    setUserScrolledUp(false);

    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 300000);

    const body: Record<string, unknown> = {
      prompt: prompt.trim(),
      stream: true,
      max_turns: maxTurns,
      backend: selectedBackend,
    };
    if (sessionId) body.session_id = sessionId;
    if (model !== "default") body.model = model;
    if (responseFormat === "json") body.response_format = "json";
    if (cliProvider !== "claude") body.cli = cliProvider;
    if (systemPrompt.trim()) body.system_prompt = systemPrompt.trim();
    const apiKey = apiKeyRef.current?.value;
    if (apiKey) body.apiKey = apiKey;

    try {
      const response = await fetch("/api/v1/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        setError(err.error?.message || err.error || `API error ${response.status}`);
        setRunning(false);
        clearTimeout(timeout);
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          if (!part.trim() || part.trim() === ":ping") continue;
          let eventName = "";
          let data: Record<string, unknown> | null = null;
          let raw = part;
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim();
            else if (line.startsWith("data: ")) {
              const d = line.slice(6);
              if (d === "[DONE]") { eventName = "done"; data = null; }
              else { try { data = JSON.parse(d); } catch { raw = d; } }
            }
          }
          if (eventName) {
            const evt: SSEEvent = { type: eventName, data, raw };
            setEvents((prev) => [...prev, evt]);
            if (eventName === "result" && data) {
              setResult(data as unknown as ResultData);
              if ((data as ResultData).session_id) setSessionId((data as ResultData).session_id!);
            }
            if (eventName === "error" && data) setError((data as { error?: { message?: string } }).error?.message || "Unknown error");
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") setError("Request cancelled");
      else setError((err as Error).message || "Connection lost");
    } finally {
      setRunning(false);
      clearTimeout(timeout);
      abortRef.current = null;
    }
  }, [prompt, systemPrompt, maxTurns, selectedBackend, responseFormat, cliProvider, model, sessionId, running, history]);

  const handleStop = () => abortRef.current?.abort();

  const copyOutput = () => {
    const text = events
      .filter((e) => e.type === "assistant" && e.data)
      .flatMap((e) => {
        const content = (e.data as { message?: { content?: ContentBlock[] } })?.message?.content || [];
        return content.filter((b) => b.type === "text" && b.text).map((b) => b.text);
      })
      .join("\n");
    navigator.clipboard.writeText(text);
  };

  const items = buildConversation(events);
  const hasContent = items.length > 0 || running;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header + Input */}
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen} className="shrink-0 pb-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Playground</h2>
            <p className="text-sm text-muted-foreground">Send test requests to the agent API</p>
          </div>
          <div className="flex items-center gap-2">
            {sessionId && (
              <span className="text-[10px] font-mono text-muted-foreground/50 hidden md:inline">
                {sessionId.slice(0, 8)}
              </span>
            )}
            {sessionId && (
              <Button variant="outline" size="sm" onClick={() => { setSessionId(null); setEvents([]); setResult(null); }}>
                <Plus data-icon="inline-start" />
                New
              </Button>
            )}
            {events.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setShowRaw(!showRaw)}>
                  {showRaw ? "Formatted" : "Raw"}
                </Button>
                <Button variant="outline" size="sm" onClick={copyOutput}>
                  <Copy data-icon="inline-start" />
                  Copy
                </Button>
              </>
            )}
          </div>
        </div>

        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) handleSend(); }}
          placeholder="Enter a prompt... (⌘+Enter to send)"
          rows={3}
          className="resize-none"
        />

        <div className="flex items-center gap-3 text-xs flex-wrap">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <Settings data-icon="inline-start" />
              Settings
            </Button>
          </CollapsibleTrigger>

          {backends.length > 1 && (
            <ToggleGroup type="single" value={selectedBackend} onValueChange={(v) => { if (v) setSelectedBackend(v); }} size="sm">
              {backends.map((b) => (
                <ToggleGroupItem key={b} value={b} className="text-xs px-2 h-6">{b}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          <ToggleGroup type="single" value={responseFormat} onValueChange={(v) => { if (v) setResponseFormat(v as "text" | "json"); }} size="sm">
            <ToggleGroupItem value="text" className="text-xs px-2 h-6">Text</ToggleGroupItem>
            <ToggleGroupItem value="json" className="text-xs px-2 h-6">JSON</ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup type="single" value={cliProvider} onValueChange={(v) => { if (v) { setCliProvider(v as "claude" | "opencode" | "codex" | "gemini"); setModel("default"); } }} size="sm">
            <ToggleGroupItem value="claude" className="text-xs px-2 h-6">Claude</ToggleGroupItem>
            <ToggleGroupItem value="opencode" className="text-xs px-2 h-6">OpenCode</ToggleGroupItem>
            <ToggleGroupItem value="codex" className="text-xs px-2 h-6">Codex</ToggleGroupItem>
            <ToggleGroupItem value="gemini" className="text-xs px-2 h-6">Gemini</ToggleGroupItem>
          </ToggleGroup>

          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-6 w-auto text-xs gap-1 px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(MODEL_OPTIONS[cliProvider] || MODEL_OPTIONS.claude).map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 ml-auto">
            <span className="text-muted-foreground">Max turns:</span>
            <Input
              type="number"
              min={1}
              max={25}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Math.min(25, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-16 text-center"
            />
          </div>

          {running ? (
            <Button variant="destructive" size="sm" onClick={handleStop}>
              <Square data-icon="inline-start" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={handleSend} disabled={!prompt.trim()}>
              <SendHorizonal data-icon="inline-start" />
              Send
            </Button>
          )}
        </div>

        <CollapsibleContent>
          <div className="flex flex-col gap-3 p-3 rounded-lg border bg-card text-card-foreground">
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="System prompt (optional)"
              rows={2}
              className="resize-none text-xs"
            />
            <Input
              ref={apiKeyRef}
              type="password"
              placeholder="API key (optional)"
              className="text-xs"
            />
          </div>
        </CollapsibleContent>

        {/* Prompt history */}
        {!running && history.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {history.map((h, i) => (
              <Button key={i} variant="outline" size="sm" className="max-w-xs truncate text-xs" onClick={() => setPrompt(h)}>
                {h}
              </Button>
            ))}
          </div>
        )}
      </Collapsible>

      {/* Response area */}
      {hasContent && (
        <div className="relative flex-1 min-h-0">
          <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-auto">
            <div className="py-4 flex flex-col gap-0">
              {showRaw ? (
                <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap px-1">
                  {events.map((e, i) => (
                    <div key={i} className="mb-1">
                      <span className="text-muted-foreground/50">event: {e.type}</span>{"\n"}
                      <span>{e.data ? JSON.stringify(e.data, null, 2) : e.raw}</span>
                    </div>
                  ))}
                </pre>
              ) : (
                <div className="flex flex-col gap-0">
                  {items.map((item, i) => <ConversationItemRow key={i} item={item} />)}
                  {running && items.length === 0 && (
                    <div className="flex items-center gap-2 py-2">
                      <Loader2 className="animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Thinking...</span>
                    </div>
                  )}
                </div>
              )}

              {/* Result bar */}
              {(result || error) && !running && (
                <div className="mt-4">
                  {error ? (
                    <Badge variant="destructive">{error}</Badge>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary">Done</Badge>
                      <span>{result?.num_turns ?? "?"} turns</span>
                      <span>{result?.total_cost_usd != null ? `$${result.total_cost_usd.toFixed(4)}` : ""}</span>
                      {startTime && <span>{((Date.now() - startTime) / 1000).toFixed(1)}s</span>}
                      {result?.session_id && <span className="font-mono text-muted-foreground/50">{result.session_id.slice(0, 8)}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Scroll to bottom FAB */}
          {userScrolledUp && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute bottom-4 right-4 size-8 rounded-full shadow-lg"
              onClick={scrollToBottom}
            >
              <ArrowDown />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build conversation items from SSE events
// ---------------------------------------------------------------------------

function buildConversation(events: SSEEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];

  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const e of events) {
    if (e.type !== "user" || !e.data) continue;
    const content = (e.data as { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string | unknown; is_error?: boolean }> } })?.message?.content || [];
    for (const b of content) {
      if (b.type === "tool_result" && b.tool_use_id) {
        toolResults.set(b.tool_use_id, {
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content || ""),
          isError: !!b.is_error,
        });
      }
    }
  }

  for (const e of events) {
    if (e.type === "system" && e.data) {
      items.push({ kind: "system", data: e.data });
    } else if (e.type === "assistant" && e.data) {
      const content = (e.data as { message?: { content?: ContentBlock[] } })?.message?.content || [];
      for (const b of content) {
        if (b.type === "thinking") continue;
        if (b.type === "text" && b.text) {
          items.push({ kind: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const tr = b.id ? toolResults.get(b.id) : undefined;
          items.push({ kind: "tool", toolName: b.name || "unknown", toolInput: b.input, toolResult: tr?.content, toolIsError: tr?.isError });
        }
      }
    } else if (e.type === "error" && e.data) {
      items.push({ kind: "error", text: (e.data as { error?: { message?: string } })?.error?.message || "Unknown error" });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Conversation item components
// ---------------------------------------------------------------------------

function ConversationItemRow({ item }: { item: ConversationItem }) {
  if (item.kind === "system") return <SystemLine data={item.data!} />;
  if (item.kind === "text") return <TextBlock text={item.text!} />;
  if (item.kind === "tool") return <ToolBlock name={item.toolName!} input={item.toolInput} result={item.toolResult} isError={item.toolIsError} />;
  if (item.kind === "error") return <p className="text-sm text-destructive py-1">{item.text}</p>;
  return null;
}

function SystemLine({ data }: { data: Record<string, unknown> }) {
  const d = data as { session_id?: string; tools?: string[]; model?: string };
  const allTools = d.tools || [];
  const mcpTools = allTools.filter((t) => t.startsWith("mcp__"));
  const builtinTools = allTools.filter((t) => !t.startsWith("mcp__"));
  return (
    <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
      <Separator className="flex-1" />
      <span>{d.model || "agent"}</span>
      <span>·</span>
      <span>{builtinTools.length} tools</span>
      {mcpTools.length > 0 && (
        <>
          <span>·</span>
          <span>{mcpTools.length} MCP</span>
          {mcpTools.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px] py-0">
              {t.replace("mcp__skills__", "")}
            </Badge>
          ))}
        </>
      )}
      <Separator className="flex-1" />
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="py-1 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-lg font-semibold mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-3 mb-1">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 flex flex-col gap-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 flex flex-col gap-1">{children}</ol>,
          li: ({ children }) => <li className="text-muted-foreground">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="text-muted-foreground">{children}</em>,
          a: ({ href, children }) => <a href={href} className="text-primary underline-offset-4 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
          code: ({ className, children }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <div className="my-3 rounded-lg overflow-hidden border">
                  <div className="bg-muted px-3 py-1 text-[10px] text-muted-foreground border-b">
                    {className?.replace("language-", "") || "code"}
                  </div>
                  <pre className="bg-card px-4 py-3 overflow-x-auto text-[13px] leading-relaxed">
                    <code>{children}</code>
                  </pre>
                </div>
              );
            }
            return <code className="bg-muted px-1.5 py-0.5 rounded text-[13px]">{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">{children}</blockquote>,
          table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm border-collapse">{children}</table></div>,
          thead: ({ children }) => <thead className="border-b text-muted-foreground">{children}</thead>,
          th: ({ children }) => <th className="text-left px-3 py-1.5 text-xs font-medium">{children}</th>,
          td: ({ children }) => <td className="px-3 py-1.5 border-b border-border/50">{children}</td>,
          hr: () => <Separator className="my-4" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolBlock({ name, input, result, isError }: { name: string; input: unknown; result?: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = name.replace("mcp__skills__", "").replace("mcp__", "");

  return (
    <div className="my-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        className="h-auto px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Cog className="text-amber-500/70" />
        <span className="font-medium text-amber-500/80">{displayName}</span>
        {result == null && (
          <Loader2 className="animate-spin text-muted-foreground" />
        )}
        {result != null && !expanded && <span className="text-muted-foreground/60">— done</span>}
        {expanded ? <ChevronDown className="text-muted-foreground" /> : <ChevronRight className="text-muted-foreground" />}
      </Button>

      {expanded && (
        <div className="ml-6 mt-1 flex flex-col gap-1.5 border-l pl-3">
          {input != null && (
            <pre className="text-[11px] text-muted-foreground/60 font-mono overflow-auto max-h-32">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          {result != null && (
            <pre className={cn(
              "text-[11px] font-mono overflow-auto max-h-48 whitespace-pre-wrap",
              isError ? "text-destructive" : "text-muted-foreground"
            )}>
              {result.length > 500 ? result.slice(0, 500) + "…" : result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
