import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-workflow",
    {
      title: "Delete Workflow",
      annotations: { destructiveHint: true },
      description: "Delete a workflow by ID. This also removes all associated runs and steps.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to delete"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ id }) => {
      try {
        const deleted = deleteWorkflow(id);
        if (!deleted) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Deleted workflow ${id}.` }],
          structuredContent: { success: true, message: `Deleted workflow ${id}.` },
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
