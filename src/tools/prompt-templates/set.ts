import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { upsertPromptTemplate } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import {
  PromptTemplateSchema,
  PromptTemplateScopeSchema,
  PromptTemplateStateSchema,
} from "@/types";

export const registerSetPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "set-prompt-template",
    {
      title: "Set Prompt Template",
      description:
        "Create or update a prompt template override. Upserts by (eventType, scope, scopeId). Use scope='global' for server-wide, 'agent' for agent-specific, or 'repo' for repo-specific overrides.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        eventType: z
          .string()
          .min(1)
          .describe("Event type identifier (e.g. 'github.pull_request.opened')."),
        scope: PromptTemplateScopeSchema.optional().describe(
          "Template scope: 'global' (default), 'agent', or 'repo'.",
        ),
        scopeId: z
          .string()
          .optional()
          .describe(
            "Agent ID or repo ID. Required for 'agent' and 'repo' scopes, omit for 'global'.",
          ),
        state: PromptTemplateStateSchema.optional().describe(
          "Template state: 'enabled' (default), 'default_prompt_fallback', or 'skip_event'.",
        ),
        body: z.string().describe("The template body text with {{variable}} placeholders."),
        changeReason: z
          .string()
          .optional()
          .describe("Reason for the change (recorded in history)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        template: PromptTemplateSchema.optional(),
      }),
    },
    async ({ eventType, scope: rawScope, scopeId, state, body, changeReason }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      const scope = rawScope ?? "global";

      if (scope !== "global" && !scopeId) {
        return {
          content: [
            {
              type: "text",
              text: `scopeId is required for scope '${scope}'. Provide an agent ID or repo ID.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `scopeId is required for scope '${scope}'.`,
          },
        };
      }

      try {
        const template = upsertPromptTemplate({
          eventType,
          scope,
          scopeId: scope === "global" ? null : scopeId,
          state,
          body,
          changedBy: requestInfo.agentId,
          changeReason,
        });

        return {
          content: [
            {
              type: "text",
              text: `Prompt template for "${eventType}" set successfully (scope: ${scope}${scopeId ? `, scopeId: ${scopeId}` : ""}, v${template.version}).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Template "${eventType}" set successfully at version ${template.version}.`,
            template,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to set prompt template: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to set prompt template: ${message}`,
          },
        };
      }
    },
  );
};
