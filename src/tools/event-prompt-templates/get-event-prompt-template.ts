import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getEventPromptTemplate } from "@/be/db";
import { EVENT_TEMPLATE_VARIABLES, VALID_EVENT_TYPES } from "@/events/template-resolver";
import { createToolRegistrar } from "@/tools/utils";
import { EventPromptProviderSchema, EventPromptTemplateSchema } from "@/types";

export const registerGetEventPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-event-prompt-template",
    {
      title: "Get Event Prompt Template",
      description:
        "Get the resolved event prompt template for a provider + event type. Shows the active template (agent-specific or global) and available {{}} interpolation variables.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        provider: EventPromptProviderSchema.describe("Event source provider."),
        eventType: z.string().min(1).describe("Event type (e.g. 'pull_request.assigned')."),
        agentId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional agent ID to check agent-specific override."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        template: EventPromptTemplateSchema.nullable(),
        availableVariables: z.array(z.string()),
        message: z.string(),
      }),
    },
    async ({ provider, eventType, agentId }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            template: null,
            availableVariables: [],
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      const validTypes = VALID_EVENT_TYPES[provider];
      if (!validTypes?.includes(eventType)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid event type "${eventType}" for provider "${provider}". Valid types: ${validTypes?.join(", ") ?? "none"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            template: null,
            availableVariables: [],
            message: `Invalid event type "${eventType}".`,
          },
        };
      }

      const template = getEventPromptTemplate(provider, eventType, agentId);
      const variables = EVENT_TEMPLATE_VARIABLES[`${provider}:${eventType}`] ?? [];

      const text = template
        ? `Custom template for ${provider}:${eventType}${template.agentId ? ` (agent: ${template.agentId})` : " (global)"}:\n\n${template.template}\n\nAvailable variables: ${variables.join(", ")}`
        : `No custom template for ${provider}:${eventType}. Using hardcoded default.\n\nAvailable variables for custom templates: ${variables.join(", ")}`;

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          template: template ?? null,
          availableVariables: variables,
          message: template ? "Custom template found." : "No custom template. Using default.",
        },
      };
    },
  );
};
