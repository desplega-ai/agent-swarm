import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { upsertEventPromptTemplate } from "@/be/db";
import { EVENT_TEMPLATE_VARIABLES, VALID_EVENT_TYPES } from "@/events/template-resolver";
import { createToolRegistrar } from "@/tools/utils";
import { EventPromptProviderSchema, EventPromptTemplateSchema } from "@/types";

const allEventTypes = Object.values(VALID_EVENT_TYPES).flat();

export const registerSetEventPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "set-event-prompt-template",
    {
      title: "Set Event Prompt Template",
      description: `Create or update a custom prompt template for an event type. Templates use {{path.to.value}} interpolation. When set, the custom template replaces the hardcoded default prompt for that event.

Valid providers: github, gitlab, agentmail
Valid event types: ${allEventTypes.join(", ")}

Use get-event-prompt-template to see available {{}} variables for each event type.`,
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        provider: EventPromptProviderSchema.describe("Event source provider."),
        eventType: z
          .string()
          .min(1)
          .describe(
            "Event type (e.g. 'pull_request.assigned', 'pipeline.failed'). Use list-event-prompt-templates to see all valid types.",
          ),
        template: z
          .string()
          .min(1)
          .describe(
            "Prompt template with {{path.to.value}} interpolation tokens. E.g. '[PR #{{pr.number}}] {{pr.title}}'",
          ),
        agentId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional agent ID for agent-specific override. Omit for global template."),
        description: z.string().optional().describe("Optional human-readable description."),
        enabled: z.boolean().optional().describe("Whether the template is active (default: true)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        template: EventPromptTemplateSchema.optional(),
      }),
    },
    async ({ provider, eventType, template, agentId, description, enabled }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Validate event type
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
            message: `Invalid event type "${eventType}" for provider "${provider}".`,
          },
        };
      }

      try {
        const result = upsertEventPromptTemplate({
          provider,
          eventType,
          template,
          agentId: agentId ?? null,
          description: description ?? null,
          enabled,
        });

        const variables = EVENT_TEMPLATE_VARIABLES[`${provider}:${eventType}`] ?? [];

        return {
          content: [
            {
              type: "text",
              text: `Template set for ${provider}:${eventType}${agentId ? ` (agent: ${agentId})` : " (global)"}.\nAvailable variables: ${variables.join(", ")}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Template set for ${provider}:${eventType}.`,
            template: result,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to set template: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to set template: ${message}`,
          },
        };
      }
    },
  );
};
