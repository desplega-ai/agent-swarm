import { useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { DataGrid } from "@/components/shared/data-grid";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import { useAgents } from "@/api/hooks/use-agents";
import { formatSmartTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Clock } from "lucide-react";
import type { ScheduledTask } from "@/api/types";

function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

export default function SchedulesPage() {
  const navigate = useNavigate();
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  const columnDefs = useMemo<ColDef<ScheduledTask>[]>(
    () => [
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
        headerName: "Schedule",
        width: 200,
        minWidth: 160,
        valueGetter: (params) => {
          if (params.data?.cronExpression) return params.data.cronExpression;
          if (params.data?.intervalMs) return `every ${formatInterval(params.data.intervalMs)}`;
          return "—";
        },
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono text-xs text-muted-foreground">{params.value}</span>
        ),
      },
      {
        field: "targetAgentId",
        headerName: "Target Agent",
        width: 180,
        minWidth: 150,
        valueFormatter: (params) =>
          params.value ? (agentMap.get(params.value) ?? params.value.slice(0, 8) + "...") : "Pool",
      },
      {
        field: "nextRunAt",
        headerName: "Next Run",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : "—"),
      },
      {
        field: "lastRunAt",
        headerName: "Last Run",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : "Never"),
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 100,
        cellRenderer: (params: { value: boolean }) => (
          <Badge
            variant="outline"
            className={
              params.value
                ? "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
                : "text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
            }
          >
            {params.value ? "ON" : "OFF"}
          </Badge>
        ),
      },
    ],
    [agentMap],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ScheduledTask>) => {
      if (event.data) navigate(`/schedules/${event.data.id}`);
    },
    [navigate],
  );

  if (!isLoading && (!schedules || schedules.length === 0)) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <h1 className="text-xl font-semibold">Schedules</h1>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Clock className="h-8 w-8 mb-2" />
          <p className="text-sm">No scheduled tasks</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Schedules</h1>

      <DataGrid
        rowData={schedules ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No scheduled tasks"
      />
    </div>
  );
}
