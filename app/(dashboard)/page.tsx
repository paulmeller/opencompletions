import Link from "next/link";
import { getStats, getRuns } from "@/lib/api";
import { getSetting } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  CheckCircle2, Circle, Play, History, Sparkles,
} from "lucide-react";

export default async function OverviewPage() {
  let stats, recentRuns;
  try {
    [stats, recentRuns] = await Promise.all([
      getStats(),
      getRuns({ limit: 10 }),
    ]);
  } catch {
    return (
      <p className="text-sm text-muted-foreground">
        Cannot connect to OpenCompletions API. Make sure the server is running.
      </p>
    );
  }

  const completedRuns = stats.completed ?? 0;

  const hasLlmKey = !!(
    getSetting("llm_key_claude_api") ||
    getSetting("llm_key_claude_oauth") ||
    getSetting("llm_key_openai") ||
    getSetting("llm_key_gemini")
  );
  const hasFirstRun = completedRuns >= 1;
  const hasApiKey = true;

  return (
    <div className="max-w-5xl flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-semibold">Overview</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Backend: {stats.backend} · Workers: {stats.active_workers}/{stats.max_concurrency} · Queue: {stats.queued}
        </p>
      </div>

      {completedRuns === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Welcome to OpenCompletions</CardTitle>
            <CardDescription>Run coding agents through one API with reusable skills.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              <ChecklistItem done label="Signed in" />
              <ChecklistItem done={hasLlmKey} label="LLM key configured" href="/settings" />
              <ChecklistItem done={hasFirstRun} label="First successful run" href="/playground" />
              <ChecklistItem done={hasApiKey} label="API key ready" href="/keys" />
            </ul>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link href="/playground">
              <Play className="size-4" />
              Open Playground
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/runs">
              <History className="size-4" />
              View All Runs
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/skills">
              <Sparkles className="size-4" />
              Add a Skill
            </Link>
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Runs" value={stats.total_runs} />
        <StatCard label="Completed" value={stats.completed ?? 0} />
        <StatCard label="Errors" value={stats.errors ?? 0} />
        <StatCard
          label="Total Cost"
          value={stats.total_cost_usd != null ? `$${stats.total_cost_usd.toFixed(2)}` : "$0.00"}
          sub={stats.avg_cost_usd != null ? `avg $${stats.avg_cost_usd.toFixed(4)}/run` : undefined}
        />
      </div>

      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Recent Runs</h3>
        {recentRuns.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet.{" "}
            <Link href="/playground" className="text-primary underline underline-offset-4 hover:text-primary/80">
              Open the Playground to run your first agent task →
            </Link>
          </p>
        ) : (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">Prompt</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider hidden md:table-cell">Backend</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider hidden md:table-cell">Turns</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Cost</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider hidden md:table-cell">Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRuns.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Badge variant={run.status === "completed" ? "secondary" : run.status === "error" ? "destructive" : "outline"}>
                        {run.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{run.prompt?.slice(0, 80) || "—"}</TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">{run.backend || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums hidden md:table-cell">{run.num_turns ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.total_cost_usd != null ? `$${run.total_cost_usd.toFixed(4)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs hidden md:table-cell">
                      {new Date(run.started_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ChecklistItem({ done, label, href }: { done: boolean; label: string; href?: string }) {
  const icon = done
    ? <CheckCircle2 className="size-5 text-green-500 shrink-0" />
    : <Circle className="size-5 text-muted-foreground shrink-0" />;

  const text = (
    <span className={done ? "text-sm" : "text-sm text-muted-foreground"}>
      {label}
    </span>
  );

  return (
    <li className="flex items-center gap-2.5">
      {icon}
      {href && !done ? (
        <Link href={href} className="text-primary underline underline-offset-4 hover:text-primary/80 text-sm">
          {label}
        </Link>
      ) : (
        text
      )}
    </li>
  );
}
