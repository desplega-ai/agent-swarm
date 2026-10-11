import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useSkillUsageDetail } from "@/api/hooks";
import type { SkillUsageRecentRow, SkillUsageWindow } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { harnessLabel } from "@/components/shared/harness-cell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatPanel } from "@/components/ui/stat-panel";
import { formatRelativeTime } from "@/lib/utils";
import {
  DailyUsageChart,
  formatCount,
  formatLocalDateTime,
  RankedCountCard,
  UsageWindowControl,
} from "./usage-shared";

const VIA_LABEL: Record<string, string> = {
  tool: "Skill tool",
  prompt: "Slash command",
  read: "SKILL.md read",
};

/** Usage of one skill: KPIs, daily loads, breakdowns, and recent loads. */
export function SkillUsagePanel({
  skillId,
  window,
  onWindowChange,
}: {
  skillId: string;
  window: SkillUsageWindow;
  onWindowChange: (value: SkillUsageWindow) => void;
}) {
  const navigate = useNavigate();
  const { data: usage, isLoading } = useSkillUsageDetail(skillId, window);

  const recentColumns = useMemo<ColDef<SkillUsageRecentRow>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "When",
        width: 150,
        sort: "desc",
        cellRenderer: (params: ICellRendererParams<SkillUsageRecentRow>) =>
          params.value ? (
            <span title={formatRelativeTime(params.value)}>
              {formatLocalDateTime(params.value)}
            </span>
          ) : null,
      },
      {
        field: "taskTitle",
        headerName: "Task",
        flex: 2,
        minWidth: 220,
        cellRenderer: (params: ICellRendererParams<SkillUsageRecentRow>) =>
          params.data?.taskId ? (
            <Link
              to={`/tasks/${params.data.taskId}`}
              onClick={(e) => e.stopPropagation()}
              className="truncate hover:underline"
              title={params.value ?? params.data.taskId}
            >
              {params.value || params.data.taskId}
            </Link>
          ) : (
            <span className="text-muted-foreground">No task</span>
          ),
      },
      {
        field: "agentName",
        headerName: "Agent",
        flex: 1,
        minWidth: 130,
        valueFormatter: (params) =>
          params.value ?? (params.data?.agentId ? params.data.agentId.slice(0, 8) : "-"),
      },
      {
        field: "harness",
        headerName: "Harness",
        width: 110,
        valueFormatter: (params) => (params.value ? harnessLabel(params.value) : "-"),
      },
      {
        field: "via",
        headerName: "Via",
        width: 130,
        cellRenderer: (params: ICellRendererParams<SkillUsageRecentRow>) =>
          params.value ? (
            <Badge variant="outline" size="tag">
              {VIA_LABEL[params.value] ?? params.value}
            </Badge>
          ) : null,
      },
      {
        field: "skillVersion",
        headerName: "Ver",
        width: 70,
        valueFormatter: (params) => (params.value == null ? "-" : `v${params.value}`),
      },
      {
        field: "tokenCount",
        headerName: "Tokens",
        headerTooltip: "Estimated size of the loaded skill (characters / 4)",
        width: 100,
        type: "numericColumn",
        valueFormatter: (params) => (params.value == null ? "-" : formatCount(params.value)),
      },
    ],
    [],
  );

  const onRecentClicked = useCallback(
    (event: RowClickedEvent<SkillUsageRecentRow>) => {
      if (event.data?.taskId) void navigate(`/tasks/${event.data.taskId}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Loads of this skill, at most one per runner session. Days follow your timezone.
        </p>
        <UsageWindowControl value={window} onChange={onWindowChange} />
      </div>

      {isLoading && !usage ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-56 w-full" />
        </>
      ) : !usage ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Usage unavailable.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatPanel label="Loads" value={formatCount(usage.totals.invocations)} />
            <StatPanel label="Agents" value={formatCount(usage.totals.distinctAgents)} />
            <StatPanel label="Tasks" value={formatCount(usage.totals.distinctTasks)} />
            <StatPanel
              label="Tokens loaded"
              value={formatCount(usage.totals.tokens)}
              info="Sum of the estimated skill size (characters / 4) at each load."
            />
          </div>

          <DailyUsageChart title="Loads per day" daily={usage.daily} since={usage.since} />

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            <RankedCountCard
              title="By agent"
              nameLabel="Agent"
              countLabel="Loads"
              rows={usage.byAgent.map((row) => ({
                key: row.agentId,
                name: row.agentName ?? row.agentId.slice(0, 8),
                href: `/agents/${row.agentId}`,
                count: row.invocations,
                hint: `Last used ${formatLocalDateTime(row.lastInvokedAt)}`,
              }))}
              emptyMessage="No loads in this window."
            />
            <RankedCountCard
              title="By harness"
              nameLabel="Harness"
              countLabel="Loads"
              rows={usage.byHarness.map((row) => ({
                key: row.key,
                name: harnessLabel(row.key),
                count: row.invocations,
                muted: row.key === "unknown",
              }))}
              emptyMessage="No loads in this window."
            />
            <RankedCountCard
              title="How it loaded"
              nameLabel="Path"
              countLabel="Loads"
              rows={usage.byVia.map((row) => ({
                key: row.key,
                name: VIA_LABEL[row.key] ?? row.key,
                count: row.invocations,
                muted: row.key === "unknown",
              }))}
              emptyMessage="No loads in this window."
            />
          </div>

          <Card className="gap-3 py-5">
            <CardHeader className="px-5">
              <CardTitle>Recent loads</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <DataGrid
                rowData={usage.recent}
                columnDefs={recentColumns}
                onRowClicked={onRecentClicked}
                getRowId={(params) => params.data.id}
                domLayout="autoHeight"
                columnSizing="flex"
                pagination={false}
                emptyMessage="No loads in this window"
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
