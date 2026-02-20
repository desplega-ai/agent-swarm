import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSwarmConfigs, maskSecrets } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmConfigSchema, SwarmConfigScopeSchema } from "@/types";

export const registerListConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-config",
    {
      title: "List Config",
      description:
        "List raw config entries with optional filters. Unlike get-config, this returns raw entries without scope resolution — useful for seeing exactly what's configured at each scope level.",
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

        const result = includeSecrets ? configs : maskSecrets(configs);
        const count = result.length;

        const configList =
          count === 0
            ? "No configs found."
            : result
                .map(
                  (c) =>
                    `- [${c.scope}${c.scopeId ? `:${c.scopeId}` : ""}] ${c.key}=${c.isSecret && !includeSecrets ? "********" : c.value}${c.description ? ` — ${c.description}` : ""}`,
                )
                .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                count === 0 ? "No configs found." : `Found ${count} config(s):\n\n${configList}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: count === 0 ? "No configs found." : `Found ${count} config(s).`,
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
