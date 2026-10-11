import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar } from "./utils";

export const registerRuntimePoolDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-pool-delete",
    {
      title: "Runtime Pool Delete",
      description: "Delete a runtime pool. Set force to unbind its agents before deletion.",
      annotations: { openWorldHint: false },
      inputSchema: z.object({ poolId: z.string().min(1), force: z.boolean().optional() }).strict(),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (args, requestInfo) => {
      return proxyRuntimePoolsApi({
        method: "DELETE",
        path: `/api/runtime-pools/${encodeURIComponent(args.poolId)}${args.force ? "?force=true" : ""}`,
        body: undefined,
        requestInfo,
        message: "Runtime pool deleted.",
      });
    },
  );
};
