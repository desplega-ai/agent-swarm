import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflowRuns } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { WorkflowRunStatusSchema } from "@/types";

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
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        runs: z.array(z.unknown()),
      }),
    },
    async ({ workflowId, status }) => {
      try {
        let runs = listWorkflowRuns(workflowId);
        if (status) {
          runs = runs.filter((r) => r.status === status);
        }
        return {
          content: [{ type: "text" as const, text: `Found ${runs.length} run(s).` }],
          structuredContent: {
            success: true,
            message: `Found ${runs.length} run(s).`,
            runs,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err), runs: [] },
        };
      }
    },
  );
};
