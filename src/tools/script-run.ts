import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createToolRegistrar,
  MCP_RESULT_WIRE_LIMIT_BYTES,
  type SwarmToolResult,
  swarmToolResultBytes,
} from "@/tools/utils";
import {
  proxyScriptsApi,
  scriptExecutorSchema,
  scriptFsModeSchema,
  scriptNameSchema,
  scriptScopeSchema,
  scriptToolOutputSchema,
} from "./script-common";

export const SCRIPT_RUN_DESCRIPTION =
  "Run a named swarm-shared script (callable across agents and from workflow `swarm-script` nodes), OR inline source (auto-saved as scratch to the catalog). Inline source executes without the `script-upsert` compile-time typecheck. Use for swarm-visible, durable scripts. For local-only throwaway TS, use code-mode `run`. The run ends when the script's default export resolves: a call it did not await gets 2 s more, then is stopped (native) or aborted at once (quickjs), so await every write that must land. A `Promise.race` deadline therefore bounds the run; a nested `script_run` that lost the race keeps running on the server under its own wall.";

/**
 * Text-channel rendering of a successful run. `compact` renders an object
 * result as single-line JSON: the same value without indentation.
 */
function renderRunOutput(data: unknown, compact = false): string | undefined {
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
      `result:\n${
        typeof body.result === "string"
          ? body.result
          : compact
            ? JSON.stringify(body.result)
            : JSON.stringify(body.result, null, 2)
      }`,
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

/**
 * Agent-facing success shape. Each harness reads one channel: `data` already
 * carries the full run body (result, stdout, stderr, exitCode, autoSaved,
 * kvSaved) on the structured channel, and `details` renders the same fields
 * for the text channel, so the structured channel skips that duplicate.
 * The result stays pretty-printed while it fits the wire limit; when only the
 * single-line rendering fits, that one goes out instead of a spill.
 */
function fitAgentRunResult(result: SwarmToolResult): SwarmToolResult {
  const pretty: SwarmToolResult = { ...result, omitStructuredDetails: true };
  if (swarmToolResultBytes(pretty) <= MCP_RESULT_WIRE_LIMIT_BYTES) return pretty;
  const body = (result.data as { data?: unknown } | undefined)?.data;
  const compactDetails = renderRunOutput(body, true);
  if (compactDetails === undefined || compactDetails === result.details) return pretty;
  const compact: SwarmToolResult = { ...pretty, details: compactDetails };
  return swarmToolResultBytes(compact) <= MCP_RESULT_WIRE_LIMIT_BYTES ? compact : pretty;
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
        executor: scriptExecutorSchema
          .nullable()
          .optional()
          .describe(
            'Optional executor override ("native" or "quickjs"). When omitted, named scripts use their saved executor or SCRIPT_EXECUTOR.',
          ),
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
    async (args, requestInfo) => {
      const result = await proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/run",
        body: args,
        requestInfo,
        successMessage: () => "Script run completed.",
        successDetails: (data) => renderRunOutput(data),
      });
      // Script and extension calls never reach a model context, so they keep
      // the exact current shape.
      const scriptInternal =
        requestInfo.callOrigin === "script-sdk" || requestInfo.callOrigin === "extension";
      if (scriptInternal || !result.ok || !result.data) return result;
      return fitAgentRunResult(result);
    },
  );
};
