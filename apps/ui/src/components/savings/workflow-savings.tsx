import { PiggyBank } from "lucide-react";
import type { ReactNode } from "react";
import { useJobSavings, useJobSavingsDaily } from "@/api/hooks/use-savings";
import type { SavingsJobRow, SavingsJobsResponse, SavingsTarget, SavingsTier } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCount, formatUsd } from "@/pages/usage/usage-format";
import { SavingsDailyChart } from "./savings-daily-chart";

const TIER_MODEL: Record<SavingsTier, string> = {
  smol: "haiku 5.5",
  regular: "sonnet 5.5",
  smart: "opus 5.5",
  ultra: "fable 5.1",
};

function formatHours(hours: number): string {
  return Math.abs(hours) >= 10 ? `${formatCount(Math.round(hours))}h` : `${hours.toFixed(1)}h`;
}

function calibrationNote(data: SavingsJobsResponse): string {
  const day = new Date(`${data.calibratedAt}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Modelled at ${TIER_MODEL[data.tier]} (${data.tier}), calibrated ${day}.`;
}

const isScript = (row: SavingsJobRow) => row.kind !== "workflow";

/** How a script row is priced, as shown on the script page. */
export function scriptKindLabel(row: SavingsJobRow): string {
  return row.kind === "script-scheduled" ? "scheduled" : "called by agents (priced as extra turns)";
}

/**
 * The 30-day saved amount next to the workflow or script name. Shows nothing
 * while loading, on error, or when there is no valid saving; a click opens
 * the Savings tab.
 */
export function SavingsHeaderAmount({
  target,
  onOpen,
}: {
  target: SavingsTarget;
  onOpen: () => void;
}) {
  const { data } = useJobSavings(target);
  const row = data?.valid ? data.rows[0] : undefined;
  if (!data || !row) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1.5 rounded-md border border-status-success/30 bg-status-success/5 px-2 py-0.5 text-xs transition-colors hover:bg-status-success/10"
        >
          <PiggyBank className="size-3.5 text-status-success-strong" />
          <span className="font-mono font-semibold tabular-nums text-status-success-strong">
            {formatUsd(row.savingUsd.p50)}
          </span>
          <span className="text-muted-foreground">saved ({data.window.days}d)</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs whitespace-normal">
        80% range {formatUsd(row.savingUsd.p10)} to {formatUsd(row.savingUsd.p90)}.{" "}
        {isScript(row) ? `Priced as ${scriptKindLabel(row)}. ` : ""}
        {calibrationNote(data)} Click for details.
      </TooltipContent>
    </Tooltip>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </div>
  );
}

function SavingsKpis({ row, note, days }: { row: SavingsJobRow; note: string; days: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatPanel
        label={`Saved (${days}d)`}
        value={<span className="font-mono tabular-nums">{formatUsd(row.savingUsd.p50)}</span>}
        detail={`${formatUsd(row.savingUsd.p10)} to ${formatUsd(row.savingUsd.p90)}`}
        info={`What these runs would have cost as agent tasks, minus their estimated cost. The range is the 80% band. ${note}`}
      />
      <StatPanel
        label="Agent-hours saved"
        value={<span className="font-mono tabular-nums">{formatHours(row.hoursSaved.p50)}</span>}
        detail={`${formatHours(row.hoursSaved.p10)} to ${formatHours(row.hoursSaved.p90)}`}
        info={
          isScript(row)
            ? `Agent-active hours the same work would have taken. A script run keeps no agent active, so nothing is subtracted. ${note}`
            : `Agent-active hours the same work would have taken, minus the time it took. ${note}`
        }
      />
      <StatPanel
        label="Substituted runs"
        value={
          <span className="font-mono tabular-nums">
            {formatCount(row.substitutedRuns)} of {formatCount(row.runs)}
          </span>
        }
        detail={row.capApplied ? "Capped at 24 a day" : undefined}
        info={
          isScript(row)
            ? "Runs an agent would have had to do. Runs count at most 24 a day unless they created an agent task; API runs count only when they did."
            : "Runs an agent would have had to do. Skipped and cancelled runs do not count, and scheduled runs count at most 24 a day unless they started an agent task or a workflow."
        }
      />
      {isScript(row) ? (
        <StatPanel
          label="Priced as"
          value={row.kind === "script-scheduled" ? "Scheduled" : "Called by agents"}
          detail={
            row.kind === "script-scheduled"
              ? "Standalone agent task per run"
              : "Priced as extra turns"
          }
          info="A script a schedule targets is priced as a standalone agent task with a lead review. Any other script is priced as the extra turns the calling agent would spend doing its work, with no new session and no review."
        />
      ) : (
        <StatPanel
          label="Measured spend"
          value={<span className="font-mono tabular-nums">{formatUsd(row.measuredUsd)}</span>}
          detail={`${row.estimatedLlmUsd > 0 ? `+ ${formatUsd(row.estimatedLlmUsd)} est. LLM · ` : ""}Est. ${formatUsd(row.actualUsd)} for substituted runs vs ${formatUsd(row.agentOnlyUsd.p50)} agent-only`}
          info="What all the window's runs cost: agent tasks they started, their reviews, recorded LLM cost. LLM calls with no recorded cost are estimated from tokens and output size and shown apart. The saving subtracts both, scaled to the substituted share of runs, from the agent-only cost."
        />
      )}
    </div>
  );
}

