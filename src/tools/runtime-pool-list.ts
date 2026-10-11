import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar } from "./utils";

export const registerRuntimePoolListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-pool-list",
    {
      title: "Runtime Pool List",
      description: "List runtime pools and their configuration.",
      annotations: { openWorldHint: false, readOnlyHint: true },
      inputSchema: z.object({}).strict(),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (_args, requestInfo) => {
      return proxyRuntimePoolsApi({
        method: "GET",
        path: "/api/runtime-pools",
        body: undefined,
        requestInfo,
        message: "Runtime pools listed.",
      });
    },
  );
};
