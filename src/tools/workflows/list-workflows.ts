import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflows } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AssetKeySchema, WorkflowRunStatusSchema } from "@/types";

export const registerListWorkflowsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflows",
    {
      title: "List Workflows",
      annotations: { destructiveHint: false },
      description:
        "List all automation workflows, optionally filtered by enabled status. Returns SLIM rows WITHOUT the full `definition` (DAG) — each row carries a `nodeCount` instead. To inspect or patch a workflow's nodes/triggers, call `get-workflow` by id, or pass `includeFull: true` here.",
      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Filter by enabled status (omit to return all)"),
        key: AssetKeySchema.optional().describe("Filter by exact namespace."),
        keyPrefix: AssetKeySchema.optional().describe("Filter by namespace subtree."),
        consecutiveErrorsMin: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Only return workflows with at least this many latest consecutive failed runs.",
          ),
        lastRunStatus: WorkflowRunStatusSchema.optional().describe(
          "Only return workflows whose latest run has this status.",
        ),
        includeFull: z
          .boolean()
          .optional()
          .describe(
            "Return the full workflow `definition` + trigger config instead of slim rows. Default false — prefer `get-workflow` to fetch a single workflow in full.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        workflows: z.array(z.unknown()).optional(),
      }),
    },
    async ({ enabled, key, keyPrefix, consecutiveErrorsMin, lastRunStatus, includeFull }) => {
      try {
        const filters = { enabled, key, keyPrefix, consecutiveErrorsMin, lastRunStatus };
        const workflows = includeFull
          ? await listWorkflows(filters)
          : await listWorkflows(filters, { slim: true });
        return toolOk(`Found ${workflows.length} workflow(s).`, { data: { workflows } });
      } catch (err) {
        return toolErr(String(err), { data: { workflows: [] } });
      }
    },
  );
};
