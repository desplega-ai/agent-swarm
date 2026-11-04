import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import { useApiKeyStatuses } from "@/api/hooks/use-api-keys";
import { useCodexAccounts } from "@/api/hooks/use-codex-accounts";
import { useUsageSummary } from "@/api/hooks/use-costs";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { poolKeysQueryKey } from "@/api/hooks/use-pool-keys";
import type { PoolKeysResponse } from "@/api/types";
import {
  AI_PROVIDERS,
  buildProviderRows,
  isUnhealthyKey,
  LIST_POOL_VARS,
  type ProviderRow,
} from "@/lib/ai-providers";

/** The pool vars plus the keys that mark a provider without its own pool as set up. */
const PRESENCE_KEYS = [
  ...LIST_POOL_VARS,
  ...AI_PROVIDERS.flatMap((p) => p.configuredBy ?? []),
].filter((key, i, all) => all.indexOf(key) === i);

const NO_PRESENCE: Record<string, boolean> = {};

/** Module-level, so `useQueries` keeps the combined value while no pool changes. */
function combinePools(results: { data?: PoolKeysResponse; isLoading: boolean }[]) {
  return {
    pools: results.map((r) => r.data),
    loading: results.some((r) => r.isLoading),
  };
}

/** A UTC day (`YYYY-MM-DD`) `daysAgo` days back: the usage summary compares dates as strings. */
function utcDay(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export interface LlmProviderRows {
  rows: ProviderRow[];
  /** `true` while the first reads load. */
  loading: boolean;
  /** Env presence of the pool vars and `configuredBy` keys. */
  presence: Record<string, boolean>;
  /** Keys rate limited or rejected, by the sidebar dot's rule. */
  unhealthyKeys: number;
}

/**
 * Everything the LLMs tab lists: the stored pool of each set pool var, the
 * ChatGPT accounts, the key status rows (name, plan, windows, last use) and
 * the API value of today's and the last 7 days' runs per credential.
 */
export function useLlmProviderRows(): LlmProviderRows {
  const presenceQuery = useEnvPresence(PRESENCE_KEYS);
  const presence = presenceQuery.data ?? NO_PRESENCE;
  // Same query keys as `usePoolKeys`, so the side panel shares the cache.
  const poolQueries = useQueries({
    queries: LIST_POOL_VARS.map((envVar) => ({
      queryKey: poolKeysQueryKey(envVar),
      queryFn: () => api.fetchPoolKeys(envVar),
      enabled: presence[envVar] === true,
    })),
    combine: combinePools,
  });
  const codex = useCodexAccounts();
  const statuses = useApiKeyStatuses();
  const today = utcDay(0);
  const weekStart = utcDay(6);
  const usageToday = useUsageSummary({ startDate: today, groupBy: "both" });
  const usage7d = useUsageSummary({ startDate: weekStart, groupBy: "both" });

  const rows = useMemo(
    () =>
      buildProviderRows({
        pools: Object.fromEntries(
          LIST_POOL_VARS.map((envVar, i) => {
            const pool = poolQueries.pools[i];
            // A var that is not set has no keys, even when an old answer is cached.
            return [envVar, presence[envVar] && pool ? pool : undefined];
          }),
        ),
        codexAccounts: codex.data,
        statuses: statuses.data,
        usageToday: usageToday.data?.byCredential,
        usage7d: usage7d.data?.byCredential,
      }),
    [
      poolQueries.pools,
      presence,
      codex.data,
      statuses.data,
      usageToday.data?.byCredential,
      usage7d.data?.byCredential,
    ],
  );

  return {
    rows,
    loading: presenceQuery.isLoading || codex.isLoading || poolQueries.loading,
    presence,
    unhealthyKeys: (statuses.data ?? []).filter(isUnhealthyKey).length,
  };
}
