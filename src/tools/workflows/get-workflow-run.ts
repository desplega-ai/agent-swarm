import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflowRun, getWorkflowRunStepsByRunId } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function renderSteps(steps: ReturnType<typeof getWorkflowRunStepsByRunId>): string | undefined {
  if (steps.length === 0) return undefined;
  return steps
    .map((step) => {
      const nodeId = (step as { nodeId?: unknown }).nodeId ?? "?";
      const status = (step as { status?: unknown }).status ?? "?";
      const error = (step as { error?: unknown }).error;
      const errorSuffix = typeof error === "string" && error ? ` — error: ${error}` : "";
      return `- ${String(nodeId)}: ${String(status)}${errorSuffix}`;
    })
    .join("\n");
}

export const registerGetWorkflowRunTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-workflow-run",
    {
      title: "Get Workflow Run",
      annotations: { destructiveHint: false },
      description: "Get details of a workflow run by ID, including all steps and their statuses.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow run ID"),
      }),
      outputSchema: swarmToolOutputSchema({
        run: z.unknown().optional(),
        steps: z.array(z.unknown()).optional(),
      }),
    },
    async ({ id }) => {
      try {
        const run = getWorkflowRun(id);
        if (!run) {
          return toolErr(`Workflow run not found: ${id}`, { data: { steps: [] } });
        }
        const steps = getWorkflowRunStepsByRunId(id);
        return toolOk(`Run ${id} status: ${run.status}.`, {
          details: renderSteps(steps),
          data: { run, steps },
        });
      } catch (err) {
        return toolErr(String(err), { data: { steps: [] } });
      }
    },
  );
};
