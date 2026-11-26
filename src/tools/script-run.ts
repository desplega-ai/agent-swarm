import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import { getBridgedScriptRunId } from "@/utils/request-auth-context";
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

export function renderRunOutput(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as {
    result?: unknown;
    stdout?: string;
    durationMs?: number;
    truncated?: { stdout?: boolean; stderr?: boolean };
    autoSaved?: { slug?: string };
    kvSaved?: { namespace?: string; key?: string };
    object?: { stateVersion?: number };
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
  if (typeof body.object?.stateVersion === "number") {
    notes.push(`object.stateVersion: ${body.object.stateVersion}`);
  }
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
        object: z
          .object({ id: z.string().min(1).max(256), method: z.string().min(1).max(128) })
          .optional()
          .describe("Call this object ID and method on the named global DurableObject script."),
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
            "Run key. A successful run saves its output to kv script:executions/{key} (a re-run overwrites it). Every ctx.swarm call in the run also derives its own key from it, so a re-run under the same key (same agent, within 7 days) replays the first run's tool-bridge writes (task_send, slack_post, ...) and workflow_trigger calls instead of repeating them, and a nested script_run inherits a derived key. Reads and REST-routed writes (kv_*, schedule_*) run again.",
          ),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) => {
      // A background run's call: carry its id so the inline run joins its tree.
      const parentScriptRunId = getBridgedScriptRunId();
      return proxyScriptsApi({
        method: "POST",
        path: "/api/scripts/run",
        body: { ...args, ...(parentScriptRunId ? { parentScriptRunId } : {}) },
        requestInfo,
        successMessage: () => "Script run completed.",
        successDetails: renderRunOutput,
      });
    },
  );
};
