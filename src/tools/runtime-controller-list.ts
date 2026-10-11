import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar } from "./utils";

export const registerRuntimeControllerListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-controller-list",
    {
      title: "Runtime Controller List",
      description:
        "List runtime controllers. Responses contain secret key names and omit secret values.",
      annotations: { openWorldHint: false, readOnlyHint: true },
      inputSchema: z.object({}).strict(),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (_args, requestInfo) => {
      return proxyRuntimePoolsApi({
        method: "GET",
        path: "/api/runtime-controllers",
        body: undefined,
        requestInfo,
        message: "Runtime controllers listed.",
      });
    },
  );
};
