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
  'Typecheck and persist a TypeScript script to the swarm catalog under your agent scope (or global if you\'re a lead). Import `ScriptContext` from "swarm-sdk" for a real context type. Other agents and workflow nodes will be able to find and run it. For local-only scripts, use code-mode `save`.';

export const registerScriptUpsertTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-upsert",
    {
      title: "Script Upsert",
      description: SCRIPT_UPSERT_DESCRIPTION,
      annotations: { openWorldHint: false },
      inputSchema: z.object({
        name: scriptNameSchema.describe("Stable script name within the selected scope."),
        source: z
          .string()
          .min(1)
          .describe(
            'TypeScript source, typechecked before saving. Must `export default async function (args, ctx)` — args FIRST, ctx second. Import `ScriptContext` from "swarm-sdk" to type `ctx`.',
          ),
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
        successMessage: (data) => {
          const body = (data ?? {}) as {
            name?: unknown;
            version?: unknown;
            contentDeduped?: unknown;
          };
          const name = typeof body.name === "string" ? body.name : args.name;
          const version = typeof body.version === "number" ? ` v${body.version}` : "";
          const deduped = body.contentDeduped ? " (content unchanged — deduped)" : "";
          return `Script \`${name}\`${version} saved.${deduped}`;
        },
      }),
  );
};
