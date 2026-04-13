import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflow, updateWorkflow } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import {
  CooldownConfigSchema,
  InputValueSchema,
  TriggerConfigSchema,
  WorkflowDefinitionSchema,
} from "@/types";
import { validateDefinition } from "@/workflows/definition";
import { snapshotWorkflow } from "@/workflows/version";

export const registerUpdateWorkflowTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-workflow",
    {
      title: "Update Workflow",
      annotations: { destructiveHint: false },
      description:
        "Update an existing workflow's name, description, definition, triggers, cooldown, input, or enabled state. Creates a version snapshot before applying changes.",
      inputSchema: z.object({
        id: z.string().uuid().describe("Workflow ID to update"),
        name: z.string().optional().describe("New name for the workflow"),
        description: z.string().optional().describe("New description"),
        definition: WorkflowDefinitionSchema.optional().describe("New workflow definition"),
        triggers: z.array(TriggerConfigSchema).optional().describe("New trigger configurations"),
        cooldown: CooldownConfigSchema.optional()
          .nullable()
          .describe("New cooldown configuration (null to remove)"),
        input: z
          .record(z.string(), InputValueSchema)
          .optional()
          .nullable()
          .describe("New input values (null to remove)"),
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .nullable()
          .describe("Default working directory for all agent-task nodes (null to remove)"),
        vcsRepo: z
          .string()
          .min(1)
          .optional()
          .nullable()
          .describe("Default VCS repo for all agent-task nodes (null to remove)"),
        enabled: z.boolean().optional().describe("Enable or disable the workflow"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflow: z.unknown().optional(),
        versionCreated: z.number().optional(),
      }),
    },
    async (
      { id, name, description, definition, triggers, cooldown, input, dir, vcsRepo, enabled },
      requestInfo,
    ) => {
      try {
        // Check workflow exists
        const existing = getWorkflow(id);
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }

        // Validate new definition if provided
        if (definition) {
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
        }

        // Create version snapshot before applying update
        const version = snapshotWorkflow(id, requestInfo.agentId);

        const workflow = updateWorkflow(id, {
          name,
          description,
          definition,
          triggers,
          cooldown: cooldown === null ? null : cooldown,
          input: input === null ? null : input,
          dir: dir === null ? null : dir,
          vcsRepo: vcsRepo === null ? null : vcsRepo,
          enabled,
        });
        if (!workflow) {
          return {
            content: [{ type: "text" as const, text: `Workflow not found: ${id}` }],
            structuredContent: { success: false, message: `Workflow not found: ${id}` },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Updated workflow "${workflow.name}" (${id}). Version ${version.version} snapshot created.`,
            },
          ],
          structuredContent: {
            success: true,
            message: `Updated workflow "${workflow.name}".`,
            workflow,
            versionCreated: version.version,
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
