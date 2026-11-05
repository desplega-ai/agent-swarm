import { useWorkflowSavings } from "@/api/hooks/use-savings";
import type { SavingsJobsResponse, SavingsTier } from "@/api/types";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { formatCount, formatUsd } from "@/pages/usage/usage-format";

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

/**
 * The workflow's modelled saving over the last 30 days: what its runs would
 * have cost as agent tasks, minus what they cost, with the 80% range.
 */
export function WorkflowSavingsStrip({ workflowId }: { workflowId: string }) {
  const { data, isLoading, isError } = useWorkflowSavings(workflowId);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !data) return null;
  const days = data.window.days;
  const row = data.rows[0];
  if (!data.valid || !row) {
    return (
      <p className="text-xs text-muted-foreground">
        {data.reason === "too-many-runs"
          ? `Saving not shown: too many runs in the last ${days} days to compute live.`
          : `No runs in the last ${days} days, so no saving to show.`}
      </p>
    );
  }
  const note = calibrationNote(data);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatPanel
        label={`Saved (${days}d)`}
        value={<span className="font-mono tabular-nums">{formatUsd(row.savingUsd.p50)}</span>}
        detail={`${formatUsd(row.savingUsd.p10)} to ${formatUsd(row.savingUsd.p90)}`}
        info={
          <>
            What these runs would have cost as agent tasks, minus what they cost (
            {formatUsd(row.actualUsd)}). The range is the 80% band. Covers this workflow's own
            runs; sub-workflow runs are not included. {note}
          </>
        }
      />
      <StatPanel
        label="Agent-hours saved"
        value={<span className="font-mono tabular-nums">{formatHours(row.hoursSaved.p50)}</span>}
        detail={`${formatHours(row.hoursSaved.p10)} to ${formatHours(row.hoursSaved.p90)}`}
        info={`Agent-active hours the same work would have taken, minus the time it took. ${note}`}
      />
      <StatPanel
        label="Substituted runs"
        value={
          <span className="font-mono tabular-nums">
            {formatCount(row.substitutedRuns)} of {formatCount(row.runs)}
          </span>
        }
        detail={row.capApplied ? "Capped at 24 a day" : undefined}
        info="Runs an agent would have had to do. Skipped and cancelled runs do not count, and scheduled runs count at most 24 a day unless they started an agent task or a workflow."
      />
    </div>
  );
}
