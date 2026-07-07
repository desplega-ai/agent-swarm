import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getResolvedConfig, maskSecrets } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";
import { SwarmConfigSchema } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

export const registerGetConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-config",
    {
      title: "Get Config",
      description:
        "Get resolved configuration values with scope resolution (repo > agent > global). Returns one entry per unique key with the most-specific scope winning. Use includeSecrets=true to see secret values. IMPORTANT: never pass returned secret values directly on a command line — write them to a temp .env file and source it instead, so the literal value stays out of logged commands.",
      annotations: { readOnlyHint: true },

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

        // Reading UNMASKED secret values is lead-gated (DES-445 follow-up).
        // Non-lead callers don't hard-fail: we force-mask and note it, so the
        // (masked) read stays open to everyone.
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
                    `- ${c.key}=${c.isSecret && !effectiveIncludeSecrets ? "********" : c.value} (scope: ${c.scope}${c.scopeId ? `, scopeId: ${c.scopeId}` : ""})`,
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
