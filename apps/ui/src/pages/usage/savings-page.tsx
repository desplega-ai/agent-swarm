import { AlertCircle, PiggyBank } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useFleetSavings } from "@/api/hooks/use-savings";
import { useScripts } from "@/api/hooks/use-scripts";
import type { SavingsJobRow, SavingsKindTotals, SavingsTier } from "@/api/types";
import { SavingsDailyChart } from "@/components/savings/savings-daily-chart";
import {
  calibrationNote,
  DetailRow,
  formatHours,
  TIER_MODEL,
} from "@/components/savings/workflow-savings";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusLine } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";
import { RankedSpendCard, type RankedSpendRow } from "./ranked-spend-card";
import { formatCount, formatDay, formatUsd } from "./usage-format";

type Range = "7d" | "30d" | "90d";
const RANGE_DAYS: Record<Range, 7 | 30 | 90> = { "7d": 7, "30d": 30, "90d": 90 };
const RANGE_OPTIONS: readonly SegmentedControlOption<Range>[] = [
  { value: "7d", label: "7d", tooltip: "Last 7 days" },
  { value: "30d", label: "30d", tooltip: "Last 30 days" },
  { value: "90d", label: "90d", tooltip: "Last 90 days" },
];
const TIERS: readonly SavingsTier[] = ["smol", "regular", "smart", "ultra"];
const TIER_OPTIONS: readonly SegmentedControlOption<SavingsTier>[] = TIERS.map((tier) => ({
  value: tier,
  label: tier,
  tooltip: `Agents on ${TIER_MODEL[tier]}`,
}));

const coerceRange = (v: string): Range => (v in RANGE_DAYS ? (v as Range) : "30d");
const coerceTier = (v: string): SavingsTier =>
  TIERS.includes(v as SavingsTier) ? (v as SavingsTier) : "smart";

function rankedRows(rows: SavingsJobRow[], href: (row: SavingsJobRow) => string | undefined) {
  return rows
    .filter((row) => row.savingUsd.p50 !== 0)
    .map<RankedSpendRow>((row) => ({
      key: row.workflowId ?? row.scriptName ?? row.name,
      name: row.name,
      href: href(row),
      costUsd: row.savingUsd.p50,
      count: row.substitutedRuns,
    }));
}

function KindRow({ label, kind }: { label: string; kind: SavingsKindTotals }) {
  return (
    <DetailRow label={label}>
      {formatUsd(kind.savingUsd)}
      <span className="text-muted-foreground">
        {" "}
        · {formatCount(kind.jobs)} {kind.jobs === 1 ? "job" : "jobs"}
      </span>
    </DetailRow>
  );
}

/**
 * The fleet savings page: what every workflow and script saved against doing
 * the same work with agent tasks, over a window and at a tier from the URL.
 */
