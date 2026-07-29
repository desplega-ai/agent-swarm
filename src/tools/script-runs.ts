import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import { ScriptRunStatusSchema } from "@/types";
import { proxyScriptsApi, scriptNameSchema, scriptToolOutputSchema } from "./script-common";

export const LAUNCH_SCRIPT_RUN_DESCRIPTION =
  "Launch a durable one-off script workflow run. The run executes in the background and can be inspected with get-script-run for terminal status and journal entries.";

export const GET_SCRIPT_RUN_DESCRIPTION =
  "Get a durable script workflow run by ID, including its journal entries for swarm-script, raw-llm, and agent-task steps.";

export const LIST_SCRIPT_RUNS_DESCRIPTION =
  "List durable script workflow runs, optionally filtered by status or agent ID.";

const JOURNAL_RENDER_LIMIT = 20;
const JOURNAL_VALUE_CAP = 400;

function journalValuePreview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) return undefined;
  return serialized.length > JOURNAL_VALUE_CAP
    ? `${serialized.slice(0, JOURNAL_VALUE_CAP)}…`
    : serialized;
}

function renderRunDetail(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const run = (data as { run?: Record<string, unknown> }).run;
  if (!run) return undefined;
  const lines: string[] = [];
  if (typeof run.status === "string") lines.push(`status: ${run.status}`);
  if (typeof run.error === "string" && run.error) lines.push(`error: ${run.error}`);
  if (run.output !== undefined && run.output !== null) {
    lines.push(`output: ${JSON.stringify(run.output)}`);
  }
  // Journal entries must reach the text channel — most harnesses never show
  // the model structuredContent, and a bare count hides step outcomes.
  const journal = (data as { journal?: unknown[] }).journal;
  if (Array.isArray(journal) && journal.length > 0) {
    lines.push(`journal (${journal.length} entr${journal.length === 1 ? "y" : "ies"}):`);
    for (const raw of journal.slice(0, JOURNAL_RENDER_LIMIT)) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const key = String(entry.stepKey ?? entry.label ?? entry.id ?? "?");
      const kind = typeof entry.stepType === "string" ? ` [${entry.stepType}]` : "";
      const status = typeof entry.status === "string" ? ` ${entry.status}` : "";
      const error =
        typeof entry.error === "string" && entry.error ? ` — error: ${entry.error}` : "";
      const output = error ? undefined : journalValuePreview(entry.output ?? entry.result);
      lines.push(`- ${key}${kind}:${status}${error}${output ? ` — ${output}` : ""}`);
    }
    if (journal.length > JOURNAL_RENDER_LIMIT) {
      lines.push(
        `… +${journal.length - JOURNAL_RENDER_LIMIT} more entries (see structuredContent.data.journal)`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderRunsList(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const runs = (data as { runs?: unknown[] }).runs;
  if (!Array.isArray(runs) || runs.length === 0) return undefined;
  return runs
    .map((entry) => {
      const run = entry as Record<string, unknown>;
      const name = typeof run.scriptName === "string" && run.scriptName ? ` ${run.scriptName}` : "";
      const error = typeof run.error === "string" && run.error ? ` — ${run.error}` : "";
      return `- ${String(run.id ?? "?")}${name}: ${String(run.status ?? "unknown")}${error}`;
    })
    .join("\n");
}

export const registerScriptRunsTools = (server: McpServer) => {
  const register = createToolRegistrar(server);

  register(
    "launch-script-run",
    {
      title: "Launch Script Run",
      description: LAUNCH_SCRIPT_RUN_DESCRIPTION,
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        source: z
          .string()
          .min(1)
          .describe(
            "TypeScript script workflow source. Must `export default async function (args, ctx)` — args FIRST, ctx second.",
          ),
        args: z.unknown().optional().describe("JSON-serializable workflow arguments."),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional key that returns the existing run instead of launching a duplicate."),
        scriptName: scriptNameSchema
          .optional()
          .describe("Optional human-readable script/workflow name for the run."),
        requestedByUserId: z
          .string()
          .optional()
          .describe("Optional canonical user ID to attribute the run to."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyScriptsApi({
        method: "POST",
        path: "/api/script-runs",
        body: { ...args, background: true },
        requestInfo,
        successMessage: (data) => {
          const id =
            typeof data === "object" && data !== null && "id" in data
              ? String((data as { id: unknown }).id)
              : "unknown";
          return `Script run launched: ${id}.`;
        },
      }),
  );

  register(
    "get-script-run",
    {
      title: "Get Script Run",
      description: GET_SCRIPT_RUN_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().uuid().describe("Script run ID."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async ({ id }, requestInfo) =>
      proxyScriptsApi({
        method: "GET",
        path: `/api/script-runs/${encodeURIComponent(id)}`,
        requestInfo,
        successMessage: (data) => {
          const status =
            typeof data === "object" &&
            data !== null &&
            "run" in data &&
            typeof (data as { run?: { status?: unknown } }).run?.status === "string"
              ? (data as { run: { status: string } }).run.status
              : "unknown";
          return `Script run ${id} status: ${status}.`;
        },
        successDetails: renderRunDetail,
        failureDetails: renderRunDetail,
      }),
  );

  register(
    "list-script-runs",
    {
      title: "List Script Runs",
      description: LIST_SCRIPT_RUNS_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        status: ScriptRunStatusSchema.optional().describe("Optional script run status filter."),
        agentId: z.string().optional().describe("Optional agent ID filter."),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum runs to return."),
        offset: z.number().int().min(0).default(0).describe("Pagination offset."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async ({ status, agentId, limit, offset }, requestInfo) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (agentId) params.set("agentId", agentId);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      return proxyScriptsApi({
        method: "GET",
        path: `/api/script-runs?${params.toString()}`,
        requestInfo,
        successMessage: (data) => {
          const total =
            typeof data === "object" && data !== null && "total" in data
              ? Number((data as { total: unknown }).total)
              : 0;
          return `Found ${Number.isFinite(total) ? total : 0} script run(s).`;
        },
        successDetails: renderRunsList,
      });
    },
  );
};
