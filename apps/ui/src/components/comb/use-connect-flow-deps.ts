import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import { invalidateStatusQuery } from "@/api/hooks/status-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsClient } from "@/lib/agent-fs/client";
import type { ConnectFlowDeps } from "./connect-flow";

/**
 * The real swarm and agent-fs calls behind `autoConnect` and
 * `connectWithKey`, for the Comb connect card and the `/setup` Files step.
 * Null while Comb has no agent-fs endpoint. Needs an `AgentFsProvider`.
 */
export function useConnectFlowDeps(): ConnectFlowDeps | null {
  const { endpoint, orgId, driveId, connect } = useAgentFs();
  const queryClient = useQueryClient();

  return useMemo(() => {
    if (!endpoint) return null;
    return {
      fsMe: () => api.fsMe(),
      mintKey: (label) => api.mintFsKey(label),
      getMe: (key) => new AgentFsClient({ endpoint, apiKey: key }).getMe(),
      ls: (key) =>
        new AgentFsClient({ endpoint, apiKey: key }).callOp(
          orgId as string,
          "ls",
          { path: "/" },
          driveId as string,
        ),
      invite: async (address, key) => {
        const result = await api.inviteAgentFsMember({ email: address, role: "editor" });
        // agent-fs >= 0.18.19 answers an account outside the org with a
        // pending invite; the person connecting accepts it with their own key.
        if (result.status === "pending" && result.token) {
          await new AgentFsClient({ endpoint, apiKey: key }).acceptInvite(result.token);
        }
        void invalidateStatusQuery(queryClient);
      },
      connect,
    } satisfies ConnectFlowDeps;
  }, [endpoint, orgId, driveId, connect, queryClient]);
}
