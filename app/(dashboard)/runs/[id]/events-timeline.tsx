"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface TimelineEvent {
  type?: string;
  subtype?: string;
  ts?: number;
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }>;
  };
  model?: string;
  tools?: unknown[];
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function SystemInitCard({ event }: { event: TimelineEvent }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Badge variant="secondary">system</Badge>
          Session started
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          {event.model && <span>Model: <span className="text-foreground">{event.model as string}</span></span>}
          {event.tools && <span>Tools: <span className="text-foreground">{(event.tools as unknown[]).length}</span></span>}
        </div>
      </CardContent>
    </Card>
  );
}

function AssistantCard({ event }: { event: TimelineEvent }) {
  const textBlocks: string[] = [];
  const toolUseBlocks: Array<{ name: string; input: unknown }> = [];

  if (event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use") {
        toolUseBlocks.push({ name: block.name || "unknown", input: block.input });
      }
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Badge>assistant</Badge>
          {event.ts && <span className="text-xs text-muted-foreground font-normal">{formatTime(event.ts)}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {textBlocks.map((text, i) => (
          <div key={i} className="text-sm whitespace-pre-wrap">{text}</div>
        ))}
        {toolUseBlocks.map((tool, i) => (
          <Collapsible key={i}>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium cursor-pointer hover:text-primary">
              <span className="text-xs">&#9654;</span>
              <Badge variant="outline">{tool.name}</Badge>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-x-auto max-h-64 overflow-y-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </CardContent>
    </Card>
  );
}

function ToolResultCard({ event }: { event: TimelineEvent }) {
  let content = "";
  if (event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        content += block.text;
      } else if (block.content) {
        content += typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
      }
    }
  }
  if (!content && event.content) {
    content = typeof event.content === "string" ? event.content : JSON.stringify(event.content, null, 2);
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium cursor-pointer hover:text-primary w-full">
        <Card size="sm" className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="text-xs">&#9654;</span>
              <Badge variant="outline">tool_result</Badge>
              {event.ts && <span className="text-xs text-muted-foreground font-normal">{formatTime(event.ts)}</span>}
            </CardTitle>
          </CardHeader>
        </Card>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {content && (
          <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-x-auto max-h-64 overflow-y-auto">
            {content}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ResultCard({ event }: { event: TimelineEvent }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Badge variant="secondary">result</Badge>
          Run completed
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          {event.total_cost_usd != null && (
            <span>Cost: <span className="text-foreground">${(event.total_cost_usd as number).toFixed(4)}</span></span>
          )}
          {event.num_turns != null && (
            <span>Turns: <span className="text-foreground">{event.num_turns as number}</span></span>
          )}
          {event.usage && (
            <span>Usage: <span className="text-foreground">{JSON.stringify(event.usage)}</span></span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ event }: { event: TimelineEvent }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>{event.error as string || "Unknown error"}</AlertDescription>
    </Alert>
  );
}

function MinimalEvent({ event }: { event: TimelineEvent }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
      <Badge variant="outline" className="text-xs">{event.type || "unknown"}</Badge>
      {event.ts && <span className="text-xs">{formatTime(event.ts)}</span>}
    </div>
  );
}

export default function EventsTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return <p className="text-sm text-muted-foreground">No events recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((event, i) => {
        // Full events have more than just {type, ts}
        const isMinimal = Object.keys(event).length <= 2 && event.type && event.ts;

        if (isMinimal) {
          return <MinimalEvent key={i} event={event} />;
        }

        switch (event.type) {
          case "system":
            if (event.subtype === "init") {
              return <SystemInitCard key={i} event={event} />;
            }
            return <MinimalEvent key={i} event={event} />;
          case "assistant":
            return <AssistantCard key={i} event={event} />;
          case "tool_result":
            return <ToolResultCard key={i} event={event} />;
          case "result":
            return <ResultCard key={i} event={event} />;
          case "error":
            return <ErrorCard key={i} event={event} />;
          default:
            return <MinimalEvent key={i} event={event} />;
        }
      })}
    </div>
  );
}
