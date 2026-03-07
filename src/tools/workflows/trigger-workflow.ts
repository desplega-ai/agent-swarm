import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { startWorkflowExecution } from "@/workflows";

export const registerTriggerWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "trigger-workflow",
    {
      title: "Trigger Workflow",
      annotations: { destructiveHint: false },
      description:
        "Manually trigger a workflow execution, optionally passing trigger data as context.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to trigger"),
        triggerData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional data to pass as trigger context to the workflow"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        runId: z.string().optional(),
      }),
    },
    async ({ id, triggerData }) => {
      try {
        const workflow = getWorkflow(id);
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        if (!workflow.enabled) {
          return {
            content: [{ type: "text" as const, text: `Workflow "${workflow.name}" is disabled.` }],
            structuredContent: {
              success: false,
              message: `Workflow "${workflow.name}" is disabled.`,
            },
          };
        }
        const runId = await startWorkflowExecution(workflow, triggerData ?? {});
        return {
          content: [
            {
              type: "text" as const,
              text: `Triggered workflow "${workflow.name}" — run ID: ${runId}.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Triggered workflow "${workflow.name}".`,
            runId,
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
