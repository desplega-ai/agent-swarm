// react-query hooks for Comb's direct agent-fs calls (the browser talks to
// agent-fs with the human's own key, never through the swarm API).
//
// Build every key with `agentFsKey` (contract in `lib/agent-fs/query.ts`) and
// pass `retry: agentFsRetry`. Keys start with "agent-fs", so these results
// never persist to the dashboard's localStorage query cache, and
// `disconnect()` drops them all at once. This file imports the context, never
// the reverse.

import { useQuery } from "@tanstack/react-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { AgentFsClient } from "@/lib/agent-fs/client";
import { agentFsKey, agentFsRetry } from "@/lib/agent-fs/query";
import type { LsResult } from "@/lib/agent-fs/types";

export { agentFsKey, agentFsRetry };

/** Folder listing on the swarm drive. `path` is drive-absolute ("/" is the root). */
export function useAgentFsLs(path: string) {
  const { state, client, endpoint, credential, orgId, driveId } = useAgentFs();
  return useQuery({
    queryKey: agentFsKey(endpoint ?? "", credential?.userId ?? null, orgId, driveId, "ls", path),
    queryFn: ({ signal }) =>
      (client as AgentFsClient).callOp<LsResult>(
        orgId as string,
        "ls",
        { path },
        driveId as string,
        { signal },
      ),
    enabled: state === "ready" && client !== null && orgId !== null && driveId !== null,
    retry: agentFsRetry,
  });
}
