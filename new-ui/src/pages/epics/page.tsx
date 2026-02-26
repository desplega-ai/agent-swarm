import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { useEpics } from "@/api/hooks/use-epics";
import { formatSmartTime } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";
import type { EpicWithProgress, EpicStatus } from "@/api/types";

export default function EpicsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filters = useMemo(() => {
    const f: { status?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    return f;
  }, [statusFilter]);

  const { data: epicsData, isLoading } = useEpics(
    Object.keys(filters).length > 0 ? filters : undefined,
  );

  const columnDefs = useMemo<ColDef<EpicWithProgress>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        width: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        cellRenderer: (params: { value: EpicStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "goal",
        headerName: "Goal",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate text-muted-foreground">{params.value}</span>
        ),
      },
      {
        field: "progress",
        headerName: "Progress",
        width: 150,
        cellRenderer: (params: { value: number; data: EpicWithProgress | undefined }) => {
          const pct = params.value ?? 0;
          return (
            <div className="flex items-center gap-2 w-full h-full">
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-muted-foreground w-10 text-right">
                {Math.round(pct)}%
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Tasks",
        width: 80,
        valueGetter: (params) => params.data?.taskStats?.total ?? 0,
      },
      { field: "priority", headerName: "Priority", width: 80 },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<EpicWithProgress>) => {
      if (event.data) navigate(`/epics/${event.data.id}`);
    },
    [navigate],
  );

  // Cast epics to EpicWithProgress — the API returns them with taskStats/progress
  const epics = (epicsData?.epics ?? []) as unknown as EpicWithProgress[];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Epics</h1>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search epics..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={epics}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No epics found"
      />
    </div>
  );
}
