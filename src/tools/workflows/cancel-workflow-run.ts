import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar } from "@/tools/utils";
import { cancelWorkflowRun } from "@/workflows";

export const registerCancelWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "cancel-workflow-run",
    {
      title: "Cancel Workflow Run",
      annotations: { destructiveHint: true },
      description:
        "Cancel a running or waiting workflow run. Cancels all non-terminal steps and their associated tasks.",
      inputSchema: z.object({
        runId: z.string().uuid().describe("Workflow run ID to cancel"),
        reason: z.string().optional().describe("Optional reason for cancellation"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ runId, reason }) => {
      try {
        cancelWorkflowRun(runId, reason);
        return {
          content: [{ type: "text" as const, text: `Cancelled workflow run ${runId}.` }],
          structuredContent: {
            success: true,
            message: `Cancelled workflow run ${runId}.`,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err) },
        };
      }
    },
  );
};
