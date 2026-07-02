import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflowRun, getWorkflowRunStepsByRunId } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

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
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        run: z.unknown().optional(),
        steps: z.array(z.unknown()),
      }),
    },
    async ({ id }) => {
      try {
        const run = getWorkflowRun(id);
        if (!run) {
          return {
            content: [{ type: "text" as const, text: `Workflow run not found: ${id}` }],
            structuredContent: {
              success: false,
              message: `Workflow run not found: ${id}`,
              steps: [],
            },
          };
        }
        const steps = getWorkflowRunStepsByRunId(id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Run ${id} — status: ${run.status}, steps: ${steps.length}.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Run ${id} status: ${run.status}.`,
            run,
            steps,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err), steps: [] },
        };
      }
    },
  );
};
