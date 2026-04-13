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
        "Create a new automation workflow. Key concepts:\n" +
        "- Nodes are linked via 'next' (string or port-based record).\n" +
        "- CROSS-NODE DATA: To use output from an upstream node, you MUST declare an 'inputs' mapping on the downstream node. " +
        'Example: inputs: { "cityData": "generate-city" } → then use {{cityData.taskOutput.field}} in config templates. ' +
        "Without 'inputs', only 'trigger' and workflow-level 'input' are available for interpolation.\n" +
        "- STRUCTURED OUTPUT: For agent-task nodes, put outputSchema inside 'config' to validate the agent's raw JSON output. " +
        "Node-level outputSchema validates the executor's return ({taskId, taskOutput}), which is different.\n" +
        "- Agent-task config: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }.",
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
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .describe(
            "Default working directory for all agent-task nodes (absolute path, e.g. /tmp/workspace)",
          ),
        vcsRepo: z
          .string()
          .min(1)
          .optional()
          .describe("Default VCS repo for all agent-task nodes (e.g. org/repo)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
      }),
    },
    async (
      { name, description, definition, triggers, cooldown, input, dir, vcsRepo },
      requestInfo,
    ) => {
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
          dir,
          vcsRepo,
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
