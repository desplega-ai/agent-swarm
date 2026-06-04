import {
  ArrowLeft,
  Bot,
  Braces,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useScriptRun } from "@/api/hooks/use-script-runs";
import type { ScriptRunJournalEntry } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { JsonViewer } from "@/components/shared/json-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

function stepIcon(stepType: string) {
  if (stepType === "swarm-script") return FileCode2;
  if (stepType === "raw-llm") return Braces;
  if (stepType === "agent-task") return Bot;
  return Workflow;
}

function stepTypeClass(stepType: string): string {
  if (stepType === "swarm-script") return "border-status-active/30 text-status-active-strong";
  if (stepType === "raw-llm") return "border-status-info/30 text-status-info-strong";
  if (stepType === "agent-task") return "border-status-success/30 text-status-success-strong";
  return "border-border text-muted-foreground";
}

function duration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "—";
  return formatElapsed(startedAt, completedAt);
}

function JournalEntry({ entry }: { entry: ScriptRunJournalEntry }) {
  const Icon = stepIcon(entry.stepType);
  const ok = entry.status === "completed";

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start gap-3 border-b px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate font-mono text-sm font-semibold">{entry.stepKey}</h3>
            <Badge
              variant="outline"
              className={cn("h-5 rounded-md text-[10px]", stepTypeClass(entry.stepType))}
            >
              {entry.stepType}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "h-5 rounded-md text-[10px]",
                ok ? "text-status-success-strong" : "text-status-error-strong",
              )}
            >
              {ok ? (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              ) : (
                <CircleAlert className="mr-1 h-3 w-3" />
              )}
              {entry.status}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>{formatSmartTime(entry.startedAt)}</span>
            <span>{duration(entry.startedAt, entry.completedAt)}</span>
          </div>
        </div>
      </div>

      {entry.error && (
        <Alert variant="destructive" className="m-3">
          <AlertDescription className="whitespace-pre-wrap font-mono text-xs">
            {entry.error}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2 p-3">
        <CollapsibleSection title="Config" defaultOpen={false}>
          <JsonViewer data={entry.config} />
        </CollapsibleSection>
        {entry.result !== undefined && (
          <CollapsibleSection title="Result" defaultOpen={false}>
            <JsonViewer data={entry.result} />
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

export default function ScriptRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, refetch, isFetching } = useScriptRun(id ?? "");
  const run = data?.run;
  const journal = data?.journal ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Script run not found.</p>;
  }

  const runDuration = run.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="space-y-3">
        <Link
          to="/script-runs"
          className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Script Runs
        </Link>

        <PageHeader
          title={
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h1 className="truncate text-xl font-semibold">{run.scriptName || "Script run"}</h1>
              <StatusBadge status={run.status} size="md" />
              <Badge variant="outline" size="tag" className="font-mono">
                {formatSmartTime(run.startedAt)}
              </Badge>
              {runDuration && (
                <Badge variant="outline" size="tag" className="font-mono">
                  {runDuration}
                </Badge>
              )}
            </div>
          }
          action={
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              Refresh
            </Button>
          }
        />
      </div>

      {run.error && (
        <Alert variant="destructive">
          <AlertDescription className="max-h-[220px] overflow-y-auto whitespace-pre-wrap font-mono text-xs">
            {run.error}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Run ID</div>
          <div className="mt-1 truncate font-mono text-xs">{run.id}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Agent</div>
          <div className="mt-1 truncate font-mono text-xs">{run.agentId}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Heartbeat</div>
          <div className="mt-1 text-sm">
            {run.lastHeartbeatAt ? formatSmartTime(run.lastHeartbeatAt) : "—"}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">Journal</div>
          <div className="mt-1 text-sm">
            {journal.length} step{journal.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <CollapsibleSection title="Args" defaultOpen={false} variant="card">
          <JsonViewer data={run.args ?? null} />
        </CollapsibleSection>
        {run.output !== undefined && (
          <CollapsibleSection title="Output" defaultOpen={false} variant="card">
            <JsonViewer data={run.output} />
          </CollapsibleSection>
        )}
      </div>

      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Journal</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {journal.filter((entry) => entry.stepType === "swarm-script").length} scripts
            </span>
            <span>{journal.filter((entry) => entry.stepType === "raw-llm").length} LLM</span>
            <span>{journal.filter((entry) => entry.stepType === "agent-task").length} tasks</span>
          </div>
        </div>

        {journal.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No journal entries yet.
          </div>
        ) : (
          <div className="space-y-3">
            {journal.map((entry) => (
              <JournalEntry key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
