import { Check, Copy, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useScriptRun } from "@/api/hooks/use-script-runs";
import { useScripts } from "@/api/hooks/use-scripts";
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
import { ActionSheetItem } from "@/components/sessions-v2/mobile/action-sheet";
import { AgentLink } from "@/components/shared/agent-link";
import { DetailHeader } from "@/components/shared/detail-header";
import { ScriptRunKindBadge } from "@/components/shared/script-run-kind-badge";
import { ShowMore } from "@/components/shared/show-more";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useIsPhone } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

function RunIdValue({ id }: { id: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
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

function formatSelectionParam(selection: Selection): string {
  if (!selection) return "";
  if (selection.kind === "step") return `step:${selection.stepId}`;
  return selection.kind;
}

function parseSelectionParam(value: string | null): Selection {
  if (!value) return null;
  if (value === "input" || value === "output") return { kind: value };
  if (value.startsWith("step:")) {
    const stepId = value.slice("step:".length);
    return stepId ? { kind: "step", stepId } : null;
  }
  return null;
}

export default function ScriptRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const { data, isLoading, refetch, isFetching } = useScriptRun(id ?? "");
  const isPhone = useIsPhone();
  const { copy } = useCopyToClipboard();
  const run = data?.run;
  const journal = useMemo(() => data?.journal ?? [], [data]);

  // Run → Script backlink: runs reference scripts by name (no FK), so resolve
  // the saved script's id from the catalog (scratch included — inline runs
  // auto-save scratch scripts). Unresolved names (deleted script) fall back to
  // a pre-filtered /scripts search link.
  const { data: scripts } = useScripts({ includeScratch: true });
  const linkedScriptId = run?.scriptName
    ? scripts?.find((s) => s.name === run.scriptName)?.id
    : undefined;

  const counts = useMemo(() => stepCounts(journal), [journal]);
  const blocks = useMemo(() => (run?.source ? parseStepBlocks(run.source) : []), [run?.source]);
  const anchors = useMemo(
    () => (run?.source ? parseRunAnchors(run.source) : { input: null, output: null }),
    [run?.source],
  );
  const mapping = useMemo(() => mapStepsToBlocks(journal, blocks), [journal, blocks]);

  const selection = parseSelectionParam(searchParams.get("selection"));
  // Phone: Detail splits into Source and Timeline tabs, so neither panel is
  // a 72vh box stacked under the other.
  const viewParam = readStringParam(searchParams, "view", "detail");
  const view =
    viewParam === "waterfall"
      ? "waterfall"
      : isPhone && viewParam === "timeline"
        ? "timeline"
        : "detail";
  const setSelection = (next: Selection) => setParam("selection", formatSelectionParam(next));
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

  const scriptLink = run.scriptName ? (
    <Link
      to={
        linkedScriptId
          ? `/scripts/${linkedScriptId}`
          : `/scripts?tab=scripts&search=${encodeURIComponent(run.scriptName)}`
      }
      className="text-sm text-foreground underline-offset-2 transition-colors hover:underline"
    >
      {run.scriptName}
    </Link>
  ) : null;
  const stepsLabel =
    journal.length > 0
      ? `${journal.length} steps · ${counts.scripts} script${counts.scripts === 1 ? "" : "s"} · ${counts.llm} llm · ${counts.tasks} task${counts.tasks === 1 ? "" : "s"}`
      : "0 steps";

  return (
    // Mockup (UI audit 2026-11-06): compact DetailHeader. Desktop: one header
    // line + one facts row, the Detail panels fill the rest of the viewport
    // (no page scroll around a 72vh box). Phone: one status line, one summary
    // line, sticky tabs, full-height source.
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <DetailHeader
        back={{ to: "/scripts?tab=runs", label: "Script runs" }}
        title={run.scriptName ?? "Script run"}
        status={
          <>
            <StatusBadge status={run.status} size="md" />
            {isPhone ? (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {runDuration ?? "running…"}
              </span>
            ) : null}
          </>
        }
        badges={[
          <ScriptRunKindBadge key="kind" kind={run.kind} />,
          <Badge key="started" variant="outline" size="tag" className="font-mono">
            {formatSmartTime(run.startedAt)}
          </Badge>,
          runDuration ? (
            <Badge key="dur" variant="outline" size="tag" className="font-mono">
              {runDuration}
            </Badge>
          ) : null,
        ]}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
        primary={
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Refresh"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn("size-5", isFetching && "animate-spin")} />
          </Button>
        }
        more={
          <>
            <ActionSheetItem icon={Copy} label="Copy run ID" onSelect={() => copy(run.id)} />
            {run.source ? (
              <ActionSheetItem
                icon={Copy}
                label="Copy source"
                onSelect={() => copy(run.source ?? "")}
              />
            ) : null}
          </>
        }
        facts={[
          { label: "Agent", value: <AgentLink agentId={run.agentId} />, summary: undefined },
          ...(scriptLink ? [{ label: "Script", value: scriptLink }] : []),
          {
            label: "Started",
            value: <span className="font-mono text-xs">{formatSmartTime(run.startedAt)}</span>,
            summary: formatSmartTime(run.startedAt),
          },
          {
            label: "Duration",
            value: (
              <span className="font-mono text-xs tabular-nums">{runDuration ?? "running…"}</span>
            ),
          },
          ...(live
            ? [
                {
                  label: "Heartbeat",
                  value: (
                    <span className="font-mono text-xs">
                      {run.lastHeartbeatAt ? formatSmartTime(run.lastHeartbeatAt) : "—"}
                    </span>
                  ),
                },
              ]
            : []),
          {
            label: "Steps",
            value: <span className="text-xs">{stepsLabel}</span>,
            summary: `${journal.length} steps`,
          },
          { label: "Run ID", value: <RunIdValue id={run.id} />, summary: run.kind },
        ]}
      />

      {run.error && (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="font-mono text-xs">
            <ShowMore maxHeight="4.5rem">
              <p className="whitespace-pre-wrap">{run.error}</p>
            </ShowMore>
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        value={view}
        onValueChange={(value) => setParam("view", value, { defaultValue: "detail" })}
        className="flex min-h-0 flex-1 flex-col gap-2 max-md:flex-none"
      >
        <TabsList variant="line" sticky>
          <TabsTrigger value="detail">{isPhone ? "Source" : "Detail"}</TabsTrigger>
          {isPhone ? (
            <TabsTrigger value="timeline">
              Timeline{journal.length ? ` ${journal.length}` : ""}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
        </TabsList>

        <TabsContent value="detail" className="flex min-h-0 flex-col gap-4 lg:flex-row">
          <SourceView
            source={run.source ?? ""}
            blocks={blocks}
            inputAnchor={anchors.input}
            outputAnchor={anchors.output}
            selectedBlock={selectedBlock}
            selectedAnchor={selectedAnchor}
            onSelectBlock={handleSelectBlock}
            onSelectAnchor={(a) => setSelection(a ? { kind: a } : null)}
            className="md:h-[72vh] lg:h-auto lg:min-h-0 lg:flex-[3]"
          />
          {isPhone ? null : (
            <TimelinePanel
              journal={journal}
              mapping={mapping}
              runArgs={run.args ?? null}
              runOutput={run.output}
              hasOutput={run.output !== undefined}
              selection={selection}
              onSelect={setSelection}
              className="md:h-[72vh] lg:h-auto lg:min-h-0 lg:flex-[2]"
            />
          )}
        </TabsContent>

        {isPhone ? (
          <TabsContent value="timeline" className="flex flex-col">
            <TimelinePanel
              journal={journal}
              mapping={mapping}
              runArgs={run.args ?? null}
              runOutput={run.output}
              hasOutput={run.output !== undefined}
              selection={selection}
              onSelect={(next) =>
                // Picking a step jumps to the Source tab, scrolled to its block.
                setParams(
                  { selection: formatSelectionParam(next), view: next ? "detail" : "timeline" },
                  { defaultValues: { view: "detail" } },
                )
              }
              className="h-auto"
            />
          </TabsContent>
        ) : null}

        <TabsContent value="waterfall" className="flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card md:h-[72vh] lg:h-auto lg:flex-1">
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
