import { useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { useTasks } from "@/api/hooks/use-tasks";
import { useAgents } from "@/api/hooks/use-agents";
import { formatSmartTime, formatElapsed } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, ChevronLeft, ChevronRight, GitBranch, X } from "lucide-react";
import type { AgentTask, AgentTaskStatus } from "@/api/types";

const PAGE_SIZE = 100;

export default function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Read all filter state from URL params
  const statusFilter = searchParams.get("status") ?? "all";
  const agentFilter = searchParams.get("agent") ?? "all";
  const searchParam = searchParams.get("search") ?? "";
  const page = searchParams.has("page") ? Number(searchParams.get("page")) : 0;

  // Single setter that updates one key while preserving others
  const setParam = useCallback(
    (key: string, value: string, resetPage = true) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        // Set or delete the key
        const defaultValues: Record<string, string> = { status: "all", agent: "all", search: "", page: "0" };
        if (value === (defaultValues[key] ?? "")) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        // Reset page when changing filters
        if (resetPage && key !== "page") next.delete("page");
        return next;
      });
    },
    [setSearchParams],
  );

  const { data: agents } = useAgents();
  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  const filters = useMemo(() => {
    const f: { status?: string; agentId?: string; search?: string; limit: number; offset: number } = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    if (searchParam) f.search = searchParam;
    return f;
  }, [statusFilter, agentFilter, searchParam, page]);

  const { data: tasksData, isLoading } = useTasks(filters);

  const total = tasksData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilters = statusFilter !== "all" || agentFilter !== "all" || searchParam !== "" || page !== 0;

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const columnDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: AgentTaskStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "taskType",
        headerName: "Type",
        width: 110,
        cellRenderer: (params: { value: string | undefined }) =>
          params.value ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
              {params.value}
            </Badge>
          ) : null,
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 150,
        valueFormatter: (params) =>
          params.value ? (agentMap.get(params.value) ?? params.value.slice(0, 8) + "...") : "Unassigned",
      },
      {
        headerName: "Elapsed",
        width: 100,
        valueGetter: (params) => {
          const task = params.data;
          if (!task) return "";
          const start = task.acceptedAt ?? task.createdAt;
          const end = task.finishedAt;
          const isActive = !end && (task.status === "in_progress" || task.status === "pending" || task.status === "offered");
          return isActive ? formatElapsed(start) : end ? formatElapsed(start, end) : "—";
        },
      },
      {
        field: "dependsOn",
        headerName: "Deps",
        width: 90,
        cellRenderer: (params: { value: string[] | undefined; data: AgentTask | undefined }) => {
          const deps = params.value;
          if (!deps || deps.length === 0) return null;
          return (
            <div className="flex items-center gap-1 text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="text-[10px] font-mono">{deps.length}</span>
            </div>
          );
        },
        sortable: false,
      },
      {
        field: "tags",
        headerName: "Tags",
        width: 200,
        cellRenderer: (params: { value: string[] }) => (
          <div className="flex gap-1 items-center">
            {params.value?.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase shrink-0">
                {tag}
              </Badge>
            ))}
            {(params.value?.length ?? 0) > 2 && (
              <span className="text-[9px] text-muted-foreground font-medium shrink-0">
                +{(params.value?.length ?? 0) - 2}
              </span>
            )}
          </div>
        ),
        sortable: false,
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [agentMap],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AgentTask>) => {
      if (event.data) navigate(`/tasks/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Tasks</h1>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchParam}
            onChange={(e) => setParam("search", e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={agentFilter} onValueChange={(v) => setParam("agent", v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            {agents?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="ml-auto text-xs text-muted-foreground" onClick={clearFilters}>
            <X className="h-3 w-3 mr-1" />
            Clear filters
          </Button>
        )}
      </div>

      <DataGrid
        rowData={tasksData?.tasks ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No tasks found"
        pagination={false}
      />

      {/* Server-side pagination controls */}
      <div className="flex items-center justify-between shrink-0 text-sm text-muted-foreground">
        <span>
          {total > 0
            ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`
            : "0 tasks"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page === 0}
            onClick={() => setParam("page", String(page - 1), false)}
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
            onClick={() => setParam("page", String(page + 1), false)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
