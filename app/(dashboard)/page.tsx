import { getStats, getRuns } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

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

  return (
    <div className="max-w-5xl flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-semibold">Overview</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Backend: {stats.backend} · Workers: {stats.active_workers}/{stats.max_concurrency} · Queue: {stats.queued}
        </p>
      </div>

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
          <p className="text-sm text-muted-foreground">No runs yet. Send a request to POST /v1/agent to get started.</p>
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
