import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { cancelWorkflowRun } from "@/workflows";

export const registerCancelWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "cancel-workflow-run",
    {
      title: "Cancel Workflow Run",
      annotations: { destructiveHint: true },
      description:
        "Cancel a running or waiting workflow run and every child run below it. Cancels their non-terminal steps, tasks, pending approvals and queued retries in one transaction; finished child runs keep their status. Repeating the cancel on a cancelled run finishes any child runs still open.",
      inputSchema: z.object({
        runId: z.string().uuid().describe("Workflow run ID to cancel"),
        reason: z.string().optional().describe("Optional reason for cancellation"),
      }),
      outputSchema: swarmToolOutputSchema(),
    },
    async ({ runId, reason }) => {
      try {
        await cancelWorkflowRun(runId, reason);
        return toolOk(`Cancelled workflow run ${runId}.`);
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
