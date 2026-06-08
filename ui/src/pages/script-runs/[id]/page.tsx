import { ArrowLeft, Check, Copy, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useScriptRun } from "@/api/hooks/use-script-runs";
import type { ScriptRunJournalEntry } from "@/api/types";
import {
  mapStepsToBlocks,
  parseRunAnchors,
  parseStepBlocks,
  type Selection,
} from "@/components/script-runs/source-map";
import { SourceView } from "@/components/script-runs/source-view";
import { buildSteps, formatDurationMs } from "@/components/script-runs/step-shared";
import { TimelinePanel } from "@/components/script-runs/timeline-panel";
import { WaterfallView } from "@/components/script-runs/waterfall-view";
import { AgentLink } from "@/components/shared/agent-link";
import { ScriptRunKindBadge } from "@/components/shared/script-run-kind-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function RunId({ id }: { id: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Fact label="Run ID">
      <button
        type="button"
        onClick={() => copy(id)}
        className="group inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-label={copied ? "Copied" : "Copy run ID"}
      >
        <span className="break-all">{id}</span>
        {copied ? (
          <Check className="h-3 w-3 shrink-0 text-status-success-strong" />
        ) : (
          <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </Fact>
  );
}

function stepCounts(journal: ScriptRunJournalEntry[]) {
  let scripts = 0;
  let llm = 0;
  let tasks = 0;
  for (const e of journal) {
    if (e.stepType === "swarm-script") scripts++;
    else if (e.stepType === "raw-llm") llm++;
    else if (e.stepType === "agent-task") tasks++;
  }
  return { scripts, llm, tasks };
}

export default function ScriptRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, refetch, isFetching } = useScriptRun(id ?? "");
  const run = data?.run;
  const journal = useMemo(() => data?.journal ?? [], [data]);

  const counts = useMemo(() => stepCounts(journal), [journal]);
  const blocks = useMemo(() => (run?.source ? parseStepBlocks(run.source) : []), [run?.source]);
  const anchors = useMemo(
    () => (run?.source ? parseRunAnchors(run.source) : { input: null, output: null }),
    [run?.source],
  );
  const mapping = useMemo(() => mapStepsToBlocks(journal, blocks), [journal, blocks]);

  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<"detail" | "waterfall">("detail");
  const { steps, totalMs, hasTiming } = useMemo(() => buildSteps(journal), [journal]);

  const selectedBlock =
    selection?.kind === "step" ? (mapping.stepToBlock[selection.stepId] ?? null) : null;
  const selectedAnchor =
    selection?.kind === "input" ? "input" : selection?.kind === "output" ? "output" : null;

  const handleSelectBlock = (index: number | null) => {
    if (index === null) return setSelection(null);
    const stepId = mapping.blockToStepIds[index]?.[0];
    setSelection(stepId ? { kind: "step", stepId } : null);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Script run not found.</p>;
  }

  const runDuration = run.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null;
  const live = run.status === "running" || run.status === "paused";

  return (
    <div className="flex-1 min-h-0 space-y-4 overflow-y-auto">
      <div className="space-y-3">
        <Link
          to="/script-runs"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Script Runs
        </Link>

        <PageHeader
          title={
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h1 className="truncate text-xl font-semibold">{run.scriptName || "Script run"}</h1>
              <StatusBadge status={run.status} size="md" />
              <ScriptRunKindBadge kind={run.kind} />
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

      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-lg border bg-card px-4 py-3">
        <Fact label="Agent">
          <AgentLink agentId={run.agentId} />
        </Fact>
        <Fact label="Started">
          <span className="font-mono text-xs">{formatSmartTime(run.startedAt)}</span>
        </Fact>
        <Fact label="Duration">
          <span className="font-mono text-xs tabular-nums">{runDuration ?? "running…"}</span>
        </Fact>
        {live && (
          <Fact label="Heartbeat">
            <span className="font-mono text-xs">
              {run.lastHeartbeatAt ? formatSmartTime(run.lastHeartbeatAt) : "—"}
            </span>
          </Fact>
        )}
        <Fact label="Steps">
          <span className="text-xs">
            {journal.length}
            {journal.length > 0 && (
              <span className="text-muted-foreground">
                {" · "}
                {counts.scripts} script{counts.scripts === 1 ? "" : "s"} · {counts.llm} llm ·{" "}
                {counts.tasks} task{counts.tasks === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </Fact>
        <div className="ml-auto">
          <RunId id={run.id} />
        </div>
      </div>

      <Tabs
        value={view}
        onValueChange={(v) => setView(v as "detail" | "waterfall")}
        className="gap-3"
      >
        <TabsList variant="line">
          <TabsTrigger value="detail">Detail</TabsTrigger>
          <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
        </TabsList>

        <TabsContent value="detail" className="flex flex-col gap-4 lg:flex-row">
          <SourceView
            source={run.source ?? ""}
            blocks={blocks}
            inputAnchor={anchors.input}
            outputAnchor={anchors.output}
            selectedBlock={selectedBlock}
            selectedAnchor={selectedAnchor}
            onSelectBlock={handleSelectBlock}
            onSelectAnchor={(a) => setSelection(a ? { kind: a } : null)}
            className="h-[72vh] lg:flex-[3]"
          />
          <TimelinePanel
            journal={journal}
            mapping={mapping}
            runArgs={run.args ?? null}
            runOutput={run.output}
            hasOutput={run.output !== undefined}
            selection={selection}
            onSelect={setSelection}
            className="h-[72vh] lg:flex-[2]"
          />
        </TabsContent>

        <TabsContent value="waterfall">
          <div className="flex h-[72vh] min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
              <h2 className="text-sm font-semibold">Waterfall</h2>
              {hasTiming && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDurationMs(totalMs)} total
                </span>
              )}
              {selection && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelection(null)}
                  className="ml-auto h-7 text-xs"
                >
                  Clear
                </Button>
              )}
            </div>
            <WaterfallView
              steps={steps}
              totalMs={totalMs}
              hasTiming={hasTiming}
              mapping={mapping}
              selection={selection}
              onSelect={setSelection}
              hasOutput={run.output !== undefined}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
