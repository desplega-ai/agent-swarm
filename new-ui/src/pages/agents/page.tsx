import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Crown, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import type { AgentStatus, AgentWithTasks } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatSmartTime } from "@/lib/utils";

export default function AgentsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: agents, isLoading } = useAgents();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "all");

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const filtered =
      statusFilter === "all" ? [...agents] : agents.filter((a) => a.status === statusFilter);
    return filtered.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  }, [agents, statusFilter]);

  const columnDefs = useMemo<ColDef<AgentWithTasks>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        width: 250,
        minWidth: 180,
        cellRenderer: (params: { value: string; data: AgentWithTasks | undefined }) => (
          <span className="flex items-center gap-1.5 font-semibold">
            {params.value}
            {params.data?.isLead && <Crown className="h-3.5 w-3.5 text-primary shrink-0" />}
          </span>
        ),
      },
      { field: "role", headerName: "Role", width: 150 },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        cellRenderer: (params: { value: AgentStatus }) => <StatusBadge status={params.value} />,
      },
      {
        headerName: "Capacity",
        width: 90,
        valueGetter: (params) => {
          const agent = params.data;
          if (!agent) return "";
          if (agent.capacity) return `${agent.capacity.current}/${agent.capacity.max}`;
          if (agent.maxTasks != null) return `–/${agent.maxTasks}`;
          return "–";
        },
        cellRenderer: (params: { value: string; data: AgentWithTasks | undefined }) => {
          const agent = params.data;
          const atCapacity = agent?.capacity && agent.capacity.available === 0;
          return <span className={atCapacity ? "text-red-400" : ""}>{params.value}</span>;
        },
      },
      {
        field: "capabilities",
        headerName: "Capabilities",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string[] | undefined }) => (
          <div className="flex gap-1 items-center justify-center">
            {params.value?.slice(0, 2).map((cap) => (
              <Badge key={cap} variant="outline" size="tag" className="shrink-0">
                {cap}
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
        field: "lastUpdatedAt",
        headerName: "Last Updated",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AgentWithTasks>) => {
      if (event.data) navigate(`/agents/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Agents</h1>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
            <SelectItem value="busy">Busy</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={filteredAgents}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No agents found"
      />
    </div>
  );
}
