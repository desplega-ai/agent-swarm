import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteEventPromptTemplate } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeleteEventPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-event-prompt-template",
    {
      title: "Delete Event Prompt Template",
      description:
        "Delete a custom event prompt template by ID. The handler will revert to using its hardcoded default prompt.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        id: z.string().uuid().describe("The template ID to delete."),
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

      const deleted = deleteEventPromptTemplate(id);

      if (!deleted) {
        return {
          content: [{ type: "text", text: `Template ${id} not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Template ${id} not found.`,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Template ${id} deleted. Handler will use hardcoded default.`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Template ${id} deleted.`,
        },
      };
    },
  );
};
