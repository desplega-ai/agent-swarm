import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ChevronLeft, ChevronRight, FileClock, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import type { ScriptRunKind, ScriptRunListItem, ScriptRunStatus } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import { ScriptRunKindBadge } from "@/components/shared/script-run-kind-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "—";
  return formatElapsed(startedAt, finishedAt);
}

export default function ScriptRunsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ScriptRunStatus | "all">("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const { data, isLoading } = useScriptRuns({
    status: statusFilter,
    limit: pageSize,
    offset: page * pageSize,
  });

  const columns = useMemo<ColDef<ScriptRunListItem>[]>(
    () => [
      {
        field: "scriptName",
        headerName: "Name",
        minWidth: 200,
        flex: 1,
        cellRenderer: (params: { value?: string }) => (
          <span className="truncate font-medium">{params.value || "One-off script"}</span>
        ),
      },
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
                <span className="block truncate text-xs text-status-error">{params.value}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">{params.value}</TooltipContent>
            </Tooltip>
          ) : null,
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ScriptRunListItem>) => {
      // Don't hijack clicks on interactive cell content (e.g. the agent link) —
      // AG Grid's native row listener fires before React's stopPropagation, so
      // guard on the click target instead.
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest("a, button")) return;
      if (event.data) navigate(`/script-runs/${event.data.id}`);
    },
    [navigate],
  );

  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstVisible = total > 0 ? page * pageSize + 1 : 0;
  const lastVisible = Math.min((page + 1) * pageSize, total);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader title="Script Runs" />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search runs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as ScriptRunStatus | "all");
            setPage(0);
          }}
        >
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter("all");
              setPage(0);
            }}
          >
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <FileClock className="h-4 w-4" />
          <span>{total.toLocaleString()} total</span>
        </div>
      </div>

      <DataGrid
        rowData={runs}
        columnDefs={columns}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No script runs"
        pagination={false}
      />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {total > 0
            ? `${firstVisible.toLocaleString()}-${lastVisible.toLocaleString()} of ${total.toLocaleString()}`
            : "0 script runs"}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs">Rows</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value));
                setPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-[72px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-xs">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((current) => current + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
