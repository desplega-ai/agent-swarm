import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { ScriptRunKind, ScriptRunListItem, ScriptRunStatus } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import { ScriptRunKindBadge } from "@/components/shared/script-run-kind-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

const STATUS_OPTIONS: Array<ScriptRunStatus | "all"> = [
  "all",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "aborted_limit",
];

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "—";
  return formatElapsed(startedAt, finishedAt);
}

interface ScriptRunsGridProps {
  rows: ScriptRunListItem[];
  loading: boolean;
  /** Hide the script-name column (per-script Runs tab already scopes by name). */
  hideNameColumn?: boolean;
  /** URL search-param key backing the status filter (default `status`). */
  statusParamKey?: string;
  /** Forwarded to DataGrid — keeps the grid page index in the URL. */
  paginationQueryKey?: string;
  /** Skip the built-in status-filter row — the page renders
   * <ScriptRunsStatusFilter> in its own toolbar instead. */
  hideToolbar?: boolean;
}

/**
 * Standalone status filter for script runs. Reads/writes the same URL param
 * the grid filters by, so a page can mount it in a shared toolbar away from
 * the grid (e.g. the /scripts tabs row) with zero prop plumbing.
 */
export function ScriptRunsStatusFilter({
  statusParamKey = "status",
  paginationQueryKey,
}: {
  statusParamKey?: string;
  paginationQueryKey?: string;
}) {
  const { searchParams, setParam } = useUrlSearchState();
  const statusParam = readStringParam(searchParams, statusParamKey, "all");
  const statusFilter = STATUS_OPTIONS.includes(statusParam as ScriptRunStatus | "all")
    ? (statusParam as ScriptRunStatus | "all")
    : "all";

  const setStatusFilter = useCallback(
    (value: string) =>
      setParam(statusParamKey, value, {
        defaultValue: "all",
        reset: paginationQueryKey ? [`${paginationQueryKey}Page`] : [],
      }),
    [paginationQueryKey, setParam, statusParamKey],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="w-[170px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((status) => (
            <SelectItem key={status} value={status}>
              {status === "all" ? "All statuses" : status.replace("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {statusFilter !== "all" && (
        <Button variant="ghost" size="sm" onClick={() => setStatusFilter("all")}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * Reusable script-runs list: status filter toolbar + DataGrid.
 * Used by the global Runs tab on /scripts and the per-script Runs tab
 * on /scripts/:id. Row click navigates to /script-runs/:id.
 */
export function ScriptRunsGrid({
  rows,
  loading,
  hideNameColumn = false,
  statusParamKey = "status",
  paginationQueryKey,
  hideToolbar = false,
}: ScriptRunsGridProps) {
  const navigate = useNavigate();
  const { searchParams } = useUrlSearchState();
  const statusParam = readStringParam(searchParams, statusParamKey, "all");
  const statusFilter = STATUS_OPTIONS.includes(statusParam as ScriptRunStatus | "all")
    ? (statusParam as ScriptRunStatus | "all")
    : "all";

  const filteredRows = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter],
  );

  const columns = useMemo<ColDef<ScriptRunListItem>[]>(() => {
    const nameColumn: ColDef<ScriptRunListItem> = {
      field: "scriptName",
      headerName: "Name",
      minWidth: 200,
      flex: 1,
      cellRenderer: (params: { value?: string }) => (
        <span className="truncate font-medium">{params.value || "One-off script"}</span>
      ),
    };
    const baseColumns: ColDef<ScriptRunListItem>[] = [
      {
        field: "id",
        headerName: "Run ID",
        width: 170,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {params.value}
                </span>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">{params.value}</TooltipContent>
            </Tooltip>
          ) : null,
      },
      {
        field: "kind",
        headerName: "Type",
        width: 120,
        cellRenderer: (params: { value?: ScriptRunKind }) =>
          params.value ? <ScriptRunKindBadge kind={params.value} /> : null,
      },
      {
        field: "status",
        headerName: "Status",
        width: 150,
        cellRenderer: (params: { value?: ScriptRunStatus }) =>
          params.value ? <StatusBadge status={params.value} /> : null,
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 230,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <AgentLink agentId={params.value} onClick={(e) => e.stopPropagation()} />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        field: "startedAt",
        headerName: "Started",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        headerName: "Duration",
        width: 120,
        valueGetter: (params) =>
          params.data ? formatDuration(params.data.startedAt, params.data.finishedAt) : "—",
      },
      {
        field: "error",
        headerName: "Error",
        flex: 1,
        minWidth: 220,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate text-xs text-status-error-strong">
                  {params.value}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">{params.value}</TooltipContent>
            </Tooltip>
          ) : null,
      },
    ];
    return hideNameColumn ? baseColumns : [nameColumn, ...baseColumns];
  }, [hideNameColumn]);

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ScriptRunListItem>) => {
      // Don't hijack clicks on interactive cell content (e.g. the agent link) —
      // AG Grid's native row listener fires before React's stopPropagation, so
      // guard on the click target instead.
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest("a, button")) return;
      if (event.data) void navigate(`/script-runs/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <>
      {!hideToolbar && (
        <ScriptRunsStatusFilter
          statusParamKey={statusParamKey}
          paginationQueryKey={paginationQueryKey}
        />
      )}
      <DataGrid
        rowData={filteredRows}
        columnDefs={columns}
        onRowClicked={onRowClicked}
        loading={loading}
        emptyMessage="No script runs"
        paginationQueryKey={paginationQueryKey}
      />
    </>
  );
}
