import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import {
  proxyScriptsApi,
  scriptNameSchema,
  scriptScopeSchema,
  scriptToolOutputSchema,
} from "./script-common";

export const SCRIPT_QUERY_TYPES_DESCRIPTION =
  "Fetch the signature + the auto-generated `swarm-sdk.d.ts` (derived from the live MCP tool registry) + the `stdlib.d.ts` blobs — for IDE-style introspection before authoring or running a script. The same types are used by `script-upsert`'s typecheck pass, so they are authoritative.";

export const registerScriptQueryTypesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-query-types",
    {
      title: "Script Query Types",
      description: SCRIPT_QUERY_TYPES_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        name: scriptNameSchema.describe("Script name whose signature should be fetched."),
        scope: scriptScopeSchema.optional().describe("Optional scope for script resolution."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async ({ name, scope }, requestInfo) => {
      const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      return proxyScriptsApi({
        method: "GET",
        path: `/api/scripts/${encodeURIComponent(name)}/types${query}`,
        requestInfo,
        successMessage: () => "Script type query completed.",
      });
    },
  );
};
