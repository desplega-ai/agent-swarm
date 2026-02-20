import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { maskSecrets, upsertSwarmConfig } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmConfigSchema, SwarmConfigScopeSchema } from "@/types";

export const registerSetConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "set-config",
    {
      title: "Set Config",
      description:
        "Set or update a swarm configuration value. Upserts by (scope, scopeId, key). Use scope='global' for server-wide settings, 'agent' for agent-specific, or 'repo' for repo-specific. Set isSecret=true to mask the value in API responses.",
      inputSchema: z.object({
        scope: SwarmConfigScopeSchema.describe("Config scope: 'global', 'agent', or 'repo'."),
        scopeId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Agent ID or repo ID. Required for 'agent' and 'repo' scopes, omit for 'global'.",
          ),
        key: z
          .string()
          .min(1)
          .max(255)
          .describe("Configuration key (e.g., 'AGENTMAIL_WEBHOOK_SECRET')."),
        value: z.string().describe("Configuration value."),
        isSecret: z
          .boolean()
          .optional()
          .describe("If true, value is masked in API responses (default: false)."),
        envPath: z
          .string()
          .optional()
          .describe("Optional: file path to write the value as KEY=VALUE in a .env file."),
        description: z
          .string()
          .optional()
          .describe("Optional human-readable description of this config entry."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        config: SwarmConfigSchema.optional(),
      }),
    },
    async ({ scope, scopeId, key, value, isSecret, envPath, description }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      try {
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

        const config = upsertSwarmConfig({
          scope,
          scopeId: scope === "global" ? null : scopeId,
          key,
          value,
          isSecret,
          envPath,
          description,
        });

        const [masked] = maskSecrets([config]);

        return {
          content: [
            {
              type: "text",
              text: `Config "${key}" set successfully (scope: ${scope}${scopeId ? `, scopeId: ${scopeId}` : ""}).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Config "${key}" set successfully.`,
            config: masked,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to set config: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to set config: ${message}`,
          },
        };
      }
    },
  );
};
