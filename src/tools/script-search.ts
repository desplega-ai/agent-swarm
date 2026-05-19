import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import { proxyScriptsApi, scriptScopeSchema, scriptToolOutputSchema } from "./script-common";

export const SCRIPT_SEARCH_DESCRIPTION =
  "Semantic search over swarm-shared TypeScript scripts (catalog persisted in the agent-swarm DB; callable from agents and workflows). For ephemeral throwaway TS on your local machine, use code-mode instead.";

export const registerScriptSearchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-search",
    {
      title: "Script Search",
      description: SCRIPT_SEARCH_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        query: z.string().default("").describe("Search query for reusable scripts."),
        scope: scriptScopeSchema.optional().describe("Optional script scope filter."),
        limit: z.number().int().min(1).max(100).default(10).describe("Maximum results."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/search",
        body: args,
        requestInfo,
        successMessage: () => "Script search completed.",
      }),
  );
};
