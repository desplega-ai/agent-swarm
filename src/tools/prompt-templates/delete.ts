import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deletePromptTemplate, getPromptTemplateById } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async ({ id }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      try {
        const existing = getPromptTemplateById(id);
        if (!existing) {
          return toolErr(`Prompt template "${id}" not found.`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const deleted = deletePromptTemplate(id);
        if (!deleted) {
          return toolErr(`Failed to delete prompt template "${id}".`, {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        return toolOk(`Prompt template "${existing.eventType}" deleted successfully.`, {
          details: `Prompt template "${existing.eventType}" (scope: ${existing.scope}${existing.scopeId ? `, scopeId: ${existing.scopeId}` : ""}) deleted successfully.`,
          data: { yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to delete prompt template: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
