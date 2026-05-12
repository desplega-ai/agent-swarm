import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import type { AgentStatus, AgentWithTasks } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { DataGrid } from "@/components/shared/data-grid";
import { HarnessCell } from "@/components/shared/harness-cell";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { findKnownModel } from "@/lib/agent-runtime-models";
import { formatSmartTime } from "@/lib/utils";

export default function AgentsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: agents, isLoading } = useAgents();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "all");

  const modelColumnGate = useFeatureGate("1.77.2");

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const filtered =
      statusFilter === "all" ? [...agents] : agents.filter((a) => a.status === statusFilter);
    return filtered.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  }, [agents, statusFilter]);

  const columnDefs = useMemo<ColDef<AgentWithTasks>[]>(() => {
    const modelColumn: ColDef<AgentWithTasks> = {
      headerName: "Model",
      width: 200,
      valueGetter: (params) => params.data?.credStatus?.latestModel?.model ?? "",
      cellRenderer: (params: { value: string; data: AgentWithTasks | undefined }) => {
        const id = params.value;
        if (!id) return <span className="text-muted-foreground">—</span>;
        const known = findKnownModel(id);
        return (
          <span className="flex items-center gap-1.5">
            <ProviderIcon provider={known?.providerId} className="h-3.5 w-3.5" />
            <span className="truncate">{known?.label ?? id}</span>
          </span>
        );
      },
    };
    return [
      {
        field: "name",
        headerName: "Name",
        width: 250,
        minWidth: 180,
        cellRenderer: (params: { value: string; data: AgentWithTasks | undefined }) => (
          <span className="flex items-center gap-2 font-semibold">
            <AgentAvatar
              agentId={params.data?.id}
              agentName={params.data?.name ?? params.value}
              size="sm"
              className="shrink-0"
            />
            {params.value}
          </span>
        ),
      },
      { field: "role", headerName: "Role", width: 150 },
      {
        field: "harnessProvider",
        headerName: "Harness",
        width: 200,
        cellRenderer: (params: { data: AgentWithTasks | undefined }) => (
          <HarnessCell
            harnessProvider={params.data?.harnessProvider}
            credStatus={params.data?.credStatus}
          />
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 120,
        cellRenderer: (params: { value: AgentStatus }) => <StatusBadge status={params.value} />,
      },
      {
        headerName: "Capacity",
        width: 110,
        valueGetter: (params) => {
          const agent = params.data;
          if (!agent) return "";
          const max = agent.capacity?.max ?? agent.maxTasks ?? null;
          const current = agent.capacity?.current ?? null;
          if (max == null && current == null) return "–";
          return `${current ?? "–"}/${max ?? "∞"}`;
        },
        cellRenderer: (params: { data: AgentWithTasks | undefined }) => {
          const agent = params.data;
          if (!agent) return null;
          const max = agent.capacity?.max ?? agent.maxTasks ?? null;
          const current = agent.capacity?.current ?? null;
          const atCapacity = agent.capacity?.available === 0;
          if (max == null && current == null) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <span className="inline-flex items-baseline gap-1 tabular-nums">
              <span className={atCapacity ? "text-status-error" : "text-muted-foreground"}>
                {current ?? "–"}
              </span>
              <span className="text-muted-foreground/60">/</span>
              <span className="font-medium text-foreground">{max ?? "∞"}</span>
            </span>
          );
        },
      },
      ...(modelColumnGate.supported ? [modelColumn] : []),
      {
        field: "lastUpdatedAt",
        headerName: "Last Updated",
        flex: 1,
        minWidth: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ];
  }, [modelColumnGate.supported]);

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AgentWithTasks>) => {
      if (event.data) navigate(`/agents/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Agents" />

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
            <SelectItem value="waiting_for_credentials">Waiting for credentials</SelectItem>
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
