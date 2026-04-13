import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar } from "@/tools/utils";
import { getExecutorRegistry, retryFailedRun } from "@/workflows";

export const registerRetryWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "retry-workflow-run",
    {
      title: "Retry Workflow Run",
      annotations: { destructiveHint: false },
      description:
        "Retry a failed workflow run from the beginning. The run must be in 'failed' status.",
      inputSchema: z.object({
        runId: z.string().uuid().describe("Workflow run ID to retry"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ runId }) => {
      try {
        await retryFailedRun(runId, getExecutorRegistry());
        return {
          content: [{ type: "text" as const, text: `Retrying workflow run ${runId}.` }],
          structuredContent: {
            success: true,
            message: `Retrying workflow run ${runId}.`,
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
