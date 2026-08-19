import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getPromptTemplateById, getPromptTemplateHistory } from "@/be/db";
import { getTemplateDefinition } from "@/prompts/registry";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const promptTemplateOutputShape = z.looseObject({
  id: z.string().optional(),
  eventType: z.string().optional(),
  scope: z.string().optional(),
  scopeId: z.string().nullable().optional(),
  state: z.string().optional(),
  body: z.string().optional(),
  isDefault: z.boolean().optional(),
  version: z.number().optional(),
  createdBy: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const promptTemplateHistoryOutputShape = z.looseObject({
  id: z.string().optional(),
  templateId: z.string().optional(),
  version: z.number().optional(),
  body: z.string().optional(),
  state: z.string().optional(),
  changedBy: z.string().nullable().optional(),
  changedAt: z.string().optional(),
  changeReason: z.string().nullable().optional(),
});

export const registerGetPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-prompt-template",
    {
      title: "Get Prompt Template",
      description:
        "Get a prompt template by ID, including its version history and the code-defined variable definitions for its event type.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        id: z.string().describe("The prompt template ID."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        template: promptTemplateOutputShape.optional(),
        history: z.array(promptTemplateHistoryOutputShape).optional(),
        variables: z
          .array(
            z.looseObject({
              name: z.string().optional(),
              description: z.string().optional(),
              example: z.string().optional(),
            }),
          )
          .optional(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      try {
        const template = await getPromptTemplateById(id);
        if (!template) {
          return toolErr(`Prompt template "${id}" not found.`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const history = await getPromptTemplateHistory(id);
        const definition = getTemplateDefinition(template.eventType);

        return toolOk(`Found template "${template.eventType}" at version ${template.version}.`, {
          details: `Template: ${template.eventType} (v${template.version}, ${template.state}, scope: ${template.scope})\n\nBody:\n${template.body}\n\nHistory: ${history.length} version(s)`,
          data: {
            yourAgentId: requestInfo.agentId,
            template,
            history,
            variables: definition?.variables,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to get prompt template: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
