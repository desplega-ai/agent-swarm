import { Activity, Clock, Coins, DollarSign, PiggyBank, TrendingUp, UserCheck } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SessionCost, UsageSummaryDailyRow, UsageSummaryTotals } from "@/api/types";
import { formatCost } from "@/lib/cost-format";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { formatCompactNumber, formatDuration } from "@/lib/utils";

function StatCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3" title={hint}>
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div>
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-lg font-bold font-mono">{value}</p>
      </div>
    </div>
  );
}

// Claude Max 20x list price (claude.com/pricing, checked 2026-09-25). Editable in the UI.
const DEFAULT_PLAN_PRICE_USD = 200;
const PLAN_PRICE_STORAGE_KEY = "usage.subscriptionPlanPriceUsd";
const DAYS_PER_MONTH = 30.44;

/**
 * Savings from running on Claude subscriptions instead of API keys:
 * API-priced cost of OAuth sessions minus plan price x credentials, prorated to the window.
 */
function SubscriptionSavings({
  totals,
  windowDays,
}: {
  totals: UsageSummaryTotals;
  windowDays: number;
}) {
  const [planPrice, setPlanPrice] = useState(() => {
    const stored = Number(localStorage.getItem(PLAN_PRICE_STORAGE_KEY));
    return stored > 0 ? stored : DEFAULT_PLAN_PRICE_USD;
  });
  const apiCost = totals.subscriptionCostUsd ?? 0;
  const seats = totals.subscriptionCredentialCount ?? 0;
  const subscriptionCost = planPrice * seats * (windowDays / DAYS_PER_MONTH);
  const saved = apiCost - subscriptionCost;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
          <PiggyBank className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
            Saved vs API pricing
          </p>
          <p
            className={`text-lg font-bold font-mono ${saved >= 0 ? "text-emerald-500" : "text-red-500"}`}
          >
            {saved < 0 ? "-" : ""}
            {formatCost(Math.abs(saved))}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatCost(apiCost)} at API prices on subscription runs − {seats} subscription
        {seats === 1 ? "" : "s"} × {formatCost(planPrice)}/mo × {windowDays.toFixed(0)}d ={" "}
        {formatCost(subscriptionCost)}
      </p>
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        Plan price $/mo
        <input
          type="number"
          min={0}
          value={planPrice}
          onChange={(e) => {
            const v = Number(e.target.value);
            setPlanPrice(v);
            if (v > 0) localStorage.setItem(PLAN_PRICE_STORAGE_KEY, String(v));
          }}
          className="w-20 rounded-md border border-border bg-transparent px-2 py-1 font-mono"
        />
      </label>
    </div>
  );
}

// New interface: accepts pre-aggregated data from server
interface UsageSummaryAggregatedProps {
  totals: UsageSummaryTotals;
  dailyData: UsageSummaryDailyRow[];
  daysBack?: number;
  /** Length of the selected window in days, used to prorate the subscription price. */
  windowDays?: number;
}

// Legacy interface: accepts raw costs (used by agent detail page)
interface UsageSummaryRawProps {
  costs: SessionCost[];
  daysBack?: number;
}

type UsageSummaryProps = UsageSummaryAggregatedProps | UsageSummaryRawProps;

function isAggregatedProps(props: UsageSummaryProps): props is UsageSummaryAggregatedProps {
  return "totals" in props;
}

