import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import {
  proxyScriptsApi,
  scriptFsModeSchema,
  scriptNameSchema,
  scriptScopeSchema,
  scriptToolOutputSchema,
} from "./script-common";

export const SCRIPT_UPSERT_DESCRIPTION =
  "Persist a TypeScript script to the swarm catalog under your agent scope (or global if you're a lead). Other agents and workflow nodes will be able to find and run it. For local-only scripts, use code-mode `save`.";

export const registerScriptUpsertTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-upsert",
    {
      title: "Script Upsert",
      description: SCRIPT_UPSERT_DESCRIPTION,
      annotations: { openWorldHint: false },
      inputSchema: z.object({
        name: scriptNameSchema.describe("Stable script name within the selected scope."),
        source: z.string().min(1).describe("TypeScript source with a default export function."),
        description: z.string().default("").describe("Human-readable script description."),
        intent: z.string().default("").describe("Why this script exists."),
        scope: scriptScopeSchema.default("agent").describe("Persist under agent or global scope."),
        fsMode: scriptFsModeSchema
          .default("none")
          .describe("Filesystem mode. v1 supports none only."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/upsert",
        body: args,
        requestInfo,
        successMessage: () => "Script upsert completed.",
      }),
  );
};
