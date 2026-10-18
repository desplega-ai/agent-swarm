import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Search } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import {
  type AgentStatus,
  type AgentWithTasks,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
} from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AgentModelCell } from "@/components/shared/agent-model-cell";
import { DataGrid, HIDE_WHEN_COMPACT } from "@/components/shared/data-grid";
import { HarnessCell, harnessLabel } from "@/components/shared/harness-cell";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { getAgentModelDisplay, getAgentModelPresentation } from "@/lib/agents-list-model-display";
import { agentSearchText, matchesSearchTerms } from "@/lib/list-search";
import { formatSmartTime } from "@/lib/utils";

export default function AgentsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const { data: agents, isLoading } = useAgents();
  const { data: agentConfigs } = useConfigs({ scope: "agent" });
  const { data: modelsCatalog } = useModelsCatalog();
  const search = readStringParam(searchParams, "search");
  const statusFilter = readStringParam(searchParams, "status", "all");

  const modelColumnGate = useFeatureGate("1.77.2");
  const isMobile = useIsMobile();

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const filtered =
      statusFilter === "all" ? [...agents] : agents.filter((a) => a.status === statusFilter);
    return filtered.sort((a, b) => (b.isLead ? 1 : 0) - (a.isLead ? 1 : 0));
  }, [agents, statusFilter]);

  // The saved runtime settings, which the next task runs on. The last-reported
  // model and effort (`credStatus.latestModel`) are the fallback only: they lag
  // a change until the agent runs again.
  const { configuredModelByAgentId, configuredEffortByAgentId } = useMemo(() => {
    const visibleIds = new Set(filteredAgents.map((agent) => agent.id));
    const modelByAgentId = new Map<string, string>();
    const effortByAgentId = new Map<string, ReasoningEffortLevel>();
    for (const config of agentConfigs ?? []) {
      if (config.scope !== "agent" || !config.scopeId || !visibleIds.has(config.scopeId)) continue;
      const value = config.value.trim();
      if (config.key === "MODEL_OVERRIDE" && value) {
        modelByAgentId.set(config.scopeId, value);
      } else if (
        config.key === "REASONING_EFFORT_OVERRIDE" &&
        (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
      ) {
        effortByAgentId.set(config.scopeId, value as ReasoningEffortLevel);
      }
    }
    return { configuredModelByAgentId: modelByAgentId, configuredEffortByAgentId: effortByAgentId };
  }, [agentConfigs, filteredAgents]);

  const modelSearchText = useCallback(
    (agent: AgentWithTasks) => {
      const display = getAgentModelDisplay(
        configuredModelByAgentId.get(agent.id),
        agent.credStatus?.latestModel?.model,
        configuredEffortByAgentId.get(agent.id) ?? agent.credStatus?.latestModel?.reasoningEffort,
      );
      const primary = getAgentModelPresentation(display.primary, modelsCatalog?.providers);
      return [primary?.label, primary?.raw, primary?.provider, display.configured, display.lastUsed]
        .filter(Boolean)
        .join(" ");
    },
    [configuredModelByAgentId, configuredEffortByAgentId, modelsCatalog?.providers],
  );

  const columnDefs = useMemo<ColDef<AgentWithTasks>[]>(() => {
    const modelColumn: ColDef<AgentWithTasks> = {
      headerName: "Model",
      context: HIDE_WHEN_COMPACT,
      width: 320,
      minWidth: 260,
      valueGetter: (params) => (params.data ? modelSearchText(params.data) : ""),
      cellRenderer: (params: { data: AgentWithTasks | undefined }) => {
        const agent = params.data;
        if (!agent) return null;
        const display = getAgentModelDisplay(
          configuredModelByAgentId.get(agent.id),
          agent.credStatus?.latestModel?.model,
          configuredEffortByAgentId.get(agent.id) ?? agent.credStatus?.latestModel?.reasoningEffort,
        );
        return <AgentModelCell display={display} liveCatalog={modelsCatalog?.providers} />;
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
      { field: "role", headerName: "Role", width: 150, context: HIDE_WHEN_COMPACT },
      {
        field: "harnessProvider",
        headerName: "Harness",
        context: HIDE_WHEN_COMPACT,
        width: 200,
        cellRenderer: (params: { data: AgentWithTasks | undefined }) => (
          <HarnessCell
            harnessProvider={params.data?.harnessProvider}
            credStatus={params.data?.credStatus}
            claudeTransport={params.data?.claudeTransport}
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
        context: HIDE_WHEN_COMPACT,
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
              <span className={atCapacity ? "text-status-error-strong" : "text-muted-foreground"}>
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
  }, [
    configuredModelByAgentId,
    configuredEffortByAgentId,
    modelColumnGate.supported,
    modelSearchText,
    modelsCatalog?.providers,
  ]);

  // One search for both widths, so a phone finds the same agents as the grid.
  const searchedAgents = useMemo(() => {
    if (!search.trim()) return filteredAgents;
    return filteredAgents.filter((agent) =>
      matchesSearchTerms(
        agentSearchText(agent, [
          agent.harnessProvider ? harnessLabel(agent.harnessProvider) : null,
          modelColumnGate.supported ? modelSearchText(agent) : null,
        ]),
        search,
      ),
    );
  }, [filteredAgents, modelColumnGate.supported, modelSearchText, search]);

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AgentWithTasks>) => {
      if (event.data) void navigate(`/agents/${event.data.id}`);
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

      {isMobile ? (
        <MobileList label="Agents" loading={isLoading} emptyMessage="No agents found">
          {searchedAgents.map((agent) => {
            const model = getAgentModelPresentation(
              getAgentModelDisplay(
                configuredModelByAgentId.get(agent.id),
                agent.credStatus?.latestModel?.model,
              ).primary,
              modelsCatalog?.providers,
            );
            return (
              <MobileListRow
                key={agent.id}
                to={`/agents/${agent.id}`}
                live={agent.status === "busy"}
                leading={<AgentAvatar agentId={agent.id} agentName={agent.name} size="sm" />}
                title={agent.name}
                status={<StatusBadge status={agent.status} />}
                meta={[
                  agent.role,
                  agent.harnessProvider ? harnessLabel(agent.harnessProvider) : null,
                  model?.label,
                ]}
              />
            );
          })}
        </MobileList>
      ) : (
        <DataGrid
          rowData={searchedAgents}
          columnDefs={columnDefs}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No agents found"
          paginationQueryKey="agents"
        />
      )}
    </div>
  );
}
