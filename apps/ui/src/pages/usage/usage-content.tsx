import type { ColDef } from "ag-grid-community";
import { AlertCircle, BarChart3 } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import {
  type UsageQueryOptions,
  useAttributionByPerson,
  useUsageSummary,
} from "@/api/hooks/use-costs";
import { useUsers } from "@/api/hooks/use-users";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusLine } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";
import { DailySpendChart } from "./daily-spend-chart";
import { RankedSpendCard, type RankedSpendRow } from "./ranked-spend-card";
import { SubscriptionsCard } from "./subscriptions-card";
import { formatDay, todayIso } from "./usage-format";
import { UsageKpis } from "./usage-kpis";

type DateRange = "7d" | "30d" | "90d" | "all";

/** Server-side sentinel selecting spend with no human requester. */
const UNATTRIBUTED = "unattributed";

const DAYS_MAP: Record<DateRange, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };
const DATE_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);

const RANGE_OPTIONS: readonly SegmentedControlOption<DateRange>[] = [
  { value: "7d", label: "7d", tooltip: "Last 7 days" },
  { value: "30d", label: "30d", tooltip: "Last 30 days" },
  { value: "90d", label: "90d", tooltip: "Last 90 days" },
  { value: "all", label: "All", tooltip: "All time" },
];

