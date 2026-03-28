import { getRun } from "@/lib/api";
import type { AgentRun } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import EventsTimeline from "./events-timeline";

function statusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "error") return "destructive";
  return "outline";
}

function formatDuration(startedAt: number, completedAt: number | null): string {
  if (!completedAt) return "In progress";
  const ms = completedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = getRun(id) as AgentRun | null;

  if (!run) {
    return (
      <div className="max-w-4xl flex flex-col gap-6">
        <Link href="/runs" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to Runs
        </Link>
        <p className="text-sm text-muted-foreground">Run not found.</p>
      </div>
    );
  }

  // Parse events
  let events: Array<Record<string, unknown>> = [];
  if (run.events_json) {
    try {
      events = JSON.parse(run.events_json);
    } catch {
      // ignore parse errors
    }
  }

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link href="/runs" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to Runs
        </Link>
        <div className="flex items-center gap-3 flex-wrap">
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          <span className="font-mono text-sm text-muted-foreground">{run.id}</span>
        </div>
        {run.prompt && (
          <div className="text-sm">
            <span className="font-medium">Prompt:</span>{" "}
            <span className="text-muted-foreground">{run.prompt}</span>
          </div>
        )}
      </div>

      <Separator />

      {/* Metadata grid */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3 text-sm">
            <div>
              <span className="text-muted-foreground">Backend</span>
              <p className="font-medium">{run.backend || "---"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">CLI</span>
              <p className="font-medium">{run.cli || "---"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Model</span>
              <p className="font-medium">{run.model || "---"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p className="font-medium">{formatDuration(run.started_at, run.completed_at)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Cost</span>
              <p className="font-medium">
                {run.total_cost_usd != null ? `$${run.total_cost_usd.toFixed(4)}` : "---"}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Turns</span>
              <p className="font-medium">{run.num_turns ?? "---"}</p>
            </div>
            {run.session_id && (
              <div>
                <span className="text-muted-foreground">Session ID</span>
                <p className="font-mono text-xs break-all">{run.session_id}</p>
              </div>
            )}
            {run.workspace_id && (
              <div>
                <span className="text-muted-foreground">Workspace ID</span>
                <p className="font-mono text-xs break-all">{run.workspace_id}</p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Started</span>
              <p className="font-medium">{new Date(run.started_at).toLocaleString()}</p>
            </div>
            {run.completed_at && (
              <div>
                <span className="text-muted-foreground">Completed</span>
                <p className="font-medium">{new Date(run.completed_at).toLocaleString()}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Resume button */}
      {run.session_id && (
        <div>
          <Button variant="outline" asChild>
            <Link href={`/playground?session_id=${run.session_id}`}>
              Resume in Playground
            </Link>
          </Button>
        </div>
      )}

      {/* Error message */}
      {run.error_message && (
        <Card size="sm" className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive">{run.error_message}</p>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Events timeline */}
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Events Timeline</h3>
        <EventsTimeline events={events} />
      </div>
    </div>
  );
}
