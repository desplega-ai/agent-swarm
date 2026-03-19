import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import {
  CooldownConfigSchema,
  InputValueSchema,
  TriggerConfigSchema,
  WorkflowDefinitionSchema,
} from "@/types";
import { validateDefinition } from "@/workflows/definition";

export const registerCreateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-workflow",
    {
      title: "Create Workflow",
      annotations: { destructiveHint: false },
      description:
        "Create a new automation workflow with a nodes-with-next definition, optional triggers, cooldown, and input.",
      inputSchema: z.object({
        name: z.string().describe("Unique name for the workflow"),
        description: z.string().optional().describe("Description of what this workflow does"),
        definition: WorkflowDefinitionSchema.describe(
          "The workflow definition with nodes (each node has id, type, config, and optional next/retry/validation)",
        ),
        triggers: z
          .array(TriggerConfigSchema)
          .optional()
          .describe("Optional trigger configurations (webhook, schedule)"),
        cooldown: CooldownConfigSchema.optional().describe(
          "Optional cooldown configuration to prevent re-triggering too frequently",
        ),
        input: z
          .record(z.string(), InputValueSchema)
          .optional()
          .describe(
            "Optional input values resolved at execution time (env vars like VAR_NAME, secrets secret.NAME, or literals)",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
      }),
    },
    async ({ name, description, definition, triggers, cooldown, input }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text" as const, text: "Agent ID required." }],
          structuredContent: { success: false, message: "Agent ID required." },
        };
      }
      try {
        // Validate definition structure
        const validation = validateDefinition(definition);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid definition: ${validation.errors.join("; ")}`,
              },
            ],
            structuredContent: {
              success: false,
              message: `Invalid definition: ${validation.errors.join("; ")}`,
            },
          };
        }

        const workflow = createWorkflow({
          name,
          description,
          definition,
          triggers,
          cooldown,
          input,
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
