import { getRuns } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

function statusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "error") return "destructive";
  return "outline";
}

export default async function RunsPage() {
  let data;
  try {
    data = await getRuns({ limit: 100 });
  } catch {
    return <p className="text-sm text-muted-foreground">Cannot connect to API.</p>;
  }

  return (
    <div className="max-w-6xl flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Agent Runs</h2>
        <p className="text-sm text-muted-foreground mt-1">{data.total} total runs</p>
      </div>

      {data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs uppercase tracking-wider">Status</TableHead>
                <TableHead className="text-xs uppercase tracking-wider">ID</TableHead>
                <TableHead className="text-xs uppercase tracking-wider">Prompt</TableHead>
                <TableHead className="text-xs uppercase tracking-wider hidden md:table-cell">Agent</TableHead>
                <TableHead className="text-xs uppercase tracking-wider hidden lg:table-cell">Model</TableHead>
                <TableHead className="text-xs uppercase tracking-wider hidden md:table-cell">Backend</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Turns</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Cost</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider hidden md:table-cell">Duration</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider hidden md:table-cell">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.runs.map((run) => {
                const duration = run.completed_at && run.started_at
                  ? ((run.completed_at - run.started_at) / 1000).toFixed(1) + "s"
                  : "—";
                return (
                  <TableRow key={run.id}>
                    <TableCell><Badge variant={statusVariant(run.status)}>{run.status}</Badge></TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{run.id.slice(0, 8)}</TableCell>
                    <TableCell className="max-w-sm truncate">{run.prompt?.slice(0, 100) || "—"}</TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">{run.cli || "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs hidden lg:table-cell">{run.model || "—"}</TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">{run.backend || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{run.num_turns ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.total_cost_usd != null ? `$${run.total_cost_usd.toFixed(4)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground hidden md:table-cell">{duration}</TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs hidden md:table-cell">
                      {new Date(run.started_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
