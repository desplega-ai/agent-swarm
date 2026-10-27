import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/client";
import { invalidateStatusQuery } from "@/api/hooks/status-query";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useConfig } from "@/hooks/use-config";
import { AgentFsClient, swarmProxyCredential } from "@/lib/agent-fs/client";
import type { ConnectFlowDeps } from "./connect-flow";

/**
 * The real agent-fs and swarm calls behind `createAndConnect` and
 * `connectWithKey`, for the Comb connect card and the `/setup` Files step.
 * Null while Comb has no agent-fs endpoint. Needs an `AgentFsProvider`.
 */
export function useConnectFlowDeps(): ConnectFlowDeps | null {
  const { endpoint, orgId, driveId, connect } = useAgentFs();
  const queryClient = useQueryClient();
  const { config } = useConfig();
  const { apiUrl, apiKey } = config;

  return useMemo(() => {
    if (!endpoint) return null;
    // The swarm's proxy registers only with a swarm credential.
    const swarmKey = swarmProxyCredential(endpoint, { apiUrl, apiKey });
    return {
      register: (address) => AgentFsClient.register({ endpoint, email: address, swarmKey }),
      getMe: (key) => new AgentFsClient({ endpoint, apiKey: key }).getMe(),
      ls: (key) =>
        new AgentFsClient({ endpoint, apiKey: key }).callOp(
          orgId as string,
          "ls",
          { path: "/" },
          driveId as string,
        ),
      invite: async (address) => {
        await api.inviteAgentFsMember({ email: address, role: "editor" });
        void invalidateStatusQuery(queryClient);
      },
      connect,
    } satisfies ConnectFlowDeps;
  }, [endpoint, orgId, driveId, connect, queryClient, apiUrl, apiKey]);
}
