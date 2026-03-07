import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflowRuns } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerListWorkflowRunsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflow-runs",
    {
      title: "List Workflow Runs",
      annotations: { destructiveHint: false },
      description: "List all execution runs for a given workflow.",
      inputSchema: z.object({
        workflowId: z.string().uuid().describe("Workflow ID to list runs for"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        runs: z.array(z.unknown()),
      }),
    },
    async ({ workflowId }) => {
      try {
        const runs = listWorkflowRuns(workflowId);
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
