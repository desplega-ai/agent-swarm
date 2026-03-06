import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { updateWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { WorkflowDefinitionSchema } from "@/types";

export const registerUpdateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-workflow",
    {
      title: "Update Workflow",
      annotations: { destructiveHint: false },
      description: "Update an existing workflow's name, description, definition, or enabled state.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to update"),
        name: z.string().optional().describe("New name for the workflow"),
        description: z.string().optional().describe("New description"),
        definition: WorkflowDefinitionSchema.optional().describe("New DAG definition"),
        enabled: z.boolean().optional().describe("Enable or disable the workflow"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
      }),
    },
    async ({ id, name, description, definition, enabled }) => {
      try {
        const workflow = updateWorkflow(id, { name, description, definition, enabled });
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        return {
          content: [
            { type: "text" as const, text: `Updated workflow "${workflow.name}" (${id}).` },
          ],
          structuredContent: {
            success: true,
            message: `Updated workflow "${workflow.name}".`,
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
