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
import type { SessionCost } from "@/api/types";

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

interface UsageSummaryProps {
  costs: SessionCost[];
  daysBack?: number;
}

export function UsageSummary({ costs, daysBack = 30 }: UsageSummaryProps) {
  const stats = useMemo(() => {
    const totalCost = costs.reduce((s, c) => s + c.totalCostUsd, 0);
    const totalTokens = costs.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0);
    const totalDuration = costs.reduce((s, c) => s + c.durationMs, 0);
    return {
      totalCost,
      totalTokens,
      sessions: costs.length,
      totalDuration,
      avgCost: costs.length > 0 ? totalCost / costs.length : 0,
    };
  }, [costs]);

  const dailyData = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);

    const dayMap = new Map<string, number>();
    for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
      dayMap.set(d.toISOString().slice(0, 10), 0);
    }

    for (const c of costs) {
      const day = c.createdAt.slice(0, 10);
      if (dayMap.has(day)) {
        dayMap.set(day, (dayMap.get(day) ?? 0) + c.totalCostUsd);
      }
    }

    return Array.from(dayMap.entries()).map(([date, cost]) => ({
      date: date.slice(5),
      cost: Math.round(cost * 1000) / 1000,
    }));
  }, [costs, daysBack]);

  if (costs.length === 0) {
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
