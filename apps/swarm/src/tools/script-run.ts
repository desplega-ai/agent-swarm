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

export const SCRIPT_RUN_DESCRIPTION =
  "Run a named swarm-shared script (callable across agents and from workflow `swarm-script` nodes), OR inline source (auto-saved as scratch to the catalog). Use for swarm-visible, durable scripts. For local-only throwaway TS, use code-mode `run`.";

export const registerScriptRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-run",
    {
      title: "Script Run",
      description: SCRIPT_RUN_DESCRIPTION,
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        name: scriptNameSchema.optional().describe("Name of a reusable script to run."),
        source: z.string().min(1).optional().describe("Inline TypeScript source to run."),
        args: z.unknown().optional().describe("JSON-serializable script arguments."),
        intent: z.string().default("").describe("Why this script is being run."),
        scope: scriptScopeSchema.optional().describe("Optional scope for named script resolution."),
        fsMode: scriptFsModeSchema
          .default("none")
          .describe("Filesystem mode. v1 supports none only."),
        idempotencyKey: z
          .string()
          .max(200)
          .optional()
          .describe(
            "When set, output is auto-persisted to kv under script:executions/{key}. Re-running with the same key overwrites. Queryable via kv-get.",
          ),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/run",
        body: args,
        requestInfo,
        successMessage: () => "Script run completed.",
      }),
  );
};
