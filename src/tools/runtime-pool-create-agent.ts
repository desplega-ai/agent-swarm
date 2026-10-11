import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RuntimePoolCreateAgentSchema } from "../types";
import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar } from "./utils";

export const registerRuntimePoolCreateAgentTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-pool-create-agent",
    {
      title: "Runtime Pool Create Agent",
      description:
        "Create an offline agent bound to a pool. An existing lead prevents creation of another lead.",
      annotations: { openWorldHint: false },
      inputSchema: RuntimePoolCreateAgentSchema.extend({ poolId: z.string().min(1) }),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (args, requestInfo) => {
      const { poolId: _, ...body } = args;
      return proxyRuntimePoolsApi({
        method: "POST",
        path: `/api/runtime-pools/${encodeURIComponent(args.poolId)}/agents`,
        body: body,
        requestInfo,
        message: "Offline pool agent created.",
      });
    },
  );
};
