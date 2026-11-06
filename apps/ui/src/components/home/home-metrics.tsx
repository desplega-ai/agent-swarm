/**
 * The Home metrics strip: the few numbers worth a glance, each a link to the
 * page behind it. Spend today against the 7-day average, sessions today and
 * the failures of the last 24 hours, cost per session, tokens and the cache
 * share, the subscription plan use (when a key reports it), and what runs now.
 * No vanity counts (agents online, totals of everything).
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useApiKeyStatuses } from "@/api/hooks/use-api-keys";
import { useDashboardCosts, useUsageSummary } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useMetrics } from "@/api/hooks/use-metrics";
import { useTasks } from "@/api/hooks/use-tasks";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { formatCost } from "@/lib/cost-format";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { formatTokens } from "@/lib/format-tokens";
import { cacheShare, percentDelta, planUsage, spendStats, usageDay } from "@/lib/home-metrics";
import { summarizeRecentFailures } from "@/lib/recent-failures";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY = { refetchInterval: 60_000, keepPreviousData: true } as const;
/** The same failed-task page Needs you reads, so the two share one query. */
const FAILURE_PAGE = 50;

export function HomeMetrics({ className }: { className?: string }) {
  const { supported } = useFeatureGate("1.82.0");
  if (!supported) return null;
  return <HomeMetricsStrip className={className} />;
}

function HomeMetricsStrip({ className }: { className?: string }) {
  const now = useMinuteClock();
  const today = usageDay(now);
  const week = useUsageSummary({ startDate: usageDay(now - 7 * DAY_MS), groupBy: "day" }, QUERY);
  const todaySummary = useUsageSummary({ startDate: today }, QUERY);
  const costs = useDashboardCosts();
  const metrics = useMetrics();
  const keys = useApiKeyStatuses();
  const failed = useTasks({ status: "failed", limit: FAILURE_PAGE, orderBy: "lastUpdatedAt" });

  const spend = spendStats(week.data?.daily ?? [], today);
  // The sidebar's "today" figure, so the two never disagree.
  const spendToday = costs.data?.costToday ?? spend.today;
  const delta = percentDelta(spendToday, spend.average);
  const totals = todaySummary.data?.totals;
  const weekTotals = week.data?.totals;
  const failures = summarizeRecentFailures(failed.data?.tasks ?? [], FAILURE_PAGE, now);
  const failedCount = failed.data
    ? `${failures.tasks.length}${failures.complete ? "" : "+"}`
    : null;
  const plan = planUsage(keys.data ?? []);
  const running = metrics.data?.tasks.by_status.in_progress;
  const share = totals
    ? cacheShare(totals.totalInputTokens, totals.totalCacheReadTokens, totals.totalCacheWriteTokens)
    : null;

  return (
    <section
      aria-label="Key metrics"
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card shadow-sm md:grid-cols-3 xl:auto-cols-fr xl:grid-flow-col xl:grid-cols-none",
        className,
      )}
    >
      <Metric
        label="Spend today"
        to="/usage"
        value={formatCost(spendToday, { placeholder: "$0" })}
        aside={spend.series.length > 1 ? <Sparkline values={spend.series} /> : null}
        detail={
          delta && spend.average !== null
            ? `${delta} vs 7-day avg ${formatCost(spend.average, { placeholder: "$0" })}`
            : "At API prices"
        }
      />
      <Metric
        label="Sessions today"
        to="/sessions"
        value={totals ? totals.totalSessions.toLocaleString() : null}
        detail={
          failedCount === null ? null : (
            <span className={cn(failures.tasks.length > 0 && "text-status-error-strong")}>
              {failedCount} failed in 24h
            </span>
          )
        }
      />
      <Metric
        label="Cost per session"
        to="/usage"
        value={totals ? formatCost(totals.avgCostPerSession, { placeholder: "$0" }) : null}
        detail={
          weekTotals
            ? `7-day avg ${formatCost(weekTotals.avgCostPerSession, { placeholder: "$0" })}`
            : null
        }
      />
      <Metric
        label="Tokens today"
        to="/usage"
        value={totals ? formatTokens(totals.totalInputTokens + totals.totalOutputTokens) : null}
        detail={share === null ? null : `${share}% from cache reads`}
      />
      {plan ? (
        <Metric
          label="Plan use"
          to="/integrations/ai"
          value={
            <span className="flex flex-col gap-1 pt-1">
              <PlanBar label="5h" pct={plan.fiveHour} />
              <PlanBar label="7d" pct={plan.sevenDay} />
            </span>
          }
          detail={
            plan.fiveHourResetsAt && plan.fiveHourResetsAt > now
              ? `5h resets in ${formatDurationMs(plan.fiveHourResetsAt - now)}`
              : null
          }
        />
      ) : null}
      <Metric
        label="Running now"
        to="/tasks?status=in_progress"
        value={running === undefined ? null : running.toLocaleString()}
        detail={
          running === undefined ? null : running === 1 ? "task in progress" : "tasks in progress"
        }
      />
    </section>
  );
}

function Metric({
  label,
  to,
  value,
  detail,
  aside,
}: {
  label: string;
  to: string;
  value: ReactNode | null;
  detail: ReactNode | null;
  aside?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex min-w-0 flex-col gap-1 border-border-subtle px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:bg-accent [&:not(:first-child)]:border-l max-md:[&:nth-child(odd)]:border-l-0 max-md:[&:nth-child(n+3)]:border-t md:max-xl:[&:nth-child(3n+1)]:border-l-0 md:max-xl:[&:nth-child(n+4)]:border-t"
    >
      <span className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-end justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xl tabular-nums">
          {value ?? <span className="text-muted-foreground">—</span>}
        </span>
        {aside}
      </span>
      <span className="truncate text-xs text-muted-foreground">{detail ?? " "}</span>
    </Link>
  );
}

function PlanBar({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
      <span className="w-5">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            pct >= 90 ? "bg-status-error" : pct >= 70 ? "bg-status-warning" : "bg-foreground/60",
          )}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="w-8 text-right tabular-nums text-foreground">{pct}%</span>
    </span>
  );
}

/** Daily spend as a small line; the last point (today) is marked. */
function Sparkline({ values }: { values: number[] }) {
  const width = 64;
  const height = 22;
  const max = Math.max(...values, 0.01);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => [
    index * step,
    height - 2 - (value / max) * (height - 4),
  ]);
  const last = points[points.length - 1] ?? [0, 0];
  return (
    <svg
      aria-hidden="true"
      role="presentation"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible text-muted-foreground"
    >
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} className="fill-primary" />
    </svg>
  );
}
