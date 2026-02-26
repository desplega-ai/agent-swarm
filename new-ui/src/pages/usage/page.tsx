import { useMemo } from "react";
import { useMonthlyUsageStats, useSessionCosts } from "@/api/hooks/use-costs";
import { useAgents } from "@/api/hooks/use-agents";
import { formatCurrency, formatCompactNumber } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { DollarSign, Coins, Activity, TrendingUp } from "lucide-react";

const CHART_COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];

export default function UsagePage() {
  const { data: monthlyStats, isLoading: statsLoading } = useMonthlyUsageStats();
  const { data: costs, isLoading: costsLoading } = useSessionCosts({ limit: 1000 });
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  // Daily cost data (last 30 days)
  const dailyData = useMemo(() => {
    if (!costs) return [];
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);

    const dayMap = new Map<string, number>();
    for (let d = new Date(thirtyDaysAgo); d <= now; d.setDate(d.getDate() + 1)) {
      dayMap.set(d.toISOString().slice(0, 10), 0);
    }

    for (const c of costs) {
      const day = c.createdAt.slice(0, 10);
      if (dayMap.has(day)) {
        dayMap.set(day, (dayMap.get(day) ?? 0) + c.totalCostUsd);
      }
    }

    return Array.from(dayMap.entries()).map(([date, cost]) => ({
      date: date.slice(5), // MM-DD
      cost: Math.round(cost * 1000) / 1000,
    }));
  }, [costs]);

  // Token breakdown for pie chart
  const tokenBreakdown = useMemo(() => {
    if (!monthlyStats) return [];
    return [
      { name: "Input", value: monthlyStats.inputTokens },
      { name: "Output", value: monthlyStats.outputTokens },
      { name: "Cache Read", value: monthlyStats.cacheReadTokens },
      { name: "Cache Write", value: monthlyStats.cacheWriteTokens },
    ].filter((d) => d.value > 0);
  }, [monthlyStats]);

  // Cost by agent (bar chart + leaderboard)
  const agentCosts = useMemo(() => {
    if (!costs) return [];
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const agentTotals = new Map<string, { cost: number; sessions: number }>();
    for (const c of costs) {
      if (new Date(c.createdAt) < startOfMonth) continue;
      const prev = agentTotals.get(c.agentId) ?? { cost: 0, sessions: 0 };
      agentTotals.set(c.agentId, {
        cost: prev.cost + c.totalCostUsd,
        sessions: prev.sessions + 1,
      });
    }

    return Array.from(agentTotals.entries())
      .map(([agentId, data]) => ({
        agentId,
        name: agentMap.get(agentId) ?? agentId.slice(0, 8) + "...",
        cost: Math.round(data.cost * 1000) / 1000,
        sessions: data.sessions,
        avgCost: data.sessions > 0 ? data.cost / data.sessions : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [costs, agentMap]);

  if (statsLoading || costsLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Usage</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
      <h1 className="text-xl font-semibold">Usage</h1>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm text-muted-foreground">Monthly Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">
              {formatCurrency(monthlyStats?.totalCostUsd ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm text-muted-foreground">Monthly Tokens</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">
              {formatCompactNumber(monthlyStats?.totalTokens ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm text-muted-foreground">Sessions</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">{monthlyStats?.sessionCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm text-muted-foreground">Avg Cost/Session</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">
              {formatCurrency(monthlyStats?.avgCostPerSession ?? 0)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Daily Cost Line Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Daily Cost (Last 30 Days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} />
                  <YAxis
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value) => [`$${Number(value).toFixed(3)}`, "Cost"]}
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
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">No data</p>
            )}
          </CardContent>
        </Card>

        {/* Token Breakdown Pie */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Token Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {tokenBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={tokenBreakdown}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={90}
                    dataKey="value"
                    label={({ name, percent }) =>
                      `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {tokenBreakdown.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value) => [formatCompactNumber(Number(value)), "Tokens"]}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">No data</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost by Agent Bar Chart */}
      {agentCosts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Cost by Agent (Monthly)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={agentCosts.slice(0, 10)}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [`$${Number(value).toFixed(3)}`, "Cost"]}
                />
                <Bar dataKey="cost" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Agent Leaderboard */}
      {agentCosts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Agent Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Monthly Cost</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Avg Cost/Session</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentCosts.map((agent, i) => (
                  <TableRow key={agent.agentId}>
                    <TableCell className="font-mono text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(agent.cost)}
                    </TableCell>
                    <TableCell className="text-right font-mono">{agent.sessions}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(agent.avgCost)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
