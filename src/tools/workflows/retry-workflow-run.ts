import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
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
      outputSchema: swarmToolOutputSchema(),
    },
    async ({ runId }) => {
      try {
        await retryFailedRun(runId, getExecutorRegistry());
        return toolOk(`Retrying workflow run ${runId}.`);
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
