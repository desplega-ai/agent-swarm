import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import type {
  SkillUsageAgentRow,
  SkillUsageSummary,
  SkillUsageUnusedRow,
  SkillUsageWindow,
} from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { harnessLabel } from "@/components/shared/harness-cell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { formatRelativeTime } from "@/lib/utils";
import {
  compareIsoNullsLast,
  DailyUsageChart,
  formatCount,
  formatLocalDateTime,
  formatPercent,
  RankedCountCard,
} from "./usage-shared";

const WINDOW_LABEL: Record<SkillUsageWindow, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  all: "since tracking began",
};

function LastUsedCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">Never</span>;
  return <span title={formatLocalDateTime(value)}>{formatRelativeTime(value)}</span>;
}

function AdoptionBar({ used, installed }: { used: number; installed: number }) {
  const pct = installed > 0 ? Math.min(100, (used / installed) * 100) : 0;
  return (
    <span className="flex w-full items-center gap-2">
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-9 text-right font-mono text-xs tabular-nums">
        {formatPercent(used, installed)}
      </span>
    </span>
  );
}

export function AdoptionView({
  summary,
  isLoading,
  window,
}: {
  summary: SkillUsageSummary | undefined;
  isLoading: boolean;
  window: SkillUsageWindow;
}) {
  const navigate = useNavigate();

  const agentColumns = useMemo<ColDef<SkillUsageAgentRow>[]>(
    () => [
      {
        field: "agentName",
        headerName: "Agent",
        flex: 1,
        minWidth: 160,
        cellRenderer: (params: ICellRendererParams<SkillUsageAgentRow>) => (
          <span className="inline-flex items-center gap-1.5 font-medium">
            {params.value}
            {params.data?.isLead ? (
              <Badge variant="outline" size="tag">
                Lead
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        colId: "adoption",
        headerName: "Installed used",
        headerTooltip: "Installed skills this agent loaded in the window, out of all it has",
        flex: 1,
        minWidth: 170,
        valueGetter: (params) =>
          params.data && params.data.installed > 0
            ? params.data.installedUsed / params.data.installed
            : 0,
        cellRenderer: (params: ICellRendererParams<SkillUsageAgentRow>) =>
          params.data ? (
            <span className="flex h-full items-center gap-3">
              <span className="w-16 shrink-0 font-mono text-xs tabular-nums">
                {params.data.installedUsed} / {params.data.installed}
              </span>
              <AdoptionBar used={params.data.installedUsed} installed={params.data.installed} />
            </span>
          ) : null,
      },
      {
        field: "skillsUsed",
        headerName: "Skills used",
        headerTooltip: "Distinct skills loaded, including ones not installed (harness-native)",
        width: 120,
        type: "numericColumn",
      },
      {
        field: "invocations",
        headerName: "Loads",
        width: 100,
        type: "numericColumn",
        sort: "desc",
        valueFormatter: (params) => formatCount(params.value ?? 0),
      },
      {
        field: "lastInvokedAt",
        headerName: "Last used",
        width: 140,
        comparator: compareIsoNullsLast,
        cellRenderer: (params: ICellRendererParams<SkillUsageAgentRow>) => (
          <LastUsedCell value={params.value} />
        ),
      },
    ],
    [],
  );

  const unusedColumns = useMemo<ColDef<SkillUsageUnusedRow>[]>(
    () => [
      { field: "name", headerName: "Skill", flex: 1, minWidth: 180, cellClass: "font-medium" },
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (params: ICellRendererParams<SkillUsageUnusedRow>) => (
          <Badge variant="outline" size="tag">
            {params.value}
          </Badge>
        ),
      },
      {
        colId: "installedOn",
        headerName: "Installed on",
        width: 140,
        valueGetter: (params) =>
          params.data?.installedEverywhere
            ? Number.POSITIVE_INFINITY
            : params.data?.installedAgents,
        valueFormatter: (params) =>
          params.data?.installedEverywhere
            ? "All agents"
            : `${params.data?.installedAgents ?? 0} agent${params.data?.installedAgents === 1 ? "" : "s"}`,
      },
      {
        field: "invocationCount",
        headerName: "Loads ever",
        width: 110,
        type: "numericColumn",
      },
      {
        field: "lastInvokedAt",
        headerName: "Last used",
        width: 140,
        comparator: compareIsoNullsLast,
        cellRenderer: (params: ICellRendererParams<SkillUsageUnusedRow>) => (
          <LastUsedCell value={params.value} />
        ),
      },
    ],
    [],
  );

  const onAgentClicked = useCallback(
    (event: RowClickedEvent<SkillUsageAgentRow>) => {
      if (event.data) void navigate(`/agents/${event.data.agentId}`);
    },
    [navigate],
  );
  const onUnusedClicked = useCallback(
    (event: RowClickedEvent<SkillUsageUnusedRow>) => {
      if (event.data) void navigate(`/skills/${event.data.id}`);
    },
    [navigate],
  );

  if (isLoading && !summary) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!summary) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Usage unavailable.</p>;
  }

  const { totals, taskAdoption } = summary;
  const activeAgents = summary.agents.filter((agent) => agent.invocations > 0).length;
  const windowLabel = WINDOW_LABEL[window];

  const topSkills = summary.bySkill.map((row) => ({
    key: row.skillId ?? `name:${row.skillName}`,
    name: row.skillName,
    href: row.skillId ? `/skills/${row.skillId}` : undefined,
    count: row.invocations,
    muted: !row.skillId,
    hint: row.skillId
      ? `${row.skillName}: ${formatCount(row.agents)} agent${row.agents === 1 ? "" : "s"}`
      : `${row.skillName}: not a swarm-managed skill`,
  }));
  const harnesses = summary.byHarness.map((row) => ({
    key: row.key,
    name: harnessLabel(row.key),
    count: row.invocations,
    muted: row.key === "unknown",
  }));

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatPanel
          label="Skill loads"
          value={formatCount(totals.invocations)}
          detail={windowLabel}
          info="Each skill counts at most once per runner session."
        />
        <StatPanel
          label="Skills used"
          value={formatCount(totals.distinctSkills)}
          detail={`${formatCount(summary.unused.length)} installed and unused`}
          info="Distinct skill names loaded, including harness-native skills the swarm does not manage."
        />
        <StatPanel
          label="Tasks with a skill"
          value={formatPercent(taskAdoption.tasksWithSkill, taskAdoption.tasks)}
          detail={`${formatCount(taskAdoption.tasksWithSkill)} of ${formatCount(taskAdoption.tasks)} started tasks`}
          info={
            taskAdoption.since
              ? `Started tasks created since ${formatLocalDateTime(taskAdoption.since)} that loaded at least one skill. Earlier tasks predate tracking.`
              : "No skill loads recorded yet."
          }
        />
        <StatPanel
          label="Agents using skills"
          value={formatCount(activeAgents)}
          detail={`of ${formatCount(summary.agents.length)} listed agents`}
          info="Agents that loaded at least one skill in the window. Offline agents with no loads are left out."
        />
      </div>

      {summary.trackingSince === null ? (
        <p className="text-sm text-muted-foreground">
          No skill loads recorded yet. Workers report a load each time a session reads a skill.
        </p>
      ) : null}

      <DailyUsageChart
        title="Skill loads per day"
        daily={summary.daily}
        since={summary.since ?? summary.trackingSince}
        showSkills
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedCountCard
          title="Top skills"
          nameLabel="Skill"
          countLabel="Loads"
          rows={topSkills}
          emptyMessage="No skill loads in this window."
        />
        <RankedCountCard
          title="By harness"
          nameLabel="Harness"
          countLabel="Loads"
          rows={harnesses}
          emptyMessage="No skill loads in this window."
        />
      </div>

      <Card className="gap-3 py-5">
        <CardHeader className="px-5">
          <CardTitle>Adoption by agent</CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          <DataGrid
            rowData={summary.agents}
            columnDefs={agentColumns}
            onRowClicked={onAgentClicked}
            getRowId={(params) => params.data.agentId}
            domLayout="autoHeight"
            columnSizing="flex"
            pagination={false}
            emptyMessage="No agents"
          />
        </CardContent>
      </Card>

      <Card className="gap-3 py-5">
        <CardHeader className="px-5">
          <CardTitle>Installed, not used ({formatCount(summary.unused.length)})</CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          <DataGrid
            rowData={summary.unused}
            columnDefs={unusedColumns}
            onRowClicked={onUnusedClicked}
            getRowId={(params) => params.data.id}
            domLayout="autoHeight"
            columnSizing="flex"
            paginationQueryKey="unusedSkills"
            emptyMessage="Every installed skill was used in this window"
          />
        </CardContent>
      </Card>
    </div>
  );
}
