import { useState, useMemo } from "react";
import { useUsageSummary } from "@/api/hooks/use-costs";
import { useAgents } from "@/api/hooks/use-agents";
import { formatCurrency, formatCompactNumber } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageSummary } from "@/components/shared/usage-summary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type DateRange = "7d" | "30d" | "90d" | "all";

const DAYS_MAP: Record<DateRange, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };

function getStartDateISO(range: DateRange): string | undefined {
  const days = DAYS_MAP[range];
  if (days == null) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-foreground)",
};

export default function UsagePage() {
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [agentFilter, setAgentFilter] = useState("all");

  const startDate = getStartDateISO(dateRange);
  const agentId = agentFilter !== "all" ? agentFilter : undefined;

  const { data: summary, isLoading } = useUsageSummary({
    startDate,
    agentId,
    groupBy: "both",
  });
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  const agentData = useMemo(() => {
    if (!summary?.byAgent) return [];
    return summary.byAgent.map((a) => ({
      agentId: a.agentId,
      name: agentMap.get(a.agentId) ?? a.agentId.slice(0, 8) + "...",
      cost: Math.round(a.costUsd * 1000) / 1000,
      sessions: a.sessions,
      tokens: a.inputTokens + a.outputTokens,
      avgCost: a.sessions > 0 ? a.costUsd / a.sessions : 0,
    }));
  }, [summary, agentMap]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Usage</h1>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
      {/* Header + Filters */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Usage</h1>
        <div className="flex items-center gap-2">
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {agents?.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Shared stats + daily chart — using pre-aggregated data */}
      {summary && (
        <UsageSummary
          totals={summary.totals}
          dailyData={summary.daily}
          daysBack={DAYS_MAP[dateRange] ?? 90}
        />
      )}

      {/* Cost by Agent — bar chart + table */}
      {agentData.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Cost by Agent</p>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <ResponsiveContainer width="100%" height={Math.max(180, agentData.length * 36)}>
              <BarChart data={agentData.slice(0, 10)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} width={100} />
                <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`$${Number(value).toFixed(3)}`, "Cost"]} />
                <Bar dataKey="cost" fill="var(--color-primary)" radius={[0, 4, 4, 0]} barSize={20} />
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 font-medium">Agent</th>
                    <th className="text-right py-2 font-medium">Cost</th>
                    <th className="text-right py-2 font-medium">Sessions</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">Avg/Sess</th>
                  </tr>
                </thead>
                <tbody>
                  {agentData.map((agent) => (
                    <tr key={agent.agentId} className="border-b border-border/50">
                      <td className="py-2 font-medium">{agent.name}</td>
                      <td className="py-2 text-right font-mono">{formatCurrency(agent.cost)}</td>
                      <td className="py-2 text-right font-mono">{agent.sessions}</td>
                      <td className="py-2 text-right font-mono">{formatCompactNumber(agent.tokens)}</td>
                      <td className="py-2 text-right font-mono">{formatCurrency(agent.avgCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
