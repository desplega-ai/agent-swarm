import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar } from "./utils";

export const registerRuntimePoolBindAgentTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-pool-bind-agent",
    {
      title: "Runtime Pool Bind Agent",
      description: "Bind an agent to a runtime pool. Use a null poolId to remove the binding.",
      annotations: { openWorldHint: false },
      inputSchema: z
        .object({ agentId: z.string().min(1), poolId: z.string().min(1).nullable() })
        .strict(),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (args, requestInfo) => {
      return proxyRuntimePoolsApi({
        method: "PUT",
        path: `/api/agents/${encodeURIComponent(args.agentId)}/runtime-pool`,
        body: { poolId: args.poolId },
        requestInfo,
        message: "Agent runtime pool binding saved.",
      });
    },
  );
};
