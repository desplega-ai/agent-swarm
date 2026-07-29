import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteWorkflow } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema(),
    },
    async ({ id }) => {
      try {
        const deleted = deleteWorkflow(id);
        if (!deleted) {
          return toolErr(`Workflow not found: ${id}`);
        }
        return toolOk(`Deleted workflow ${id}.`);
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
