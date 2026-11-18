import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflowRunSummary } from "@/be/db/workflow-runs";
import { denyCatalog } from "@/tools/catalog-auth";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getExecutorRegistry, retryFailedRun } from "@/workflows";

export const registerRetryWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "retry-workflow-run",
    {
      title: "Retry Workflow Run",
      annotations: { destructiveHint: false },
      description:
        "Resume the same failed workflow run from its failed step(s); completed steps are not re-run. Retrying re-creates the failed node's side effects (e.g. an agent task), so check the target state first if that work was already done manually. Retries on the definition the run started with; to use an edited workflow, trigger a new run.",
      inputSchema: z.object({
        runId: z.string().uuid().describe("Workflow run ID to retry"),
      }),
      outputSchema: swarmToolOutputSchema(),
    },
    async ({ runId }, requestInfo) => {
      const denied = await denyCatalog(
        requestInfo,
        "workflow.run.any",
        "Running workflows requires the lead agent, operator, or user authentication.",
      );
      if (denied) return denied;
      try {
        if (!(await getWorkflowRunSummary(runId)))
          return toolErr(`Workflow run not found: ${runId}`);
        await retryFailedRun(runId, getExecutorRegistry());
        return toolOk(`Retrying workflow run ${runId}.`);
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
