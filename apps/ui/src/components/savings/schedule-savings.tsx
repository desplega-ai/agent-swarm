import { PiggyBank } from "lucide-react";
import { Link } from "react-router-dom";
import { useScheduleSavings } from "@/api/hooks/use-savings";
import type { SavingsScheduleResponse, SavingsScheduleRow, SavingsTargetRow } from "@/api/types";
import { QuickStat } from "@/components/ui/detail-page-layout";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCount, formatUsd } from "@/pages/usage/usage-format";
import { calibrationNote, scriptKindLabel } from "./workflow-savings";

const isModelled = (row: SavingsScheduleRow | undefined): row is SavingsTargetRow =>
  row?.basis === "modelled";

function hours(h: number): string {
  return Math.abs(h) >= 10 ? `${formatCount(Math.round(h))}h` : `${h.toFixed(1)}h`;
}

/** Why a schedule has no figure to show, as one short value for the rail. */
function emptyValue(data: SavingsScheduleResponse): { value: string; title: string } {
  if (data.reason === "target-missing") {
    return {
      value: "Target gone",
      title: "The workflow or script this schedule runs no longer exists.",
    };
  }
  if (data.reason === "not-computed") {
    return { value: "Not computed yet", title: "The savings rollup is still filling the window." };
  }
  return {
    value: "No runs",
    title: `The target has no runs in the last ${data.window.days} days.`,
  };
}

/**
 * Rail rows for a schedule's saving. A workflow or script schedule shows its
 * target's saving (runs carry no schedule link); an agent-task schedule shows
 * what its tasks cost. Renders nothing until the figure has loaded.
 */
export function ScheduleSavingsStats({ scheduleId }: { scheduleId: string }) {
  const { data } = useScheduleSavings(scheduleId);
  if (!data) return null;
  const days = data.window.days;
  const row = data.valid ? data.rows[0] : undefined;
  if (!row) {
    const empty = emptyValue(data);
    return (
      <QuickStat
        label={`Saved (${days}d)`}
        value={<span title={empty.title}>{empty.value}</span>}
      />
    );
  }
  if (!isModelled(row)) {
    return (
      <>
        <QuickStat
          label={`Spend (${days}d)`}
          mono
          value={
            <span title="Recorded cost of the tasks this schedule created. Their review tasks are not included. An agent-task schedule has no automation to substitute, so no saving is modelled.">
              {formatUsd(row.actualUsd)}
            </span>
          }
        />
        <QuickStat label={`Tasks (${days}d)`} mono value={formatCount(row.runs)} />
      </>
    );
  }
  const note = `${calibrationNote(data)} Priced from runs of the target ${row.kind === "workflow" ? "workflow" : "script"}, shared with any other schedule of it.${row.scheduleEnabled ? "" : " This schedule is disabled; the runs are from the window."}`;
  return (
    <>
      <QuickStat
        label={`Saved (${days}d)`}
        mono
        value={
          <span
            title={`80% range ${formatUsd(row.savingUsd.p10)} to ${formatUsd(row.savingUsd.p90)}. ${note}`}
          >
            {formatUsd(row.savingUsd.p50)}
          </span>
        }
      />
      <QuickStat
        label="Agent-hours saved"
        mono
        value={
          <span title={`${hours(row.hoursSaved.p10)} to ${hours(row.hoursSaved.p90)}. ${note}`}>
            {hours(row.hoursSaved.p50)}
          </span>
        }
      />
      <QuickStat
        label="Agent-only $/run"
        mono
        value={
          <span title="What one run would cost if an agent did the work instead of the automation.">
            {formatUsd(row.agentOnlyUsdPerRun)}
          </span>
        }
      />
      <QuickStat
        label="Substituted runs"
        mono
        value={
          <span title={row.capApplied ? "Capped at 24 a day" : undefined}>
            {formatCount(row.substitutedRuns)} of {formatCount(row.runs)}
          </span>
        }
      />
      {row.kind === "workflow" ? null : (
        <QuickStat
          label="Priced as"
          value={row.kind === "script-scheduled" ? "Scheduled" : scriptKindLabel(row)}
        />
      )}
    </>
  );
}

/**
 * The 30-day saved amount in the schedule header. Only a workflow or script
 * schedule has one; it links to the target's Savings tab. Shows nothing while
 * loading, on error, or when there is no saving.
 */
export function ScheduleSavingsHeaderAmount({
  scheduleId,
  targetHref,
}: {
  scheduleId: string;
  targetHref: string | undefined;
}) {
  const { data } = useScheduleSavings(scheduleId);
  const row = data?.valid ? data.rows[0] : undefined;
  if (!data || !isModelled(row)) return null;
  const chip = (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-status-success/30 bg-status-success/5 px-2 py-0.5 text-xs">
      <PiggyBank className="size-3.5 text-status-success-strong" />
      <span className="font-mono font-semibold tabular-nums text-status-success-strong">
        {formatUsd(row.savingUsd.p50)}
      </span>
      <span className="text-muted-foreground">saved ({data.window.days}d)</span>
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {targetHref ? (
          <Link to={targetHref} className="transition-opacity hover:opacity-80">
            {chip}
          </Link>
        ) : (
          chip
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs whitespace-normal">
        80% range {formatUsd(row.savingUsd.p10)} to {formatUsd(row.savingUsd.p90)}. The saving of
        the target {row.kind === "workflow" ? "workflow" : "script"}, shared with any other schedule
        of it. {calibrationNote(data)}
        {targetHref ? " Click for details." : ""}
      </TooltipContent>
    </Tooltip>
  );
}