export function SavingsPage() {
  const { searchParams, setParam } = useUrlSearchState();
  const range = coerceRange(readStringParam(searchParams, "range", "30d"));
  const tier = coerceTier(readStringParam(searchParams, "tier", "smart"));
  const setRange = useCallback(
    (value: string) => setParam("range", coerceRange(value), { defaultValue: "30d" }),
    [setParam],
  );
  const setTier = useCallback(
    (value: string) => setParam("tier", coerceTier(value), { defaultValue: "smart" }),
    [setParam],
  );

  const { summary, daily, workflows, scripts } = useFleetSavings({
    days: RANGE_DAYS[range],
    tier,
  });
  const { data: catalog } = useScripts({ scope: "all" });

  // Savings rows are keyed by script name; link to the global script of that name first.
  const scriptIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const s of catalog ?? []) {
      if (s.scope === "global" || !ids.has(s.name)) ids.set(s.name, s.id);
    }
    return ids;
  }, [catalog]);
  const workflowRows = useMemo(
    () => rankedRows(workflows.data?.rows ?? [], (row) => `/workflows/${row.workflowId}`),
    [workflows.data],
  );
  const scriptRows = useMemo(
    () =>
      rankedRows(scripts.data?.rows ?? [], (row) => {
        const id = row.scriptName ? scriptIds.get(row.scriptName) : undefined;
        return id ? `/scripts/${id}` : undefined;
      }),
    [scripts.data, scriptIds],
  );

  const data = summary.data;
  const updating = summary.isPlaceholderData || daily.isPlaceholderData;
  const windowLabel = data
    ? `${formatDay(data.window.start.slice(0, 10))} to ${formatDay(data.window.end.slice(0, 10), true)}`
    : "";

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
        <span className="truncate">{windowLabel}</span>
        {updating ? (
          <StatusLine tone="busy" className="text-xs">
            Updating
          </StatusLine>
        ) : null}
      </div>
      <SegmentedControl
        aria-label="Agent tier"
        value={tier}
        onValueChange={setTier}
        options={TIER_OPTIONS}
      />
      <SegmentedControl
        aria-label="Date range"
        value={range}
        onValueChange={setRange}
        options={RANGE_OPTIONS}
      />
    </div>
  );

  let body: ReactNode;
  if (summary.isLoading) {
    body = <SavingsSkeleton />;
  } else if (!data) {
    body = (
      <AlertCallout tone="error" icon={AlertCircle}>
        Could not load the savings. {summary.error instanceof Error ? summary.error.message : null}
      </AlertCallout>
    );
  } else if (!data.valid || !data.total || !data.byKind) {
    body = (
      <EmptyState
        icon={PiggyBank}
        title={data.reason === "not-computed" ? "Not computed yet" : "No runs in this window"}
        description={
          data.reason === "not-computed"
            ? `The savings rollup is still filling the last ${data.window.days} days. It runs every hour.`
            : "No workflow or script ran in this range. Pick a longer range."
        }
      />
    );
  } else {
    const { total, byKind } = data;
    const note = calibrationNote(data);
    body = (
      <div
        className={cn(
          "@container space-y-4 transition-opacity duration-150 ease-snappy",
          updating && "opacity-60",
        )}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatPanel
            label={`Saved (${data.window.days}d)`}
            value={
              <span className="font-mono tabular-nums text-status-success-strong">
                {formatUsd(total.savingUsd.p50)}
              </span>
            }
            detail={`${formatUsd(total.savingUsd.p10)} to ${formatUsd(total.savingUsd.p90)}`}
            info={`What every workflow and script run would have cost as agent tasks, minus their estimated cost. The range is the fleet's 80% band. ${note}`}
          />
          <StatPanel
            label="Agent-hours saved"
            value={
              <span className="font-mono tabular-nums">{formatHours(total.hoursSaved.p50)}</span>
            }
            detail={`${formatHours(total.hoursSaved.p10)} to ${formatHours(total.hoursSaved.p90)}`}
            info={`Agent-active hours the same work would have taken, minus the time it took. ${note}`}
          />
          <StatPanel
            label="Self-optimization"
            value={
              <span className="font-mono tabular-nums">
                {data.selfOptimizationRatio === null
                  ? "n/a"
                  : `${data.selfOptimizationRatio.toFixed(1)}x`}
              </span>
            }
            detail={`vs ${formatUsd(data.fleetLlmUsd)} agent spend`}
            info="What the swarm would have spent without its automations, per dollar it spent on agent sessions in the window: (spend + saved) / spend."
          />
          <StatPanel
            label="Automation cost (est.)"
            value={<span className="font-mono tabular-nums">{formatUsd(total.actualUsd)}</span>}
            detail={`${formatUsd(total.measuredUsd)} measured`}
            info="What the substituted runs cost: agent tasks they started, their reviews and LLM calls, scaled to the substituted share of runs. Measured is the unscaled recorded spend of every run."
          />
        </div>

        {daily.data?.valid ? (
          <SavingsDailyChart points={daily.data.points} capApplied={false} />
        ) : daily.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : null}

        <div className="grid gap-4 @4xl:grid-cols-2">
          <RankedSpendCard
            title="Top workflows"
            nameLabel="Workflow"
            rows={workflowRows}
            valueLabel="Saved"
            valueTone="success"
            countLabel="Runs"
          />
          <RankedSpendCard
            title="Top scripts"
            nameLabel="Script"
            rows={scriptRows}
            valueLabel="Saved"
            valueTone="success"
            countLabel="Runs"
          />
        </div>

        <div className="grid gap-4 @4xl:grid-cols-2">
          <Card className="gap-2 py-4">
            <CardHeader className="px-5">
              <CardTitle>By kind</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <dl className="text-sm">
                <KindRow label="Workflows" kind={byKind.workflows} />
                <KindRow label="Scheduled scripts" kind={byKind.scheduledScripts} />
                <KindRow label="Scripts called by agents" kind={byKind.agentInvokedScripts} />
                <DetailRow label="Substituted runs">
                  {formatCount(total.substitutedRuns)} of {formatCount(total.runs)}
                </DetailRow>
              </dl>
              <p className="pt-2 text-xs text-muted-foreground">
                Excluded: {formatCount(data.excluded?.enabledOnlyRuns ?? 0)} runs an agent would not
                have done (router events and API calls with no effect, polls above 24 a day, skipped
                and cancelled runs).
              </p>
            </CardContent>
          </Card>
          <Card className="gap-2 py-4">
            <CardHeader className="px-5">
              <CardTitle>Method</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-5 text-xs leading-relaxed text-muted-foreground">
              <p>
                Each counted run is priced as the agent session that would have done the same work,
                with its length growing with the run's deterministic operations. The saving is that
                cost minus what the run cost. {note}
              </p>
              <details>
                <summary className="cursor-pointer text-foreground">Assumptions</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {data.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pb-6">
      {toolbar}
      {body}
    </div>
  );
}

function SavingsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
