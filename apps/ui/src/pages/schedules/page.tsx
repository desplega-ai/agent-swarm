import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { Clock, Plus, Search, Star } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFavoriteToggle } from "@/api/hooks/use-favorites";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import { useSchedulesSavings } from "@/api/hooks/use-savings";
import { useCreateSchedule, useScheduledTasks, useUpdateSchedule } from "@/api/hooks/use-schedules";
import type {
  SavingsScheduleRow,
  ScheduledTaskSummary,
  ScheduledTaskTargetType,
} from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { findAutomation, NeedsSetupBadge } from "@/components/automations/needs-setup-badge";
import {
  ScheduleDialog,
  type ScheduleFormData,
  scheduleCreateInput,
} from "@/components/schedules/schedule-dialog";
import { DataGridColumnsMenu } from "@/components/shared/columns-menu";
import { DataGrid, HIDE_WHEN_COMPACT, useDataGridColumns } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { FAVORITE_COLUMN } from "@/components/shared/favorite-column";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { ModelLabel } from "@/components/shared/model-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { isRowNavigationSuppressed } from "@/lib/grid-row-click";
import { matchesSearchTerms, searchText } from "@/lib/list-search";
import { modelTierLabel } from "@/lib/model-tiers";
import { cronTimezone, describeCron, formatInterval, scheduleCadence } from "@/lib/schedule-format";
import { formatSmartTime, formatUTCTime } from "@/lib/utils";
import { formatUsd } from "@/pages/usage/usage-format";

function targetLabel(targetType: ScheduledTaskTargetType | undefined): string {
  return targetType === "workflow" ? "Workflow" : targetType === "script" ? "Script" : "Agent Task";
}

