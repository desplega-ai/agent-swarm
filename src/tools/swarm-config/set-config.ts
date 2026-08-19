import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, maskSecrets } from "@/be/db";
import { upsertSwarmConfigWithPolicyMirror } from "@/be/multi-runtime";
import {
  isReservedConfigKey,
  reservedKeyError,
  validateConfigValue,
} from "@/be/swarm-config-guard";
import { scheduleIntegrationsReload } from "@/http/core";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { SwarmConfigScopeSchema } from "@/types";

const configEntryShape = z.looseObject({
  id: z.string().optional(),
  scope: SwarmConfigScopeSchema.optional(),
  scopeId: z.string().nullable().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  isSecret: z.boolean().optional(),
  envPath: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  encrypted: z.boolean().optional(),
});

export const registerSetConfigTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "set-config",
    {
      title: "Set Config",
      description:
        "Set or update a swarm configuration value. Upserts by (scope, scopeId, key). Use scope='global' for server-wide settings, 'agent' for agent-specific, or 'repo' for repo-specific. Set isSecret=true to mask the value in API responses.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        scope: SwarmConfigScopeSchema.describe("Config scope: 'global', 'agent', or 'repo'."),
        scopeId: z
          .string()
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        config: configEntryShape.optional(),
      }),
    },
    async ({ scope, scopeId, key, value, isSecret, envPath, description }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      try {
        if (scope !== "global" && !scopeId) {
          return toolErr(`scopeId is required for scope '${scope}'.`, {
            details: `scopeId is required for scope '${scope}'. Provide an agent ID or repo ID.`,
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        if (isReservedConfigKey(key)) {
          const message = reservedKeyError(key).message;
          return toolErr(message, { data: { yourAgentId: requestInfo.agentId } });
        }

        // Every swarm-config write is lead-gated (DES-445 follow-up): previously
        // ANY agent could write arbitrary config (incl. secret values). The
        // legacy SCRIPT_CREDENTIAL_BINDINGS blob is retired, so there is no
        // special-cased key here anymore.
        const agent = getAgentById(requestInfo.agentId);
        const decision = can({
          principal: {
            kind: "agent",
            agentId: requestInfo.agentId,
            isLead: agent?.isLead ?? false,
          },
          verb: "config.write.any",
          resource: { kind: "none" },
          source: "mcp",
        });
        if (!decision.allow) {
          return toolErr("Writing swarm config requires the lead agent.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const validationError = validateConfigValue(key, value);
        if (validationError) {
          return toolErr(validationError, { data: { yourAgentId: requestInfo.agentId } });
        }

        const config = upsertSwarmConfigWithPolicyMirror({
          scope,
          scopeId: scope === "global" ? null : scopeId,
          key,
          value,
          isSecret,
          envPath,
          description,
        });

        if (scope === "global") {
          scheduleIntegrationsReload();
        }

        const [masked] = maskSecrets([config]);

        return toolOk(`Config "${key}" set successfully.`, {
          details: `Config "${key}" set successfully (scope: ${scope}${scopeId ? `, scopeId: ${scopeId}` : ""}).`,
          data: { yourAgentId: requestInfo.agentId, config: masked },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to set config: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
