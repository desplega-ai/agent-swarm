import { useQueryClient } from "@tanstack/react-query";
import type { RowClickedEvent } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAgents } from "@/api/hooks/use-agents";
import { useConfigs, useDeleteConfig, useUpsertConfig } from "@/api/hooks/use-config-api";
import type { SwarmConfig, SwarmConfigScope } from "@/api/types";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";

// ---------------------------------------------------------------------------
// Single-key helpers
//
// `useSwarmConfig(key)` is the mutation-capable primitive for one global
// `swarm_config` row: read the current value, upsert it, or delete it back to
// the code default. `useSwarmConfigEnabled(key)` is the read-only
// feature-flag view on top of it.
//
// Both read from the same `useConfigs({ scope: "global" })` query, so a page
// rendering dozens of rows still issues exactly one request. Mutations
// invalidate BOTH `["configs"]` and `["config", "env-presence"]` — the server
// debounce-reloads global upserts into `process.env`, which changes presence.
// ---------------------------------------------------------------------------

const TRUTHY_CONFIG_VALUES: ReadonlySet<string> = new Set(["true", "1"]);

/**
 * Server-compatible truthiness for a stored config value: trimmed,
 * case-insensitive, `"true"` or `"1"` only.
 */
export function isTruthyConfigValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return TRUTHY_CONFIG_VALUES.has(value.trim().toLowerCase());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface UseSwarmConfigResult {
  /** The `global`-scope row for this key, or `undefined` when unset. */
  config: SwarmConfig | undefined;
  /** Convenience alias for `config?.value`. */
  value: string | undefined;
  isLoading: boolean;
  /** Upsert `{ scope: "global", key, value, isSecret: false }`. */
  save: (value: string, options?: { description?: string | null }) => void;
  /** Delete the row so the key falls back to env / the code default. No-op when unset. */
  reset: () => void;
  isSaving: boolean;
}

/**
 * Read + write a single global `swarm_config` value.
 *
 * Env vars still win at boot; a value saved here becomes effective after the
 * server's debounced auto-reload (or an explicit `POST /api/config/reload`).
 */
export function useSwarmConfig(key: string): UseSwarmConfigResult {
  const queryClient = useQueryClient();
  const { data: configs, isLoading } = useConfigs({ scope: "global" });
  const upsertConfig = useUpsertConfig();
  const deleteConfig = useDeleteConfig();

  const config = useMemo(
    () => configs?.find((c) => c.scope === "global" && c.key === key),
    [configs, key],
  );

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["configs"] });
    queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
    // The server applies global upserts/deletes to `process.env` via a ~250ms
    // debounced reload, so the immediate refetch above usually still observes
    // the OLD env presence. Re-check after the debounce has fired so source
    // chips ("db (pending reload)", "Set via environment") converge without a
    // manual refresh.
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
    }, 1500);
  }, [queryClient]);

  const save = useCallback(
    (value: string, options?: { description?: string | null }) => {
      upsertConfig.mutate(
        {
          scope: "global",
          scopeId: null,
          key,
          value,
          isSecret: false,
          description: options?.description ?? null,
        },
        {
          onSuccess: () => {
            invalidate();
            toast.success(`Saved ${key}`);
          },
          onError: (err) => {
            toast.error(`Failed to save ${key}: ${errorMessage(err)}`);
          },
        },
      );
    },
    [invalidate, key, upsertConfig],
  );

  const reset = useCallback(() => {
    if (!config) return;
    deleteConfig.mutate(config.id, {
      onSuccess: () => {
        invalidate();
        toast.success(`Reset ${key} to its default`);
      },
      onError: (err) => {
        toast.error(`Failed to reset ${key}: ${errorMessage(err)}`);
      },
    });
  }, [config, deleteConfig, invalidate, key]);

  return {
    config,
    value: config?.value,
    isLoading,
    save,
    reset,
    isSaving: upsertConfig.isPending || deleteConfig.isPending,
  };
}

/**
 * Feature-flag-style read of a single global `swarm_config` value.
 * Falls back to `defaultValue` when no row exists.
 */
export function useSwarmConfigEnabled(
  key: string,
  defaultValue = false,
): { enabled: boolean; isLoading: boolean } {
  const { data: configs, isLoading } = useConfigs({ scope: "global" });
  const row = configs?.find((c) => c.scope === "global" && c.key === key);
  return {
    enabled: row ? isTruthyConfigValue(row.value) : defaultValue,
    isLoading,
  };
}

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

/**
 * Controller for the Secrets page's `swarm_config` DataGrid — filters,
 * dialogs, and CRUD across every scope. Distinct from the single-key
 * `useSwarmConfig` primitive above.
 */
export function useSwarmConfigTable() {
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
