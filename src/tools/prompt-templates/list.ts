import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getPromptTemplates } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { PromptTemplateSchema, PromptTemplateScopeSchema } from "@/types";

export const registerListPromptTemplatesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-prompt-templates",
    {
      title: "List Prompt Templates",
      description:
        "List prompt templates with optional filters. Returns all templates matching the specified criteria, including defaults and overrides at all scope levels.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        eventType: z
          .string()
          .optional()
          .describe("Filter by event type (e.g. 'github.pull_request.opened')."),
        scope: PromptTemplateScopeSchema.optional().describe(
          "Filter by scope: 'global', 'agent', or 'repo'.",
        ),
        scopeId: z.string().optional().describe("Filter by scope ID (agent ID or repo ID)."),
        isDefault: z.boolean().optional().describe("Filter by default status."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        templates: z.array(PromptTemplateSchema),
        count: z.number(),
      }),
    },
    async ({ eventType, scope, scopeId, isDefault }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            templates: [],
            count: 0,
          },
        };
      }

      try {
        const templates = getPromptTemplates({ eventType, scope, scopeId, isDefault });
        const count = templates.length;

        const summary =
          count === 0
            ? "No prompt templates found."
            : templates
                .map(
                  (t) =>
                    `- [${t.scope}${t.scopeId ? `:${t.scopeId}` : ""}] ${t.eventType} (v${t.version}, ${t.state}${t.isDefault ? ", default" : ""})`,
                )
                .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                count === 0
                  ? "No prompt templates found."
                  : `Found ${count} prompt template(s):\n\n${summary}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: count === 0 ? "No prompt templates found." : `Found ${count} template(s).`,
            templates,
            count,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to list prompt templates: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to list prompt templates: ${message}`,
            templates: [],
            count: 0,
          },
        };
      }
    },
  );
};
