// react-query hooks for Comb's direct agent-fs calls (the browser talks to
// agent-fs with the human's own key, never through the swarm API).
//
// Every key starts with "agent-fs", so these results never persist to the
// dashboard's localStorage query cache (`shouldPersistQuery`), and
// `disconnect()` drops them all at once.

import { useQuery } from "@tanstack/react-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsClient, isAgentFsAuthError } from "@/lib/agent-fs/client";
import type { LsResult } from "@/lib/agent-fs/types";

/**
 * `["agent-fs", endpoint, userId, ...rest]`. `userId` is null for public
 * calls (`/health`). Invalidate by prefix, for example
 * `agentFsKey(endpoint, userId, "ls")` for every folder listing.
 */
export function agentFsKey(endpoint: string, userId: string | null, ...rest: unknown[]) {
  return ["agent-fs", endpoint, userId, ...rest] as const;
}

/** Connection-level data changes rarely: no polling. */
const CONNECTION_QUERY = { staleTime: 5 * 60_000, refetchInterval: false } as const;

/** Public server info. `features` gates Comb surfaces that need a newer agent-fs. */
export function useAgentFsHealth(endpoint: string | null) {
  return useQuery({
    queryKey: agentFsKey(endpoint ?? "", null, "health"),
    queryFn: ({ signal }) => AgentFsClient.health(endpoint as string, { signal }),
    enabled: endpoint !== null,
    retry: 1,
    ...CONNECTION_QUERY,
  });
}

/**
 * The connected identity. The provider runs it to learn whether the saved key
 * still works (a 401 is not retried). Components read `useAgentFs().me`.
 */
export function useAgentFsMe(client: AgentFsClient | null, userId: string | null) {
  return useQuery({
    queryKey: agentFsKey(client?.endpoint ?? "", userId, "me"),
    queryFn: ({ signal }) => (client as AgentFsClient).getMe({ signal }),
    enabled: client !== null,
    retry: (failureCount, error) => !isAgentFsAuthError(error) && failureCount < 2,
    ...CONNECTION_QUERY,
  });
}

/** Folder listing on the swarm drive. `path` is drive-absolute ("/" is the root). */
export function useAgentFsLs(path: string) {
  const { state, client, endpoint, credential, orgId, driveId } = useAgentFs();
  return useQuery({
    queryKey: agentFsKey(endpoint ?? "", credential?.userId ?? null, "ls", path),
    queryFn: ({ signal }) =>
      (client as AgentFsClient).callOp<LsResult>(
        orgId as string,
        "ls",
        { path },
        driveId as string,
        { signal },
      ),
    enabled: state === "ready" && client !== null && orgId !== null && driveId !== null,
  });
}
