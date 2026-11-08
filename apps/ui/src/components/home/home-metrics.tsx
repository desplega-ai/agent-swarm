/**
 * The Home metrics strip: the few numbers worth a glance, each a link to the
 * page behind it. Spend today (with what subscriptions saved today against API
 * prices), sessions today and the failures of the last 24 hours, cost per
 * session over the week, tokens and the cache share, what the swarm's
 * workflows and scripts saved in 30 days, and what runs now. No vanity counts
 * (agents online, totals of everything). Plan use lives on Connect › AI
 * providers.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSubscriptionPlans } from "@/api/hooks/use-api-keys";
import { useDashboardCosts, useUsageSummary } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useMetrics } from "@/api/hooks/use-metrics";
import { useHomeSavings } from "@/api/hooks/use-savings";
import { useTasks } from "@/api/hooks/use-tasks";
import { formatHours } from "@/components/savings/workflow-savings";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { formatCost } from "@/lib/cost-format";
import { formatTokens } from "@/lib/format-tokens";
import { cacheShare, costPerSessionSeries, spendStats, usageDay } from "@/lib/home-metrics";
import { summarizeRecentFailures } from "@/lib/recent-failures";
import { subscriptionSavings } from "@/lib/subscription-savings";
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
  // `both` adds the per-credential rows that "Subs saved today" needs.
  const todaySummary = useUsageSummary({ startDate: today, groupBy: "both" }, QUERY);
  const { data: plans } = useSubscriptionPlans();
  const costs = useDashboardCosts();
  const metrics = useMetrics();
  const savings = useHomeSavings();
  const failed = useTasks({ status: "failed", limit: FAILURE_PAGE, orderBy: "lastUpdatedAt" });

  const spend = spendStats(week.data?.daily ?? [], today);
  // The sidebar's "today" figure, so the two never disagree.
  const spendToday = costs.data?.costToday ?? spend.today;
  const perSession = costPerSessionSeries(week.data?.daily ?? [], today);
  // What subscription runs today would cost at API prices, minus a day of
  // their plans. Null until a subscription with a known plan ran today.
  const subs = todaySummary.data?.byCredential
    ? subscriptionSavings(
        todaySummary.data.byCredential,
        plans?.plans ?? [],
        Date.parse(`${today}T00:00:00Z`),
        now,
      )
    : null;
  const subsSaved = subs && subs.counted.length > 0 ? subs.saved : null;
  const totals = todaySummary.data?.totals;
  const weekTotals = week.data?.totals;
  const failures = summarizeRecentFailures(failed.data?.tasks ?? [], FAILURE_PAGE, now);
  const failedCount = failed.data
    ? `${failures.tasks.length}${failures.complete ? "" : "+"}`
    : null;
  const savedTotal = savings.summary.data?.valid ? savings.summary.data.total : null;
  const running = metrics.data?.tasks.by_status.in_progress;
  const share = totals
    ? cacheShare(totals.totalInputTokens, totals.totalCacheReadTokens, totals.totalCacheWriteTokens)
    : null;

  return (
    <section
      aria-label="Key metrics"
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card shadow-sm @3xl/home:grid-cols-3 @5xl/home:auto-cols-fr @5xl/home:grid-flow-col @5xl/home:grid-cols-none",
        className,
      )}
    >
      <Metric
        label="Spend today"
        to="/usage"
        value={formatCost(spendToday, { placeholder: "$0" })}
        aside={spend.series.length > 1 ? <Sparkline values={spend.series} /> : null}
        detail={
          subsSaved !== null && subsSaved > 0 ? (
            <span className="text-status-success-strong">
              Subs saved {formatCost(subsSaved, { placeholder: "$0" })} today
            </span>
          ) : (
            "At API prices"
          )
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
        aside={perSession.series.length > 1 ? <Sparkline values={perSession.series} /> : null}
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
      {savings.summary.isError ? null : (
        <Metric
          label="Swarm saved (30d)"
          to="/usage/savings"
          value={
            savings.summary.data
              ? formatCost(savedTotal?.savingUsd.p50 ?? 0, { placeholder: "$0" })
              : null
          }
          detail={
            savedTotal
              ? `${formatHours(savedTotal.hoursSaved.p50)} of agent time`
              : savings.summary.data
                ? "No workflow or script runs yet"
                : null
          }
        />
      )}
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
      className="flex min-w-0 flex-col gap-1 border-border-subtle px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:bg-accent [&:not(:first-child)]:border-l @max-3xl/home:[&:nth-child(odd)]:border-l-0 @max-3xl/home:[&:nth-child(n+3)]:border-t @3xl/home:@max-5xl/home:[&:nth-child(3n+1)]:border-l-0 @3xl/home:@max-5xl/home:[&:nth-child(n+4)]:border-t"
    >
      <span className="line-clamp-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-end justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xl tabular-nums">
          {value ?? <span className="text-muted-foreground">–</span>}
        </span>
        {aside}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{detail ?? " "}</span>
    </Link>
  );
}

/** A daily value as a small line; the last point (today) is marked. */
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
