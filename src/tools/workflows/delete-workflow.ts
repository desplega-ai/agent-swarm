import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteWorkflow } from "@/be/db";
import { denyCatalog } from "@/tools/catalog-auth";
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
    async ({ id }, requestInfo) => {
      const denied = await denyCatalog(
        requestInfo,
        "workflow.write.any",
        "Changing workflows requires the lead agent, operator, or user authentication.",
      );
      if (denied) return denied;
      try {
        const deleted = await deleteWorkflow(id, "mcp");
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
