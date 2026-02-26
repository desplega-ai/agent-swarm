import { useState, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAgents } from "@/api/hooks/use-agents";
import { formatSmartTime } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Crown } from "lucide-react";
import type { AgentWithTasks, AgentStatus } from "@/api/types";

export default function AgentsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: agents, isLoading } = useAgents();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "all");

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const filtered = statusFilter === "all" ? [...agents] : agents.filter((a) => a.status === statusFilter);
    return filtered.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  }, [agents, statusFilter]);

  const columnDefs = useMemo<ColDef<AgentWithTasks>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        width: 200,
        cellRenderer: (params: { value: string; data: AgentWithTasks | undefined }) => (
          <span className="flex items-center gap-1.5 font-semibold">
            {params.value}
            {params.data?.isLead && (
              <Crown className="h-3.5 w-3.5 text-primary shrink-0" />
            )}
          </span>
        ),
      },
      { field: "role", headerName: "Role", width: 150 },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        cellRenderer: (params: { value: AgentStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "capabilities",
        headerName: "Capabilities",
        width: 250,
        cellRenderer: (params: { value: string[] | undefined }) => (
          <div className="flex flex-wrap gap-1">
            {params.value?.slice(0, 3).map((cap) => (
              <Badge key={cap} variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
                {cap}
              </Badge>
            ))}
            {(params.value?.length ?? 0) > 3 && (
              <span className="text-[9px] text-muted-foreground font-medium">
                +{(params.value?.length ?? 0) - 3}
              </span>
            )}
          </div>
        ),
        sortable: false,
      },
      {
        headerName: "Tasks",
        width: 100,
        valueGetter: (params) => params.data?.tasks?.length ?? 0,
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
