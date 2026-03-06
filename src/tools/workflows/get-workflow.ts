import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerGetWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-workflow",
    {
      title: "Get Workflow",
      annotations: { destructiveHint: false },
      description: "Get a workflow by ID, including its full DAG definition.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
      }),
    },
    async ({ id }) => {
      try {
        const workflow = getWorkflow(id);
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Workflow "${workflow.name}" (${id}).` }],
          structuredContent: {
            success: true,
            message: `Workflow "${workflow.name}".`,
            workflow,
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
