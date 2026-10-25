import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { PoolKeysAddResponse, PoolKeysResponse } from "../types";
import { invalidateStatusQuery } from "./status-query";
import { ONBOARDING_QUERY_KEY } from "./use-onboarding";

export const POOL_KEYS_QUERY_KEY = ["pool-keys"] as const;

export function poolKeysQueryKey(envVar: string) {
  return [...POOL_KEYS_QUERY_KEY, envVar] as const;
}

/**
 * The API applies a global write to its env about 250 ms after the last one.
 * Reads of that env (env presence, onboarding, `/status`) refresh once more
 * after this delay.
 */
const ENV_SETTLE_MS = 750;

let settleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Refresh every query that reads a credential after a pool or Codex account
 * write: the list itself, the config rows, env presence, onboarding signals,
 * and the key statuses. One settle timer for the page, so a burst of writes
 * refreshes the env reads once.
 */
export function refreshCredentialQueries(
  queryClient: QueryClient,
  listKey: readonly unknown[],
): Promise<unknown> {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
    void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    void invalidateStatusQuery(queryClient);
  }, ENV_SETTLE_MS);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: listKey }),
    queryClient.invalidateQueries({ queryKey: ["configs"] }),
    queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] }),
    queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ["api-key-statuses"] }),
  ]);
}

/** The keys of one credential pool var (suffixes and statuses). Polls with the app default. */
export function usePoolKeys(envVar: string) {
  return useQuery({
    queryKey: poolKeysQueryKey(envVar),
    queryFn: () => api.fetchPoolKeys(envVar),
    // A persisted snapshot can be stale: confirm the list with the server.
    refetchOnMount: "always",
  });
}

/** Strip the add-only `checks` so the cached list keeps the GET shape. */
function listOf(response: PoolKeysAddResponse): PoolKeysResponse {
  const { checks: _checks, ...list } = response;
  return list;
}

/**
 * Check and append keys to a pool. The list in the cache takes the server's
 * answer at once: a GET that started before the write is cancelled first.
 * Errors are `CredentialApiError`s (422 carries `checks`).
 */
export function useAddPoolKeys(envVar: string) {
  const queryClient = useQueryClient();
  const queryKey = poolKeysQueryKey(envVar);
  return useMutation({
    mutationFn: ({ value, baseUrl }: { value: string; baseUrl?: string | null }) =>
      api.addPoolKeys(envVar, value, baseUrl),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (response) => queryClient.setQueryData(queryKey, listOf(response)),
    onSettled: () => refreshCredentialQueries(queryClient, queryKey),
  });
}

/** Remove one pool member. A 409 means the list changed: the refetch shows the new one. */
export function useRemovePoolKey(envVar: string) {
  const queryClient = useQueryClient();
  const queryKey = poolKeysQueryKey(envVar);
  return useMutation({
    mutationFn: (member: { index: number; suffix: string }) =>
      api.removePoolKey({ key: envVar, ...member }),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: (response) => queryClient.setQueryData(queryKey, response),
    onSettled: () => refreshCredentialQueries(queryClient, queryKey),
  });
}
