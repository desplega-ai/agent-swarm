import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../client";
import type { SwarmConfig, SwarmConfigsResponse } from "../types";
import { POOL_KEYS_QUERY_KEY } from "./use-pool-keys";

export interface ConfigFilters {
  scope?: string;
  scopeId?: string;
  includeSecrets?: boolean;
}

export function useConfigs(filters?: ConfigFilters) {
  return useQuery({
    queryKey: ["configs", filters],
    // A reload immediately after Save can restore a still-fresh persisted snapshot.
    // Configuration controls must confirm their saved values with the server.
    refetchOnMount: "always",
    queryFn: () => api.fetchConfigs(filters),
    select: (data) => data.configs,
  });
}

export interface ResolvedConfigFilters {
  agentId?: string;
  repoId?: string;
  includeSecrets?: boolean;
}

/**
 * Query key, fetcher, and `select` of `useResolvedConfigs`. Spread it into
 * `useQueries` to read several agents with the same cache entries.
 */
export function resolvedConfigsQuery(filters?: ResolvedConfigFilters) {
  return queryOptions({
    queryKey: ["configs", "resolved", filters],
    queryFn: () => api.fetchResolvedConfig(filters),
    select: (data: SwarmConfigsResponse) => data.configs,
  });
}

export function useResolvedConfigs(
  filters?: ResolvedConfigFilters,
  options?: { enabled?: boolean },
) {
  return useQuery({ ...resolvedConfigsQuery(filters), enabled: options?.enabled ?? true });
}

/** The query of `useModelTiers`. */
const MODEL_TIERS_KEY = ["models-catalog", "tiers"];
/** The API reloads its env about 250 ms after a global write (debounced): wait past it. */
const ENV_RELOAD_MS = 1000;

/**
 * Refetch the model tiers after a global config write, so a tier edit shows
 * in about a second instead of on the next 15 s poll. The tiers read the API
 * env, and the env changes only after the server's debounced reload.
 */
function refreshModelTiersAfterReload(queryClient: QueryClient) {
  setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: MODEL_TIERS_KEY });
  }, ENV_RELOAD_MS);
}

export function useUpsertConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      scope: string;
      scopeId?: string | null;
      key: string;
      value: string;
      isSecret?: boolean;
      envPath?: string | null;
      description?: string | null;
      exportToEnv?: boolean;
    }) => api.upsertConfig(data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      if (variables.scope === "global") refreshModelTiersAfterReload(queryClient);
    },
  });
}

export function useDeleteConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.deleteConfig(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      // A reset tier falls back to its default.
      refreshModelTiersAfterReload(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Batch helpers, used by the Integrations UI (Phase 3).
//
// The `/api/config` endpoint has no bulk route, so these hooks fire sequential
// HTTP requests and aggregate results into a single toast. Query invalidation
// happens once on completion to avoid thrashing the list.
//
// Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) are filtered out as
// defense-in-depth: the server rejects them with 400 (see
// `src/be/swarm-config-guard.ts`), but filtering client-side keeps the UX
// clean when a catalog entry is accidentally mis-typed during development.
// ---------------------------------------------------------------------------

const RESERVED_KEYS: ReadonlySet<string> = new Set(["api_key", "secrets_encryption_key"]);

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toLowerCase());
}

export interface UpsertConfigEntry {
  key: string;
  value: string;
  isSecret?: boolean;
  description?: string | null;
  envPath?: string | null;
  scope?: "global";
  scopeId?: string | null;
  /** Omitted: the server default for the key applies. */
  exportToEnv?: boolean;
}

export interface BatchResult {
  successCount: number;
  failureCount: number;
  errors: Array<{ key: string; message: string }>;
}

export function useUpsertConfigsBatch() {
  const queryClient = useQueryClient();

  return useMutation<BatchResult, Error, UpsertConfigEntry[]>({
    mutationFn: async (entries) => {
      const filtered: UpsertConfigEntry[] = [];
      for (const entry of entries) {
        if (isReservedKey(entry.key)) {
          console.warn(
            `[useUpsertConfigsBatch] skipping reserved key "${entry.key}" (rejected by server)`,
          );
          continue;
        }
        filtered.push(entry);
      }

      const errors: Array<{ key: string; message: string }> = [];
      let successCount = 0;

      for (const entry of filtered) {
        try {
          await api.upsertConfig({
            scope: entry.scope ?? "global",
            scopeId: entry.scopeId ?? null,
            key: entry.key,
            value: entry.value,
            isSecret: entry.isSecret,
            description: entry.description ?? null,
            envPath: entry.envPath ?? null,
            ...(entry.exportToEnv !== undefined ? { exportToEnv: entry.exportToEnv } : {}),
          });
          successCount += 1;
        } catch (err) {
          errors.push({
            key: entry.key,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        successCount,
        failureCount: errors.length,
        errors,
      };
    },
    onSettled: (result) => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      // A write can change a credential pool (Reset integration deletes its row).
      queryClient.invalidateQueries({ queryKey: POOL_KEYS_QUERY_KEY });
      if (!result) return;
      if (result.failureCount === 0) {
        toast.success(`Saved ${result.successCount} value${result.successCount === 1 ? "" : "s"}`);
      } else {
        const first = result.errors[0]?.message ?? "unknown error";
        toast.error(`Saved ${result.successCount}, failed ${result.failureCount}: ${first}`);
      }
    },
  });
}

export interface DeleteConfigsBatchInput {
  /** Current configs from the cache, used to look up row ids by key+scope. */
  configs: SwarmConfig[];
  /** Keys to delete (scope="global" rows only by default). */
  keys: string[];
  scope?: "global";
  scopeId?: string | null;
}

export function useDeleteConfigsBatch() {
  const queryClient = useQueryClient();

  return useMutation<BatchResult, Error, DeleteConfigsBatchInput>({
    mutationFn: async ({ configs, keys, scope = "global", scopeId = null }) => {
      const targetIds: Array<{ id: string; key: string }> = [];
      for (const key of keys) {
        if (isReservedKey(key)) {
          console.warn(
            `[useDeleteConfigsBatch] skipping reserved key "${key}" (rejected by server)`,
          );
          continue;
        }
        const row = configs.find(
          (c) => c.key === key && c.scope === scope && (c.scopeId ?? null) === scopeId,
        );
        if (row) targetIds.push({ id: row.id, key });
      }

      const errors: Array<{ key: string; message: string }> = [];
      let successCount = 0;

      for (const t of targetIds) {
        try {
          await api.deleteConfig(t.id);
          successCount += 1;
        } catch (err) {
          errors.push({
            key: t.key,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        successCount,
        failureCount: errors.length,
        errors,
      };
    },
    onSettled: (result) => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      // A write can change a credential pool (Reset integration deletes its row).
      queryClient.invalidateQueries({ queryKey: POOL_KEYS_QUERY_KEY });
      if (!result) return;
      if (result.successCount === 0 && result.failureCount === 0) {
        toast.info("Nothing to delete");
        return;
      }
      if (result.failureCount === 0) {
        toast.success(
          `Deleted ${result.successCount} value${result.successCount === 1 ? "" : "s"}`,
        );
      } else {
        const first = result.errors[0]?.message ?? "unknown error";
        toast.error(`Deleted ${result.successCount}, failed ${result.failureCount}: ${first}`);
      }
    },
  });
}
