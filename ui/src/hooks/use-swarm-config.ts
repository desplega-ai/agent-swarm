import type { RowClickedEvent } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs, useDeleteConfig, useUpsertConfig } from "@/api/hooks/use-config-api";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";

export interface ConfigFormData {
  scope: SwarmConfigScope;
  scopeId: string;
  key: string;
  value: string;
  isSecret: boolean;
  description: string;
}

export const emptyConfigForm: ConfigFormData = {
  scope: "global",
  scopeId: "",
  key: "",
  value: "",
  isSecret: false,
  description: "",
};

type SwarmConfigScopeFilter = SwarmConfigScope | "all";

const CONFIG_SCOPE_FILTERS = new Set<string>(["all", "global", "agent", "repo"]);

function coerceScopeFilter(value: string): SwarmConfigScopeFilter {
  return CONFIG_SCOPE_FILTERS.has(value) ? (value as SwarmConfigScopeFilter) : "all";
}

export function useSwarmConfig() {
  const { data: configs, isLoading } = useConfigs({ includeSecrets: true });
  const { data: agents } = useAgents();
  const upsertConfig = useUpsertConfig();
  const deleteConfig = useDeleteConfig();
  const { searchParams, setParam, setParams } = useUrlSearchState();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<SwarmConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SwarmConfig | null>(null);
  const [detailEntry, setDetailEntry] = useState<SwarmConfig | null>(null);
  const scopeFilter = coerceScopeFilter(readStringParam(searchParams, "scope", "all"));
  const search = readStringParam(searchParams, "search");
  const agentFilter = readStringParam(searchParams, "agent") || null;
  const setScopeFilter = useCallback(
    (scope: string) =>
      setParams(
        { scope: coerceScopeFilter(scope), agent: "" },
        { defaultValues: { scope: "all" }, reset: ["swarmConfigPage"] },
      ),
    [setParams],
  );
  const setSearch = useCallback(
    (value: string) => setParam("search", value, { reset: ["swarmConfigPage"] }),
    [setParam],
  );
  const setAgentFilter = useCallback(
    (value: string | null) => setParam("agent", value, { reset: ["swarmConfigPage"] }),
    [setParam],
  );

  useEffect(() => {
    if (scopeFilter !== "agent" && agentFilter) setAgentFilter(null);
  }, [agentFilter, scopeFilter, setAgentFilter]);

  function handleAdd() {
    setEditEntry(null);
    setDialogOpen(true);
  }

  const handleEdit = useCallback((entry: SwarmConfig) => {
    setEditEntry(entry);
    setDialogOpen(true);
  }, []);

  function handleSubmit(data: ConfigFormData) {
    upsertConfig.mutate({
      scope: data.scope,
      scopeId: data.scopeId || null,
      key: data.key,
      value: data.value,
      isSecret: data.isSecret,
      description: data.description || null,
    });
    setEditEntry(null);
  }

  function handleDelete() {
    if (deleteTarget) {
      deleteConfig.mutate(deleteTarget.id);
      setDeleteTarget(null);
    }
  }

  const onRowClicked = useCallback((event: RowClickedEvent<SwarmConfig>) => {
    const target = event.event?.target as HTMLElement | undefined;
    if (target?.closest("button, a, [role='button']")) return;
    if (event.data) setDetailEntry(event.data);
  }, []);

  const filteredConfigs = useMemo(() => {
    if (!configs) return [];
    const q = search.trim().toLowerCase();
    return configs.filter((c) => {
      if (scopeFilter !== "all" && c.scope !== scopeFilter) return false;
      if (scopeFilter === "agent" && agentFilter && c.scopeId !== agentFilter) return false;
      if (q) {
        const agentName = c.scopeId ? (agentMap.get(c.scopeId) ?? "") : "";
        const haystack = `${c.key} ${c.description ?? ""} ${agentName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [configs, scopeFilter, agentFilter, search, agentMap]);

  const agentOptions = useMemo(
    () => (agents ?? []).map((a) => ({ value: a.id, label: a.name })),
    [agents],
  );

  return {
    configs,
    isLoading,
    agents,
    agentMap,
    dialogOpen,
    setDialogOpen,
    editEntry,
    setEditEntry,
    deleteTarget,
    setDeleteTarget,
    detailEntry,
    setDetailEntry,
    scopeFilter,
    setScopeFilter,
    search,
    setSearch,
    agentFilter,
    setAgentFilter,
    handleAdd,
    handleEdit,
    handleSubmit,
    handleDelete,
    onRowClicked,
    filteredConfigs,
    agentOptions,
  };
}
