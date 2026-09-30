// react-query plumbing shared by `AgentFsProvider` and the agent-fs hooks
// (`api/hooks/use-agent-fs.ts`). It lives here, not in either of them, so the
// hooks import the context and never the reverse.

import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { isAgentFsAuthError } from "./client";

/**
 * Every agent-fs query key: `["agent-fs", endpoint, userId, orgId, driveId, ...rest]`.
 *
 * - `endpoint` is `useAgentFs().endpoint` (never `client.endpoint`), so the
 *   `["agent-fs", endpoint]` prefix that `connect()` evicts matches every key.
 * - `orgId` and `driveId` are the org and drive that the query reads.
 *   Drive-independent keys pass `null` for both (`me`). `/health` is public
 *   and also passes a `null` userId.
 * - Invalidate by prefix, for example
 *   `agentFsKey(endpoint, userId, orgId, driveId, "ls")` for every folder
 *   listing on one drive.
 *
 * Keys that start with "agent-fs" never persist to the dashboard's
 * localStorage query cache (`shouldPersistQuery`).
 */
export function agentFsKey(
  endpoint: string,
  userId: string | null,
  orgId: string | null,
  driveId: string | null,
  ...rest: unknown[]
) {
  return ["agent-fs", endpoint, userId, orgId, driveId, ...rest] as const;
}

/** `retry` for every agent-fs query. A 401 is a bad key, so a retry cannot help. */
export function agentFsRetry(failureCount: number, error: Error): boolean {
  return !isAgentFsAuthError(error) && failureCount < 2;
}

/**
 * Check the identity again when any other agent-fs query answers 401. A
 * revoked or reset key then fails `me` too, and Comb moves to `invalid-key`.
 * Returns the unsubscribe function.
 */
export function recheckMeOnAuthError(queryClient: QueryClient, meKey: QueryKey): () => void {
  const meHash = hashKey(meKey);
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    const { query } = event;
    if (query.queryKey[0] !== "agent-fs" || query.queryHash === meHash) return;
    if (!isAgentFsAuthError(event.action.error)) return;
    void queryClient.invalidateQueries({ queryKey: meKey, exact: true });
  });
}
