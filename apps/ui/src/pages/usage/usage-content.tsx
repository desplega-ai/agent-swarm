import { useCallback, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAgents } from "@/api/hooks/use-agents";
import { useUsageSummary } from "@/api/hooks/use-costs";
import { useUsers } from "@/api/hooks/use-users";
import { UsageSummary } from "@/components/shared/usage-summary";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatCost } from "@/lib/cost-format";
import { rechartsTooltipStyle } from "@/lib/recharts-tooltip-style";
import { formatCompactNumber } from "@/lib/utils";

type DateRange = "7d" | "30d" | "90d" | "all";

/** Server-side sentinel selecting spend with no human requester. */
const UNATTRIBUTED = "unattributed";

const DAYS_MAP: Record<DateRange, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };
const DATE_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);

function coerceDateRange(value: string): DateRange {
  return DATE_RANGES.has(value) ? (value as DateRange) : "30d";
}

function getStartDateISO(range: DateRange): string | undefined {
  const days = DAYS_MAP[range];
  if (days == null) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function UsageContent() {
  const { searchParams, setParam } = useUrlSearchState();
  const dateRange = coerceDateRange(readStringParam(searchParams, "range", "30d"));
  const agentFilter = readStringParam(searchParams, "agent", "all");
  const userFilter = readStringParam(searchParams, "user", "all");
  const setDateRange = useCallback(
    (range: string) => setParam("range", coerceDateRange(range), { defaultValue: "30d" }),
    [setParam],
  );
  const setAgentFilter = useCallback(
    (agent: string) => setParam("agent", agent, { defaultValue: "all" }),
    [setParam],
  );
  const setUserFilter = useCallback(
    (user: string) => setParam("user", user, { defaultValue: "all" }),
    [setParam],
  );

  const startDate = getStartDateISO(dateRange);
  const agentId = agentFilter !== "all" ? agentFilter : undefined;
  const userId = userFilter !== "all" ? userFilter : undefined;

  const { data: summary, isLoading } = useUsageSummary({
    startDate,
    agentId,
    userId,
    groupBy: "both",
  });
  const { data: agents } = useAgents();
  const { data: users } = useUsers();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const userMap = useMemo(() => {
    const m = new Map<string, string>();
    users?.forEach((u) => {
      m.set(u.id, u.name);
    });
    return m;
  }, [users]);

  const agentData = useMemo(() => {
    if (!summary?.byAgent) return [];
    return summary.byAgent.map((a) => ({
      agentId: a.agentId,
      name: agentMap.get(a.agentId) ?? `${a.agentId.slice(0, 8)}...`,
      cost: Math.round(a.costUsd * 1000) / 1000,
      sessions: a.sessions,
      tokens: a.inputTokens + a.outputTokens,
      avgCost: a.sessions > 0 ? a.costUsd / a.sessions : 0,
    }));
  }, [summary, agentMap]);

  // `userId: null` is autonomous spend (heartbeat, boot triage) — it gets its
  // own labelled row instead of being dropped or folded into a person.
  const userData = useMemo(() => {
    if (!summary?.byUser) return [];
    return summary.byUser.map((u) => ({
      key: u.userId ?? UNATTRIBUTED,
      name: u.userId
        ? (userMap.get(u.userId) ?? `${u.userId.slice(0, 8)}...`)
        : "Unattributed (autonomous)",
      isUnattributed: u.userId === null,
      cost: Math.round(u.costUsd * 1000) / 1000,
      tasks: u.tasks,
      tokens: u.inputTokens + u.outputTokens,
      avgCost: u.tasks > 0 ? u.costUsd / u.tasks : 0,
    }));
  }, [summary, userMap]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Usage" />
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
      <PageHeader
        title="Usage"
        action={
          <>
            <Select value={dateRange} onValueChange={setDateRange}>
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
                    {a.isLead ? " (Lead)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="w-[250px]">
                <SelectValue placeholder="User" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                <SelectItem value={UNATTRIBUTED}>Unattributed (autonomous)</SelectItem>
                {users?.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

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
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">
            Cost by Agent
          </p>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <ResponsiveContainer width="100%" height={Math.max(180, agentData.length * 36)}>
              <BarChart data={agentData.slice(0, 10)} layout="vertical">
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(v) => `$${v}`}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  width={100}
                />
                <Tooltip
                  contentStyle={rechartsTooltipStyle}
                  formatter={(value) => [formatCost(Number(value), { precision: 3 }), "Cost"]}
                />
                <Bar
                  dataKey="cost"
                  fill="var(--color-primary)"
                  radius={[0, 4, 4, 0]}
                  barSize={20}
                />
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
                      <td className="py-2 text-right font-mono">{formatCost(agent.cost)}</td>
                      <td className="py-2 text-right font-mono">{agent.sessions}</td>
                      <td className="py-2 text-right font-mono">
                        {formatCompactNumber(agent.tokens)}
                      </td>
                      <td className="py-2 text-right font-mono">{formatCost(agent.avgCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Cost by User — who asked for the work. Unattributed spend is its own row. */}
      {userData.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">
            Cost by User
          </p>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <ResponsiveContainer width="100%" height={Math.max(180, userData.length * 36)}>
              <BarChart data={userData.slice(0, 10)} layout="vertical">
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(v) => `$${v}`}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  width={140}
                />
                <Tooltip
                  contentStyle={rechartsTooltipStyle}
                  formatter={(value) => [formatCost(Number(value), { precision: 3 }), "Cost"]}
                />
                <Bar dataKey="cost" radius={[0, 4, 4, 0]} barSize={20}>
                  {userData.slice(0, 10).map((u) => (
                    <Cell
                      key={u.key}
                      fill={
                        u.isUnattributed ? "var(--color-muted-foreground)" : "var(--color-primary)"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left py-2 font-medium">User</th>
                    <th className="text-right py-2 font-medium">Cost</th>
                    <th className="text-right py-2 font-medium">Tasks</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">Avg/Task</th>
                  </tr>
                </thead>
                <tbody>
                  {userData.map((user) => (
                    <tr key={user.key} className="border-b border-border/50">
                      <td
                        className={`py-2 ${user.isUnattributed ? "italic text-muted-foreground" : "font-medium"}`}
                      >
                        {user.name}
                      </td>
                      <td className="py-2 text-right font-mono">{formatCost(user.cost)}</td>
                      <td className="py-2 text-right font-mono">{user.tasks}</td>
                      <td className="py-2 text-right font-mono">
                        {formatCompactNumber(user.tokens)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {user.tasks > 0 ? formatCost(user.avgCost) : "—"}
                      </td>
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
