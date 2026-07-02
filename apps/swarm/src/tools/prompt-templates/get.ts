import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getPromptTemplateById, getPromptTemplateHistory } from "@/be/db";
import { getTemplateDefinition } from "@/prompts/registry";
import { createToolRegistrar } from "@/tools/utils";
import { PromptTemplateHistorySchema, PromptTemplateSchema } from "@/types";

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
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        template: PromptTemplateSchema.optional(),
        history: z.array(PromptTemplateHistorySchema).optional(),
        variables: z
          .array(
            z.object({ name: z.string(), description: z.string(), example: z.string().optional() }),
          )
          .optional(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      try {
        const template = getPromptTemplateById(id);
        if (!template) {
          return {
            content: [{ type: "text", text: `Prompt template "${id}" not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Prompt template "${id}" not found.`,
            },
          };
        }

        const history = getPromptTemplateHistory(id);
        const definition = getTemplateDefinition(template.eventType);

        return {
          content: [
            {
              type: "text",
              text: `Template: ${template.eventType} (v${template.version}, ${template.state}, scope: ${template.scope})\n\nBody:\n${template.body}\n\nHistory: ${history.length} version(s)`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found template "${template.eventType}" at version ${template.version}.`,
            template,
            history,
            variables: definition?.variables,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to get prompt template: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to get prompt template: ${message}`,
          },
        };
      }
    },
  );
};
