import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getPromptTemplates } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { PromptTemplateScopeSchema } from "@/types";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        templates: z.array(promptTemplateOutputShape).optional(),
        count: z.number().optional(),
      }),
    },
    async ({ eventType, scope, scopeId, isDefault }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { templates: [], count: 0 },
        });
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

        return toolOk(count === 0 ? "No prompt templates found." : `Found ${count} template(s).`, {
          details: count === 0 ? undefined : summary,
          data: { yourAgentId: requestInfo.agentId, templates, count },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to list prompt templates: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, templates: [], count: 0 },
        });
      }
    },
  );
};
