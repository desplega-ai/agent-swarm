import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { generateEdges } from "@/workflows/definition";

export const registerGetWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-workflow",
    {
      title: "Get Workflow",
      annotations: { destructiveHint: false },
      description:
        "Get a workflow by ID, including its definition, triggers, cooldown, input, and auto-generated edges for UI rendering.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID"),
      }),
      outputSchema: swarmToolOutputSchema({
        workflow: z.unknown().optional(),
        edges: z.array(z.unknown()).optional(),
      }),
    },
    async ({ id }) => {
      try {
        const workflow = getWorkflow(id);
        if (!workflow) {
          return toolErr(`Workflow not found: ${id}`);
        }
        // Auto-generate edges for UI rendering
        const edges = generateEdges(workflow.definition);
        return toolOk(`Workflow "${workflow.name}" (${id}).`, {
          // The definition must reach the text channel — most harnesses never
          // show the model structuredContent.
          details: JSON.stringify(workflow, null, 2),
          data: { workflow, edges },
        });
      } catch (err) {
        return toolErr(String(err));
      }
    },
  );
};
