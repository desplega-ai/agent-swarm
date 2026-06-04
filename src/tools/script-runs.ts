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

export const registerScriptRunsTools = (server: McpServer) => {
  const register = createToolRegistrar(server);

  register(
    "launch-script-run",
    {
      title: "Launch Script Run",
      description: LAUNCH_SCRIPT_RUN_DESCRIPTION,
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        source: z.string().min(1).describe("TypeScript script workflow source."),
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
      });
    },
  );
};
