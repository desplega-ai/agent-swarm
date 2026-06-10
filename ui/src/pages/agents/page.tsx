import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import type { AgentStatus, AgentWithTasks } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AgentModelCell } from "@/components/shared/agent-model-cell";
import { DataGrid } from "@/components/shared/data-grid";
import { HarnessCell } from "@/components/shared/harness-cell";
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
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { getAgentModelDisplay, getAgentModelPresentation } from "@/lib/agents-list-model-display";
import { formatSmartTime } from "@/lib/utils";

export default function AgentsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const { data: agents, isLoading } = useAgents();
  const { data: agentConfigs } = useConfigs({ scope: "agent" });
  const search = readStringParam(searchParams, "search");
  const statusFilter = readStringParam(searchParams, "status", "all");

  const modelColumnGate = useFeatureGate("1.77.2");

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const filtered =
      statusFilter === "all" ? [...agents] : agents.filter((a) => a.status === statusFilter);
    return filtered.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  }, [agents, statusFilter]);

  const configuredModelByAgentId = useMemo(() => {
    const visibleIds = new Set(filteredAgents.map((agent) => agent.id));
    const modelByAgentId = new Map<string, string>();
    for (const config of agentConfigs ?? []) {
      if (
        config.scope === "agent" &&
        config.scopeId &&
        visibleIds.has(config.scopeId) &&
        config.key === "MODEL_OVERRIDE" &&
        config.value.trim()
      ) {
        modelByAgentId.set(config.scopeId, config.value.trim());
      }
    }
    return modelByAgentId;
  }, [agentConfigs, filteredAgents]);

  const columnDefs = useMemo<ColDef<AgentWithTasks>[]>(() => {
    const modelColumn: ColDef<AgentWithTasks> = {
      headerName: "Model",
      width: 320,
      minWidth: 260,
      valueGetter: (params) => {
        const agent = params.data;
        if (!agent) return "";
        const display = getAgentModelDisplay(
          configuredModelByAgentId.get(agent.id),
          agent.credStatus?.latestModel?.model,
        );
        const primary = getAgentModelPresentation(display.primary);
        return [
          primary?.label,
          primary?.raw,
          primary?.provider,
          display.configured,
          display.lastUsed,
        ]
          .filter(Boolean)
          .join(" ");
      },
      cellRenderer: (params: { data: AgentWithTasks | undefined }) => {
        const agent = params.data;
        if (!agent) return null;
        const display = getAgentModelDisplay(
          configuredModelByAgentId.get(agent.id),
          agent.credStatus?.latestModel?.model,
        );
        return <AgentModelCell display={display} />;
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
  }, [configuredModelByAgentId, modelColumnGate.supported]);

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
            onChange={(e) => setParam("search", e.target.value, { reset: ["agentsPage"] })}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setParam("status", value, { defaultValue: "all", reset: ["agentsPage"] })
          }
        >
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
        paginationQueryKey="agents"
      />
    </div>
  );
}
