import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { useTasks } from "@/api/hooks/use-tasks";
import { useAgents } from "@/api/hooks/use-agents";
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
import type { AgentTask, AgentTaskStatus } from "@/api/types";

export default function TasksPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const { data: agents } = useAgents();
  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  const filters = useMemo(() => {
    const f: { status?: string; agentId?: string } = {};
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    return f;
  }, [statusFilter, agentFilter]);

  const { data: tasksData, isLoading } = useTasks(
    Object.keys(filters).length > 0 ? filters : undefined,
  );

  const columnDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 300,
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
      { field: "taskType", headerName: "Type", width: 100 },
      {
        field: "agentId",
        headerName: "Agent",
        width: 150,
        valueFormatter: (params) =>
          params.value ? (agentMap.get(params.value) ?? params.value.slice(0, 8) + "...") : "Unassigned",
      },
      {
        field: "priority",
        headerName: "Priority",
        width: 80,
        cellRenderer: (params: { value: number }) => {
          const p = params.value ?? 50;
          const color = p >= 80 ? "text-red-400" : p >= 60 ? "text-primary" : "text-muted-foreground";
          return <span className={`font-mono ${color}`}>{p}</span>;
        },
      },
      {
        field: "tags",
        headerName: "Tags",
        width: 200,
        cellRenderer: (params: { value: string[] }) => (
          <div className="flex flex-wrap gap-1">
            {params.value?.slice(0, 3).map((tag) => (
              <span key={tag} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                {tag}
              </span>
            ))}
            {(params.value?.length ?? 0) > 3 && (
              <span className="text-[10px] text-muted-foreground">
                +{(params.value?.length ?? 0) - 3}
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
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
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
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={tasksData?.tasks ?? []}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No tasks found"
      />
    </div>
  );
}
