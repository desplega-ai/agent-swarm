import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listEventPromptTemplates } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { EventPromptProviderSchema, EventPromptTemplateSchema } from "@/types";

export const registerListEventPromptTemplatesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-event-prompt-templates",
    {
      title: "List Event Prompt Templates",
      description:
        "List all custom event prompt templates. Optionally filter by provider (github, gitlab, agentmail).",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        provider: EventPromptProviderSchema.optional().describe("Optional filter by provider."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        templates: z.array(EventPromptTemplateSchema),
        count: z.number(),
      }),
    },
    async ({ provider }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            templates: [],
            count: 0,
          },
        };
      }

      const templates = listEventPromptTemplates(provider ? { provider } : undefined);

      const summary =
        templates.length === 0
          ? "No custom event prompt templates configured. Handlers use hardcoded defaults."
          : templates
              .map(
                (t) =>
                  `- ${t.provider}:${t.eventType}${t.agentId ? ` (agent: ${t.agentId})` : " (global)"}${t.enabled ? "" : " [DISABLED]"}`,
              )
              .join("\n");

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          templates,
          count: templates.length,
        },
      };
    },
  );
};
