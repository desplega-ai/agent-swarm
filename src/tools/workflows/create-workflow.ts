import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { WorkflowDefinitionSchema } from "@/types";

export const registerCreateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-workflow",
    {
      title: "Create Workflow",
      annotations: { destructiveHint: false },
      description:
        "Create a new automation workflow with a trigger → condition → action DAG definition.",
      inputSchema: z.object({
        name: z.string().describe("Unique name for the workflow"),
        description: z.string().optional().describe("Description of what this workflow does"),
        definition: WorkflowDefinitionSchema.describe(
          "The workflow DAG definition with nodes and edges",
        ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
      }),
    },
    async ({ name, description, definition }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text" as const, text: "Agent ID required." }],
          structuredContent: { success: false, message: "Agent ID required." },
        };
      }
      try {
        const workflow = createWorkflow({
          name,
          description,
          definition,
          createdByAgentId: requestInfo.agentId,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Created workflow "${workflow.name}" (${workflow.id}).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created workflow "${workflow.name}".`,
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
