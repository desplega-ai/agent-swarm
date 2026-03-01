import { useMemo } from "react";
import { formatCurrency, formatCompactNumber, formatDuration } from "@/lib/utils";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { DollarSign, Coins, Activity, Clock, TrendingUp } from "lucide-react";
import type { SessionCost, UsageSummaryTotals, UsageSummaryDailyRow } from "@/api/types";

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
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

const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-foreground)",
};

// New interface: accepts pre-aggregated data from server
interface UsageSummaryAggregatedProps {
  totals: UsageSummaryTotals;
  dailyData: UsageSummaryDailyRow[];
  daysBack?: number;
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

  return (
    <div className="space-y-4">
      {/* Stats Strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total Cost" value={formatCurrency(stats.totalCost)} icon={DollarSign} />
        <StatCard label="Tokens" value={formatCompactNumber(stats.totalTokens)} icon={Coins} />
        <StatCard label="Sessions" value={String(stats.sessions)} icon={Activity} />
        <StatCard label="Total Time" value={formatDuration(stats.totalDuration)} icon={Clock} />
        <StatCard label="Avg/Session" value={formatCurrency(stats.avgCost)} icon={TrendingUp} />
      </div>

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
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`$${Number(value).toFixed(3)}`, "Cost"]} />
            <Line type="monotone" dataKey="cost" stroke="var(--color-primary)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
