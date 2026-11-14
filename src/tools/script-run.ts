import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
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
 * JSON with only the top levels indented. `JSON.stringify(v, null, 2)`
 * indents every level, so an array of row objects pays a newline plus up to
 * a dozen spaces per field; that whitespace alone pushes many script results
 * past the wire limit. Here a root array puts one item per line, and a root
 * object puts one field per line with one more level expanded, so
 * `{ rows: [...] }` also shows one row per line. Deeper values render inline
 * with `": "` / `", "` separators. Parsing it gives back the identical value.
 */
function renderLayeredJson(
  value: unknown,
  levels = Array.isArray(value) ? 1 : 2,
  depth = 0,
): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const isArray = Array.isArray(value);
  const entries: Array<[string | undefined, unknown]> = isArray
    ? value.map((item) => [undefined, item === undefined ? null : item])
    : Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function");
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return `${open}${close}`;
  const render = ([key, item]: [string | undefined, unknown]) =>
    `${key === undefined ? "" : `${JSON.stringify(key)}: `}${renderLayeredJson(item, levels - 1, depth + 1)}`;
  if (levels <= 0) return `${open}${entries.map(render).join(", ")}${close}`;
  const indent = "  ".repeat(depth + 1);
  const body = entries.map((entry) => `${indent}${render(entry)}`).join(",\n");
  return `${open}\n${body}\n${"  ".repeat(depth)}${close}`;
}

/**
 * Text-channel rendering of a run. `layered` (agent-facing calls) renders an
 * object result with `renderLayeredJson`; script and extension callers keep
 * the fully indented shape byte for byte.
 */
function renderRunOutput(data: unknown, layered = false): string | undefined {
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
      `result:\n${typeof body.result === "string" ? body.result : layered ? renderLayeredJson(body.result) : JSON.stringify(body.result, null, 2)}`,
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
      // Script and extension calls never reach a model context, so they keep the exact shape.
      const origin = requestInfo.callOrigin;
      const agentFacing = origin !== "script-sdk" && origin !== "extension";
      return proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/run",
        body: args,
        requestInfo,
        successMessage: () => "Script run completed.",
        successDetails: (data) => renderRunOutput(data, agentFacing),
      });
    },
  );
};
