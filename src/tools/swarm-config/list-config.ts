import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSwarmConfigs, maskSecrets } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmConfigSchema, SwarmConfigScopeSchema } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

export const registerListConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-config",
    {
      title: "List Config",
      description:
        "List raw config entries with optional filters. Unlike get-config, this returns raw entries without scope resolution — useful for seeing exactly what's configured at each scope level.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        scope: SwarmConfigScopeSchema.optional().describe(
          "Filter by scope: 'global', 'agent', or 'repo'.",
        ),
        scopeId: z.string().uuid().optional().describe("Filter by agent ID or repo ID."),
        key: z.string().optional().describe("Filter by specific key."),
        includeSecrets: z
          .boolean()
          .optional()
          .describe("If true, include actual secret values (default: false)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        configs: z.array(SwarmConfigSchema),
        count: z.number(),
      }),
    },
    async ({ scope, scopeId, key, includeSecrets }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            configs: [],
            count: 0,
          },
        };
      }

      try {
        const configs = getSwarmConfigs({
          scope,
          scopeId,
          key,
        });

        // Reading UNMASKED secret values is lead-gated (DES-445 follow-up).
        // Non-lead callers don't hard-fail: we force-mask and note it.
        let effectiveIncludeSecrets = includeSecrets ?? false;
        let secretsNote = "";
        if (includeSecrets) {
          const agent = getAgentById(requestInfo.agentId);
          const decision = can({
            principal: {
              kind: "agent",
              agentId: requestInfo.agentId,
              isLead: agent?.isLead ?? false,
            },
            verb: "config.read.secrets",
            resource: { kind: "none" },
            source: "mcp",
          });
          if (!decision.allow) {
            effectiveIncludeSecrets = false;
            secretsNote =
              " (secret values masked: reading unmasked secrets requires the lead agent)";
          }
        }

        const result = effectiveIncludeSecrets ? configs : maskSecrets(configs);
        if (effectiveIncludeSecrets) {
          for (const c of result) {
            if (c.isSecret && c.value) {
              registerVolatileSecret(c.value, `config:${c.key}`);
            }
          }
        }
        const count = result.length;

        const configList =
          count === 0
            ? "No configs found."
            : result
                .map(
                  (c) =>
                    `- [${c.scope}${c.scopeId ? `:${c.scopeId}` : ""}] ${c.key}=${c.isSecret && !effectiveIncludeSecrets ? "********" : c.value}${c.description ? ` — ${c.description}` : ""}`,
                )
                .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                count === 0
                  ? "No configs found."
                  : `Found ${count} config(s):\n\n${configList}${secretsNote}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: count === 0 ? "No configs found." : `Found ${count} config(s).${secretsNote}`,
            configs: result,
            count,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to list configs: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to list configs: ${message}`,
            configs: [],
            count: 0,
          },
        };
      }
    },
  );
};
