import type { ReactNode } from "react";
import type { UsageSummaryTotals } from "@/api/types";
import { StatPanel } from "@/components/ui/stat-panel";
import { cn, formatCompactNumber } from "@/lib/utils";
import { formatCount, formatRunTime, formatUsd } from "./usage-format";

function KpiValue({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xl tabular-nums">{children}</span>;
}

/** Spend, sessions, tokens, and (when the API sends it) attributed spend. */
export function UsageKpis({ totals }: { totals: UsageSummaryTotals }) {
  // Share of spend whose task carries a human requester, over the corrected
  // denominator (`attributableCostUsd` = total cost minus work that has no
  // human by construction: heartbeat, boot triage, scheduled runs, and their
  // self-maintenance follow-ups). Dividing by the total instead would deflate
  // the number with spend that could never have a requester.
  const attributedPct =
    totals.attributedCostUsd !== undefined &&
    totals.attributableCostUsd !== undefined &&
    totals.attributableCostUsd > 0
      ? (totals.attributedCostUsd / totals.attributableCostUsd) * 100
      : null;

  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3",
        attributedPct === null ? "@2xl:grid-cols-3" : "@2xl:grid-cols-4",
      )}
    >
      <StatPanel
        label="Spend"
        value={<KpiValue>{formatUsd(totals.totalCostUsd)}</KpiValue>}
        detail="At API prices"
      />
      <StatPanel
        label="Sessions"
        value={<KpiValue>{formatCount(totals.totalSessions)}</KpiValue>}
        detail={`${formatUsd(totals.avgCostPerSession)} per session, ${formatRunTime(totals.totalDurationMs)} run time`}
      />
      <StatPanel
        label="Tokens"
        value={
          <KpiValue>
            {formatCompactNumber(totals.totalInputTokens + totals.totalOutputTokens)}
          </KpiValue>
        }
        detail={`${formatCompactNumber(totals.totalCacheReadTokens)} cache read`}
      />
      {attributedPct !== null ? (
        <StatPanel
          label="Attributed spend"
          value={<KpiValue>{`${attributedPct.toFixed(1)}%`}</KpiValue>}
          detail={`${formatUsd(totals.attributedCostUsd ?? 0)} of ${formatUsd(totals.attributableCostUsd ?? 0)}`}
          info={
            `Share of spend on tasks with a named human requester, out of spend that could ` +
            `plausibly carry one. Excludes ${formatCompactNumber(totals.excludedTaskCount ?? 0)} ` +
            `heartbeat / boot-triage / scheduled tasks and their self-maintenance follow-ups ` +
            `(these have no human requester by construction, so counting them against ` +
            `coverage would misrepresent it). The remainder of the denominator is still ` +
            `unattributed autonomous or unmatched work.`
          }
        />
      ) : null}
    </div>
  );
}
