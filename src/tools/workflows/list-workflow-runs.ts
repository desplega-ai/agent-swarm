import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflowRuns } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { WorkflowRunStatusSchema } from "@/types";

function renderRuns(runs: ReturnType<typeof listWorkflowRuns>): string | undefined {
  if (runs.length === 0) return undefined;
  return runs
    .map((run) => {
      const error = (run as { error?: unknown }).error;
      const errorSuffix = typeof error === "string" && error ? ` — error: ${error}` : "";
      return `- ${run.id} [${run.workflowId}]: ${run.status}${errorSuffix}`;
    })
    .join("\n");
}

export const registerListWorkflowRunsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflow-runs",
    {
      title: "List Workflow Runs",
      annotations: { destructiveHint: false },
      description: "List all execution runs for a given workflow, optionally filtered by status.",
      inputSchema: z.object({
        workflowId: z.string().uuid().describe("Workflow ID to list runs for"),
        status: WorkflowRunStatusSchema.optional().describe(
          "Filter by run status (running, waiting, completed, failed, skipped)",
        ),
      }),
      outputSchema: swarmToolOutputSchema({
        runs: z.array(z.unknown()).optional(),
      }),
    },
    async ({ workflowId, status }) => {
      try {
        let runs = listWorkflowRuns(workflowId);
        if (status) {
          runs = runs.filter((r) => r.status === status);
        }
        return toolOk(`Found ${runs.length} run(s).`, {
          details: renderRuns(runs),
          data: { runs },
        });
      } catch (err) {
        return toolErr(String(err), { data: { runs: [] } });
      }
    },
  );
};
