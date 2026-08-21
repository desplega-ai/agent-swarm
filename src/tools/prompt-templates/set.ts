import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getDbClient, upsertPromptTemplate } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { PromptTemplateScopeSchema, PromptTemplateStateSchema } from "@/types";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        template: promptTemplateOutputShape.optional(),
      }),
    },
    async ({ eventType, scope: rawScope, scopeId, state, body, changeReason }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      const scope = rawScope ?? "global";

      if (scope !== "global" && !scopeId) {
        return toolErr(`scopeId is required for scope '${scope}'.`, {
          details: `scopeId is required for scope '${scope}'. Provide an agent ID or repo ID.`,
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        // The sync helper stays on the raw handle for the boot seeder; on
        // this request path, run it inside a client transaction so the write
        // holds the FIFO lock instead of landing inside a foreign BEGIN window.
        const template = await getDbClient().transaction(async () =>
          upsertPromptTemplate({
            eventType,
            scope,
            scopeId: scope === "global" ? null : scopeId,
            state,
            body,
            changedBy: requestInfo.agentId,
            changeReason,
          }),
        );

        return toolOk(`Template "${eventType}" set successfully at version ${template.version}.`, {
          details: `Prompt template for "${eventType}" set successfully (scope: ${scope}${scopeId ? `, scopeId: ${scopeId}` : ""}, v${template.version}).`,
          data: { yourAgentId: requestInfo.agentId, template },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to set prompt template: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
