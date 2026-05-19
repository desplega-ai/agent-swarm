import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import {
  proxyScriptsApi,
  scriptNameSchema,
  scriptScopeSchema,
  scriptToolOutputSchema,
} from "./script-common";

export const SCRIPT_DELETE_DESCRIPTION =
  "Remove a swarm-shared script from the catalog. Versions table preserves history.";

export const registerScriptDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-delete",
    {
      title: "Script Delete",
      description: SCRIPT_DELETE_DESCRIPTION,
      annotations: { destructiveHint: true, openWorldHint: false },
      inputSchema: z.object({
        name: scriptNameSchema.describe("Script name to delete."),
        scope: scriptScopeSchema.default("agent").describe("Script scope to delete from."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async ({ name, scope }, requestInfo) =>
      proxyScriptsApi({
        method: "DELETE",
        path: `/api/scripts/${encodeURIComponent(name)}?scope=${encodeURIComponent(scope)}`,
        requestInfo,
        successMessage: () => "Script delete completed.",
      }),
  );
};