function WorkflowMethod() {
  return (
    <>
      <p>
        Each counted run is priced as an agent session whose length grows with the run's
        deterministic operations, plus a lead review. Agent tasks the workflow started count at
        their cost on both sides. The saving is that agent-only cost minus the runs' cost.
      </p>
      <p>
        The runs' cost in the saving is an estimate: the spend scaled by substituted runs over all
        runs, as if spend were spread evenly. Measured spend is the unscaled total of recorded
        costs; LLM calls with no recorded cost are estimated from tokens and output size and listed
        apart.
      </p>
      <p>
        Covers this workflow's own runs; sub-workflow runs are not included. Scheduled runs count at
        most 24 a day unless they started an agent task or a workflow.
      </p>
    </>
  );
}

function ScriptMethod({ row }: { row: SavingsJobRow }) {
  return (
    <>
      <p>
        {row.kind === "script-scheduled"
          ? "A schedule targets this script, so each counted run is priced as a standalone agent session whose length grows with the script's awaited operations, plus a lead review."
          : "No schedule targets this script, so each counted run is priced as the extra turns the calling agent would spend doing the script's awaited operations itself: no new session and no review."}
      </p>
      <p>
        Scripts record no LLM spend, so the runs' cost counts as $0 and the saving is the agent-only
        cost. LLM calls made inside the script are not counted.
      </p>
      <p>
        Runs count at most 24 a day unless they created an agent task; API runs count only when they
        did. Runs are keyed by script name, so a global and an agent-scoped script with this name
        share one row.
      </p>
    </>
  );
}

/**
 * The Savings tab: KPIs, the daily chart, the details and the method note
 * for the workflow's or script's last 30 days.
 */
export function SavingsTab({ target }: { target: SavingsTarget }) {
  const { data, isLoading, isError } = useJobSavings(target);
  const row = data?.valid ? data.rows[0] : undefined;
  const daily = useJobSavingsDaily(target, !!row);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data) {
    return <p className="text-sm text-muted-foreground">Could not load the saving. Try again.</p>;
  }
  const days = data.window.days;
  if (!row) {
    return (
      <Card className="py-8">
        <CardContent className="flex flex-col items-center gap-2 text-center">
          <PiggyBank className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No saving to show</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {data.reason === "not-computed"
              ? `Not computed yet: the savings rollup is still filling the last ${days} days.`
              : `This ${"scriptName" in target ? "script" : "workflow"} has no runs in the last ${days} days.`}
          </p>
        </CardContent>
      </Card>
    );
  }
  const note = calibrationNote(data);
  return (
    <div className="flex flex-col gap-4 overflow-y-auto pb-4">
      <SavingsKpis row={row} note={note} days={days} />
      {daily.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : daily.data?.valid ? (
        <SavingsDailyChart points={daily.data.points} capApplied={row.capApplied} />
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="gap-2 py-4">
          <CardHeader className="px-5">
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="px-5">
            <dl className="text-sm">
              <DetailRow label="Runs">{formatCount(row.runs)}</DetailRow>
              <DetailRow label="Substituted runs">{formatCount(row.substitutedRuns)}</DetailRow>
              <DetailRow label="Effect runs above the cap">{formatCount(row.effectRuns)}</DetailRow>
              <DetailRow label="Hourly cap">
                {row.capApplied ? "Applied (24 a day)" : "Not reached"}
              </DetailRow>
              <DetailRow label="Ops per run">{row.opsPerRun.toFixed(1)}</DetailRow>
              <DetailRow label="Agent-only cost per run">
                {formatUsd(row.agentOnlyUsdPerRun)}
              </DetailRow>
              {isScript(row) ? (
                <DetailRow label="Priced as">{scriptKindLabel(row)}</DetailRow>
              ) : (
                <>
                  <DetailRow label="Measured spend">{formatUsd(row.measuredUsd)}</DetailRow>
                  {row.estimatedLlmUsd > 0 ? (
                    <DetailRow label="LLM spend (est.)">{formatUsd(row.estimatedLlmUsd)}</DetailRow>
                  ) : null}
                  <DetailRow label="Substituted-run cost (est.)">
                    {formatUsd(row.actualUsd)}
                  </DetailRow>
                </>
              )}
              <DetailRow label="Agent-only cost (est.)">
                {formatUsd(row.agentOnlyUsd.p50)}
              </DetailRow>
            </dl>
          </CardContent>
        </Card>
        <Card className="gap-2 py-4">
          <CardHeader className="px-5">
            <CardTitle>Method</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-5 text-xs leading-relaxed text-muted-foreground">
            {isScript(row) ? <ScriptMethod row={row} /> : <WorkflowMethod />}
            <p>{note}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function WorkflowSavingsHeaderAmount({
  workflowId,
  onOpen,
}: {
  workflowId: string;
  onOpen: () => void;
}) {
  return <SavingsHeaderAmount target={{ workflowId }} onOpen={onOpen} />;
}

export function WorkflowSavingsTab({ workflowId }: { workflowId: string }) {
  return <SavingsTab target={{ workflowId }} />;
}