export function UsageSummary(props: UsageSummaryProps) {
  const daysBack = props.daysBack ?? 30;
  const totals = isAggregatedProps(props) ? props.totals : undefined;
  const costs = isAggregatedProps(props) ? undefined : props.costs;

  // Compute stats from either pre-aggregated or raw data
  const stats = useMemo(() => {
    if (totals) {
      return {
        totalCost: totals.totalCostUsd,
        totalTokens: totals.totalInputTokens + totals.totalOutputTokens,
        sessions: totals.totalSessions,
        totalDuration: totals.totalDurationMs,
        avgCost: totals.avgCostPerSession,
      };
    }
    // Legacy: compute from raw costs
    const c = costs ?? [];
    const totalCost = c.reduce((s, x) => s + x.totalCostUsd, 0);
    const totalTokens = c.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
    const totalDuration = c.reduce((s, x) => s + x.durationMs, 0);
    return {
      totalCost,
      totalTokens,
      sessions: c.length,
      totalDuration,
      avgCost: c.length > 0 ? totalCost / c.length : 0,
    };
  }, [totals, costs]);

  const aggregatedDailyData = isAggregatedProps(props) ? props.dailyData : undefined;

  // Compute daily chart data
  const dailyData = useMemo(() => {
    if (aggregatedDailyData) {
      // Use pre-aggregated daily data, just format dates for display
      return aggregatedDailyData.map((d) => ({
        date: d.date.slice(5),
        cost: Math.round(d.costUsd * 1000) / 1000,
      }));
    }
    // Legacy: compute from raw costs
    const c = costs ?? [];
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);

    const dayMap = new Map<string, number>();
    for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
      dayMap.set(d.toISOString().slice(0, 10), 0);
    }

    for (const x of c) {
      const day = x.createdAt.slice(0, 10);
      if (dayMap.has(day)) {
        dayMap.set(day, (dayMap.get(day) ?? 0) + x.totalCostUsd);
      }
    }

    return Array.from(dayMap.entries()).map(([date, cost]) => ({
      date: date.slice(5),
      cost: Math.round(cost * 1000) / 1000,
    }));
  }, [aggregatedDailyData, costs, daysBack]);

  const isEmpty = totals ? totals.totalSessions === 0 : (costs ?? []).length === 0;

  if (isEmpty) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">No usage data available</p>
    );
  }

  // Share of spend whose task carries a human requester, over the corrected
  // denominator (`attributableCostUsd` = totalCost minus structurally-human-free
  // work — heartbeat, boot-triage, scheduled runs, self-maintenance follow-ups).
  // Dividing by `totalCost` instead would silently deflate the number with a
  // population that could never have scored a requester in the first place.
  const attributedPct =
    totals?.attributedCostUsd !== undefined &&
    totals?.attributableCostUsd !== undefined &&
    totals.attributableCostUsd > 0
      ? (totals.attributedCostUsd / totals.attributableCostUsd) * 100
      : null;
  const excludedTaskCount = totals?.excludedTaskCount;

  return (
    <div className="space-y-4">
      {/* Stats Strip */}
      <div
        className={`grid gap-3 sm:grid-cols-2 ${attributedPct === null ? "lg:grid-cols-5" : "lg:grid-cols-6"}`}
      >
        <StatCard label="Total Cost" value={formatCost(stats.totalCost)} icon={DollarSign} />
        <StatCard label="Tokens" value={formatCompactNumber(stats.totalTokens)} icon={Coins} />
        <StatCard label="Sessions" value={String(stats.sessions)} icon={Activity} />
        <StatCard label="Total Time" value={formatDuration(stats.totalDuration)} icon={Clock} />
        <StatCard label="Avg/Session" value={formatCost(stats.avgCost)} icon={TrendingUp} />
        {attributedPct !== null && (
          <StatCard
            label="Attributed spend"
            value={`${attributedPct.toFixed(1)}%`}
            icon={UserCheck}
            hint={
              `Share of spend on tasks with a named human requester, out of spend that could ` +
              `plausibly carry one. Excludes ${formatCompactNumber(excludedTaskCount ?? 0)} ` +
              `heartbeat / boot-triage / scheduled tasks and their self-maintenance follow-ups ` +
              `(these have no human requester by construction, so counting them against ` +
              `coverage would misrepresent it). The remainder of the denominator is still ` +
              `unattributed autonomous or unmatched work.`
            }
          />
        )}
      </div>

      {totals?.subscriptionCostUsd !== undefined && isAggregatedProps(props) && (
        <SubscriptionSavings
          totals={totals}
          windowDays={props.windowDays ?? props.daysBack ?? 30}
        />
      )}

      {/* Daily Cost Chart */}
      <div className="rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Daily Cost</p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={dailyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              interval={Math.max(0, Math.floor(dailyData.length / 10))}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              tickFormatter={(v) => `$${v}`}
              width={50}
            />
            <Tooltip
              contentStyle={rechartsTooltipStyle}
              formatter={(value) => [formatCost(Number(value), { precision: 3 }), "Cost"]}
            />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