export default function SchedulesPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: status } = useStatusContext();
  const { data: agents } = useAgents();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const favoriteToggle = useFavoriteToggle("schedule");
  const [dialogOpen, setDialogOpen] = useState(false);
  const search = readStringParam(searchParams, "search");
  const isMobile = useIsMobile();
  const scheduleRows = useMemo(() => {
    return [...(schedules ?? [])].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const aLastRun = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
      const bLastRun = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
      if (aLastRun !== bLastRun) return bLastRun - aLastRun;
      return new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime();
    });
  }, [schedules]);

  function handleCreateSubmit(data: ScheduleFormData) {
    createSchedule.mutate(scheduleCreateInput(data));
  }

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  // One search for both widths, so a phone finds the same schedules as the grid.
  const searchedRows = useMemo(() => {
    if (!search.trim()) return scheduleRows;
    return scheduleRows.filter((schedule) =>
      matchesSearchTerms(
        searchText([
          schedule.name,
          schedule.description,
          schedule.scheduleType === "one_time" ? "one-time" : "recurring",
          targetLabel(schedule.targetType),
          scheduleCadence(schedule),
          schedule.cronExpression,
          schedule.model,
          schedule.modelTier,
          schedule.targetAgentId ? agentMap.get(schedule.targetAgentId) : "pool",
        ]),
        search,
      ),
    );
  }, [agentMap, scheduleRows, search]);

  const handleToggleEnabled = useCallback(
    (schedule: ScheduledTaskSummary, enabled: boolean) => {
      updateSchedule.mutate({ id: schedule.id, data: { enabled } });
    },
    [updateSchedule],
  );

  const { data: savings } = useSchedulesSavings();
  // One request for the whole list, joined by schedule id.
  const savingsBySchedule = useMemo(() => {
    const m = new Map<string, SavingsScheduleRow>();
    if (savings?.valid) for (const row of savings.rows) m.set(row.scheduleId, row);
    return m;
  }, [savings]);

  const gridColumns = useDataGridColumns("schedules");
  const columnDefs = useMemo<ColDef<ScheduledTaskSummary>[]>(
    () => [
      {
        ...FAVORITE_COLUMN,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const schedule = params.data;
          if (!schedule) return null;
          return (
            <FavoriteButton
              favorite={schedule.favorite}
              disabled={
                favoriteToggle.isPending && favoriteToggle.variables?.itemId === schedule.id
              }
              onToggle={() =>
                favoriteToggle.mutate({ itemId: schedule.id, favorite: !schedule.favorite })
              }
            />
          );
        },
      },
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "scheduleType",
        headerName: "Type",
        context: HIDE_WHEN_COMPACT,
        width: 110,
        cellRenderer: (params: { value?: string }) => (
          <Badge
            variant="outline"
            size="tag"
            className={`${
              params.value === "one_time"
                ? "border-status-active/30 text-status-active-strong"
                : "border-status-success/30 text-status-success-strong"
            }`}
          >
            {params.value === "one_time" ? "One-time" : "Recurring"}
          </Badge>
        ),
      },
      {
        field: "targetType",
        headerName: "Target",
        context: HIDE_WHEN_COMPACT,
        width: 110,
        cellRenderer: (params: { value?: ScheduledTaskTargetType }) => (
          <Badge variant="outline" size="tag">
            {targetLabel(params.value)}
          </Badge>
        ),
      },
      {
        colId: "setup",
        headerName: "Setup",
        context: HIDE_WHEN_COMPACT,
        width: 190,
        minWidth: 190,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const schedule = params.data;
          if (!schedule) return null;
          return (
            <NeedsSetupBadge
              automation={findAutomation(
                status?.automations,
                "schedule",
                schedule.key,
                schedule.name,
              )}
            />
          );
        },
      },
      {
        colId: "schedule",
        headerName: "Schedule",
        context: HIDE_WHEN_COMPACT,
        width: 250,
        minWidth: 200,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const data = params.data;
          if (!data) return null;

          if (data.scheduleType === "one_time") {
            const label = data.nextRunAt
              ? `at ${formatUTCTime(data.nextRunAt)}`
              : data.lastRunAt
                ? `ran ${formatUTCTime(data.lastRunAt)}`
                : "—";
            return <span className="font-mono text-xs text-muted-foreground">{label}</span>;
          }

          if (data.cronExpression) {
            const tz = cronTimezone(data.timezone);
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground cursor-default">
                    <span>{describeCron(data.cronExpression)}</span>
                    <span className="ml-1.5 text-[10px] opacity-60">({tz})</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <code>{data.cronExpression}</code>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (data.intervalMs) {
            return (
              <span className="font-mono text-xs text-muted-foreground">
                every {formatInterval(data.intervalMs)}
              </span>
            );
          }

          return <span className="text-xs text-muted-foreground">—</span>;
        },
      },
      {
        colId: "model",
        headerName: "Model",
        context: HIDE_WHEN_COMPACT,
        width: 150,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const data = params.data;
          if (!data?.model && !data?.modelTier) return "—";
          return data.model ? (
            <span className="text-xs" title={data.model}>
              <ModelLabel model={data.model} />
            </span>
          ) : (
            <Badge variant="outline" size="tag">
              tier: {modelTierLabel(data.modelTier)}
            </Badge>
          );
        },
      },
      {
        field: "targetAgentId",
        headerName: "Target Agent",
        context: HIDE_WHEN_COMPACT,
        width: 180,
        minWidth: 150,
        valueFormatter: (params) =>
          params.value ? (agentMap.get(params.value) ?? `${params.value.slice(0, 8)}...`) : "Pool",
      },
      {
        field: "nextRunAt",
        headerName: "Next Run",
        width: 160,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          if (!params.value) return <span className="text-muted-foreground">—</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{formatSmartTime(params.value)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatUTCTime(params.value)}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        colId: "saved30d",
        headerName: "Saved (30d)",
        context: HIDE_WHEN_COMPACT,
        width: 130,
        // Sorts by the p50; schedules without a saving sort below every amount.
        valueGetter: (params) => {
          const row = params.data ? savingsBySchedule.get(params.data.id) : undefined;
          return row?.basis === "modelled" ? row.savingUsd.p50 : null;
        },
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const row = params.data ? savingsBySchedule.get(params.data.id) : undefined;
          if (!row) return <span className="text-muted-foreground">—</span>;
          if (row.basis === "measured") {
            return (
              <span
                className="font-mono tabular-nums text-muted-foreground"
                title={`Already agent work: ${formatUsd(row.actualUsd)} spent on ${row.runs.toLocaleString("en-US")} tasks, no saving to model`}
              >
                {formatUsd(row.actualUsd)}
              </span>
            );
          }
          const title = `${formatUsd(row.savingUsd.p10)} to ${formatUsd(row.savingUsd.p90)} (80% range), the saving of the target ${row.kind === "workflow" ? "workflow" : "script"}, shared with any other schedule of it`;
          return (
            <span className="font-mono tabular-nums" title={title}>
              {formatUsd(row.savingUsd.p50)}
            </span>
          );
        },
      },
      {
        field: "lastRunAt",
        headerName: "Last Run",
        context: HIDE_WHEN_COMPACT,
        width: 160,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          if (!params.value) return <span className="text-muted-foreground">Never</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{formatSmartTime(params.value)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatUTCTime(params.value)}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        field: "lastUpdatedAt",
        headerName: "Updated",
        context: HIDE_WHEN_COMPACT,
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 100,
        cellRenderer: (params: ICellRendererParams<ScheduledTaskSummary>) => {
          const schedule = params.data;
          if (!schedule) return null;
          return (
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Switch
                size="sm"
                checked={schedule.enabled}
                onCheckedChange={(checked) => handleToggleEnabled(schedule, checked)}
              />
            </div>
          );
        },
      },
    ],
    [agentMap, favoriteToggle, handleToggleEnabled, savingsBySchedule, status?.automations],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ScheduledTaskSummary>) => {
      // Skip navigation when clicking interactive elements (switch, button, etc.)
      if (isRowNavigationSuppressed(event.event?.target)) return;
      if (event.data) void navigate(`/schedules/${event.data.id}`);
    },
    [navigate],
  );

  const createButton = (
    <Button
      onClick={() => setDialogOpen(true)}
      size="sm"
      className="gap-1 bg-primary hover:bg-primary/90"
    >
      <Plus className="h-3.5 w-3.5" /> Create Schedule
    </Button>
  );

  if (!isLoading && scheduleRows.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <PageHeader title="Schedules" />
        <EmptyState
          icon={Clock}
          title="No scheduled tasks"
          description="Schedules run a task on a cron cadence — reports, syncs, sweeps."
          entity="scheduled task"
          fullPage
          action={createButton}
        />
        <ScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleCreateSubmit}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Schedules" />

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search schedules…"
            value={search}
            onChange={(e) => setParam("search", e.target.value, { reset: ["schedulesPage"] })}
            className="pl-9"
          />
        </div>
        {isMobile ? null : (
          <div className="ml-auto">
            <DataGridColumnsMenu state={gridColumns} />
          </div>
        )}
        {/* Labelled primary action in the toolbar row (DESIGN.md § List toolbar). */}
        <Button
          size="sm"
          className={isMobile ? "ml-auto" : undefined}
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-4 w-4" />
          New schedule
        </Button>
      </div>

      {isMobile ? (
        <MobileList label="Schedules" loading={isLoading} emptyMessage="No scheduled tasks">
          {searchedRows.map((schedule) => {
            const needsSetup =
              findAutomation(status?.automations, "schedule", schedule.key, schedule.name)
                ?.state === "needs_setup";
            return (
              <MobileListRow
                key={schedule.id}
                to={`/schedules/${schedule.id}`}
                title={
                  <>
                    {schedule.favorite ? (
                      <Star
                        className="mr-1 inline size-3 -translate-y-px fill-current text-muted-foreground"
                        role="img"
                        aria-label="Favorite"
                      />
                    ) : null}
                    {schedule.name}
                  </>
                }
                status={
                  !schedule.enabled ? (
                    <Badge variant="outline" size="tag">
                      Disabled
                    </Badge>
                  ) : needsSetup ? (
                    <Badge
                      variant="outline"
                      size="tag"
                      className="border-status-pending/30 text-status-pending-strong"
                    >
                      Needs setup
                    </Badge>
                  ) : null
                }
                meta={[
                  scheduleCadence(schedule),
                  schedule.targetType === "agent-task" || !schedule.targetType
                    ? schedule.targetAgentId
                      ? (agentMap.get(schedule.targetAgentId) ?? "Unknown agent")
                      : "Pool"
                    : targetLabel(schedule.targetType),
                  schedule.enabled && schedule.nextRunAt
                    ? `next ${formatSmartTime(schedule.nextRunAt)}`
                    : null,
                ]}
              />
            );
          })}
        </MobileList>
      ) : (
        <DataGrid
          rowData={searchedRows}
          columnDefs={columnDefs}
          columns={gridColumns}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No scheduled tasks"
          paginationQueryKey="schedules"
        />
      )}

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateSubmit}
      />
    </div>
  );
}
