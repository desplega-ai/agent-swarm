import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { refreshCredentialQueries } from "./use-pool-keys";

export const CODEX_ACCOUNTS_QUERY_KEY = ["codex-accounts"] as const;

/** The stored ChatGPT accounts, sorted by slot. Polls with the app default. */
export function useCodexAccounts() {
  return useQuery({
    queryKey: CODEX_ACCOUNTS_QUERY_KEY,
    queryFn: () => api.fetchCodexAccounts(),
    // A persisted snapshot can be stale: confirm the list with the server.
    refetchOnMount: "always",
    select: (data) => data.accounts,
  });
}

/** Delete one ChatGPT account slot. The cache takes the accounts that are left. */
export function useRemoveCodexAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slot: number) => api.removeCodexAccount(slot),
    onMutate: () => queryClient.cancelQueries({ queryKey: CODEX_ACCOUNTS_QUERY_KEY }),
    onSuccess: (response) => queryClient.setQueryData(CODEX_ACCOUNTS_QUERY_KEY, response),
    onSettled: () => refreshCredentialQueries(queryClient, CODEX_ACCOUNTS_QUERY_KEY),
  });
}
