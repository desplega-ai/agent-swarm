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
  "Run a named swarm-shared script (callable across agents and from workflow `swarm-script` nodes), OR inline source (auto-saved as scratch to the catalog). Inline source executes without the `script-upsert` compile-time typecheck. Use for swarm-visible, durable scripts. For local-only throwaway TS, use code-mode `run`.";

function renderRunOutput(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as {
    result?: unknown;
    stdout?: string;
    durationMs?: number;
    truncated?: { stdout?: boolean; stderr?: boolean };
    autoSaved?: { slug?: string };
    kvSaved?: { namespace?: string; key?: string };
  };
  const parts: string[] = [];
  if (body.result !== undefined) {
    parts.push(
      `result:\n${typeof body.result === "string" ? body.result : JSON.stringify(body.result, null, 2)}`,
    );
  }
  if (typeof body.stdout === "string" && body.stdout.trim()) {
    parts.push(`stdout:\n${body.stdout.trim()}`);
  }
  const notes: string[] = [];
  if (typeof body.durationMs === "number") notes.push(`${body.durationMs}ms`);
  if (body.truncated?.stdout || body.truncated?.stderr) {
    notes.push("output truncated by the runtime");
  }
  if (body.autoSaved?.slug) notes.push(`auto-saved as scratch script \`${body.autoSaved.slug}\``);
  if (body.kvSaved?.key) {
    notes.push(`output persisted to kv ${body.kvSaved.namespace}/${body.kvSaved.key}`);
  }
  if (notes.length > 0) parts.push(`(${notes.join("; ")})`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const registerScriptRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-run",
    {
      title: "Script Run",
      description: SCRIPT_RUN_DESCRIPTION,
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        name: scriptNameSchema.optional().describe("Name of a reusable script to run."),
        source: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Inline TypeScript source to run without a compile-time typecheck. Must `export default async function (args, ctx)` — args FIRST, ctx second. Import `ScriptContext` from "swarm-sdk" for promotion-safe typing.',
          ),
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
        successDetails: renderRunOutput,
      }),
  );
};
