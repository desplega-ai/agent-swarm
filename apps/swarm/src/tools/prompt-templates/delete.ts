import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deletePromptTemplate, getPromptTemplateById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeletePromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-prompt-template",
    {
      title: "Delete Prompt Template",
      description:
        "Delete a prompt template override by ID. Cannot delete default templates — use reset instead. Use list-prompt-templates to find template IDs first.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        id: z.string().describe("The prompt template ID to delete."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
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
        const existing = getPromptTemplateById(id);
        if (!existing) {
          return {
            content: [{ type: "text", text: `Prompt template "${id}" not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Prompt template "${id}" not found.`,
            },
          };
        }

        const deleted = deletePromptTemplate(id);
        if (!deleted) {
          return {
            content: [{ type: "text", text: `Failed to delete prompt template "${id}".` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Failed to delete prompt template "${id}".`,
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Prompt template "${existing.eventType}" (scope: ${existing.scope}${existing.scopeId ? `, scopeId: ${existing.scopeId}` : ""}) deleted successfully.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Prompt template "${existing.eventType}" deleted successfully.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete prompt template: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete prompt template: ${message}`,
          },
        };
      }
    },
  );
};
