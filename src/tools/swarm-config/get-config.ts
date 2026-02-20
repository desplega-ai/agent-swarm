import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getResolvedConfig, maskSecrets } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmConfigSchema } from "@/types";

export const registerGetConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-config",
    {
      title: "Get Config",
      description:
        "Get resolved configuration values with scope resolution (repo > agent > global). Returns one entry per unique key with the most-specific scope winning. Use includeSecrets=true to see secret values.",
      inputSchema: z.object({
        agentId: z
          .string()
          .uuid()
          .optional()
          .describe("Agent ID for scope resolution. Omit for global-only configs."),
        repoId: z
          .string()
          .uuid()
          .optional()
          .describe("Repo ID for scope resolution. Omit for agent/global-only configs."),
        key: z
          .string()
          .optional()
          .describe("Filter by specific key. If omitted, returns all resolved configs."),
        includeSecrets: z
          .boolean()
          .optional()
          .describe("If true, include actual secret values (default: false, secrets are masked)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        configs: z.array(SwarmConfigSchema),
        count: z.number(),
      }),
    },
    async ({ agentId, repoId, key, includeSecrets }, requestInfo) => {
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
        let configs = getResolvedConfig(agentId, repoId);

        if (key) {
          configs = configs.filter((c) => c.key === key);
        }

        const result = includeSecrets ? configs : maskSecrets(configs);
        const count = result.length;

        const configList =
          count === 0
            ? "No configs found."
            : result
                .map(
                  (c) =>
                    `- ${c.key}=${c.isSecret && !includeSecrets ? "********" : c.value} (scope: ${c.scope}${c.scopeId ? `, scopeId: ${c.scopeId}` : ""})`,
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
          content: [{ type: "text", text: `Failed to get config: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to get config: ${message}`,
            configs: [],
            count: 0,
          },
        };
      }
    },
  );
};