/** Spend changes slowly: poll once a minute and keep old numbers up while a filter loads. */
const USAGE_QUERY: UsageQueryOptions = { refetchInterval: 60_000, keepPreviousData: true };

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
  // The per-person report is task-attribution based and does not implement
  // the session-cost agent/requester filters. Hide it rather than showing a
  // global report under filters that visibly scope the rest of the page.
  const showAttributionByPerson = !agentId && !userId;

  const {
    data: summary,
    isLoading,
    isPlaceholderData,
    error,
  } = useUsageSummary({ startDate, agentId, userId, groupBy: "both" }, USAGE_QUERY);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: attributionRows } = useAttributionByPerson(
    { startDate, enabled: showAttributionByPerson },
    USAGE_QUERY,
  );

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

  // The window runs from the range start (for "all", the first day with
  // spend) to today. The chart and the plan proration both use it.
  const today = todayIso();
  const firstDay = summary?.daily.reduce<string | undefined>(
    (min, row) => (min === undefined || row.date < min ? row.date : min),
    undefined,
  );
  const lastDay = summary?.daily.reduce((max, row) => (row.date > max ? row.date : max), today);
  const windowFrom = startDate ?? firstDay ?? today;
  const windowTo = lastDay ?? today;
  const windowLabel =
    dateRange === "all" && !summary
      ? "All time"
      : `${formatDay(windowFrom, windowFrom.slice(0, 4) !== windowTo.slice(0, 4))} to ${formatDay(windowTo, true)}`;

  const agentRows = useMemo<RankedSpendRow[]>(
    () =>
      (summary?.byAgent ?? []).map((a) => ({
        key: a.agentId,
        name: agentMap.get(a.agentId) ?? `${a.agentId.slice(0, 8)}...`,
        href: `/agents/${a.agentId}`,
        costUsd: a.costUsd,
        count: a.sessions,
      })),
    [summary, agentMap],
  );

  // `userId: null` is autonomous spend (heartbeat, boot triage). It gets its
  // own labelled row instead of being dropped or folded into a person.
  const userRows = useMemo<RankedSpendRow[]>(
    () =>
      (summary?.byUser ?? []).map((u) => ({
        key: u.userId ?? UNATTRIBUTED,
        name: u.userId
          ? (userMap.get(u.userId) ?? `${u.userId.slice(0, 8)}...`)
          : "Unattributed (autonomous)",
        href: u.userId ? `/people/${u.userId}` : undefined,
        costUsd: u.costUsd,
        count: u.tasks,
        muted: u.userId === null,
      })),
    [summary, userMap],
  );

  // Four metrics, side by side, never summed into one score. Sorted
  // alphabetically by name, NOT by any metric column: a default sort on raw
  // task count would silently endorse the most easily gamed column as "the"
  // ranking.
  const attributionData = useMemo(() => {
    if (!attributionRows) return [];
    return attributionRows
      .map((r) => ({
        userId: r.userId,
        name: userMap.get(r.userId) ?? `${r.userId.slice(0, 8)}...`,
        problemsInitiated: r.problemsInitiated,
        problemsShipped: r.problemsShipped,
        agentsReached: r.agentsReached,
        reposReached: r.reposReached,
        surfacesReached: r.surfacesReached,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [attributionRows, userMap]);

  const attributionColumns = useMemo<ColDef<(typeof attributionData)[number]>[]>(
    () => [
      { field: "name", headerName: "Person", flex: 1, minWidth: 110 },
      {
        field: "problemsInitiated",
        headerName: "Problems initiated",
        flex: 1.3,
        minWidth: 150,
      },
      {
        field: "problemsShipped",
        headerName: "Problems shipped",
        flex: 1.3,
        minWidth: 150,
        valueFormatter: ({ data, value }) => {
          if (!data || !data.problemsInitiated) return String(value ?? 0);
          return `${value ?? 0} (${(((value ?? 0) / data.problemsInitiated) * 100).toFixed(0)}%)`;
        },
      },
      {
        headerName: "Reach",
        flex: 2,
        minWidth: 210,
        valueGetter: ({ data }) =>
          data
            ? `${data.agentsReached} agents · ${data.reposReached} repos · ${data.surfacesReached} surfaces`
            : "",
      },
      {
        headerName: "First-pass yield",
        flex: 1.3,
        minWidth: 150,
        valueGetter: () => "not yet computed",
        sortable: false,
      },
    ],
    [],
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
        <span className="truncate">{windowLabel}</span>
        {isPlaceholderData ? (
          <StatusLine tone="busy" className="text-xs">
            Updating
          </StatusLine>
        ) : null}
      </div>
      <SegmentedControl
        aria-label="Date range"
        value={dateRange}
        onValueChange={setDateRange}
        options={RANGE_OPTIONS}
      />
      <div className="flex w-full gap-2 sm:w-auto">
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger aria-label="Agent" className="min-w-0 flex-1 sm:w-[180px] sm:flex-none">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.isLead ? " (Lead)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger aria-label="User" className="min-w-0 flex-1 sm:w-[220px] sm:flex-none">
            <SelectValue placeholder="User" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            <SelectItem value={UNATTRIBUTED}>Unattributed (autonomous)</SelectItem>
            {users?.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  let body: ReactNode;
  if (isLoading) {
    body = <UsageSkeleton />;
  } else if (!summary) {
    body = (
      <AlertCallout tone="error" icon={AlertCircle}>
        Could not load usage. {error instanceof Error ? error.message : null}
      </AlertCallout>
    );
  } else if (summary.totals.totalSessions === 0) {
    body = (
      <EmptyState
        icon={BarChart3}
        title="No usage in this window"
        description="No sessions ran in this range. Pick a longer range or clear the filters."
      />
    );
  } else {
    // A container: the page sits beside two sidebars, so the viewport width
    // says little about the room the cards get.
    body = (
      <div
        className={cn(
          "@container space-y-4 transition-opacity duration-150 ease-snappy",
          isPlaceholderData && "opacity-60",
        )}
      >
        <UsageKpis totals={summary.totals} />

        {summary.byCredential && summary.byCredential.length > 0 ? (
          <SubscriptionsCard
            rows={summary.byCredential}
            windowStartMs={Date.parse(`${windowFrom}T00:00:00Z`)}
            filtered={Boolean(agentId || userId)}
          />
        ) : null}

        <DailySpendChart daily={summary.daily} from={windowFrom} to={windowTo} />

        {agentRows.length > 0 || userRows.length > 0 ? (
          <div className="grid gap-4 @4xl:grid-cols-2">
            {agentRows.length > 0 ? (
              <RankedSpendCard
                title="By agent"
                nameLabel="Agent"
                rows={agentRows}
                countLabel="Sessions"
              />
            ) : null}
            {userRows.length > 0 ? (
              <RankedSpendCard
                title="By user"
                nameLabel="User"
                rows={userRows}
                countLabel="Tasks"
              />
            ) : null}
          </div>
        ) : null}

        {showAttributionByPerson && attributionData.length > 0 ? (
          <Card className="min-w-0 gap-4 py-5">
            <CardHeader className="px-5">
              <CardTitle>By person</CardTitle>
              <CardDescription>
                Shown side by side on purpose. Do not rank people by one column. Problems initiated
                is the easiest number to game.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <DataGrid
                rowData={attributionData}
                columnDefs={attributionColumns}
                domLayout="autoHeight"
                columnSizing="flex"
                pagination={false}
              />
            </CardContent>
          </Card>
        ) : null}
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

/** First-load placeholder in the shape of the page. */
function UsageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-[290px] rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
