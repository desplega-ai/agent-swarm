import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSwarmConfigs, maskSecrets } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { SwarmConfigScopeSchema } from "@/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

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
        scopeId: z.string().optional().describe("Filter by agent ID or repo ID."),
        key: z.string().optional().describe("Filter by specific key."),
        includeSecrets: z
          .boolean()
          .optional()
          .describe("If true, include actual secret values (default: false)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        configs: z.array(configEntryShape).optional(),
        count: z.number().optional(),
      }),
    },
    async ({ scope, scopeId, key, includeSecrets }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { configs: [], count: 0 },
        });
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
            ? undefined
            : result
                .map(
                  (c) =>
                    `- [${c.scope}${c.scopeId ? `:${c.scopeId}` : ""}] ${c.key}=${c.isSecret && !effectiveIncludeSecrets ? "********" : c.value}${c.description ? ` — ${c.description}` : ""}`,
                )
                .join("\n");

        return toolOk(
          count === 0 ? "No configs found." : `Found ${count} config(s).${secretsNote}`,
          {
            details: configList,
            data: { yourAgentId: requestInfo.agentId, configs: result, count },
            // Deliberate reveal when the lead asked for unmasked secrets — the
            // volatile secrets registered above would otherwise be redacted by
            // the finalize scrubber.
            allowSecretEgress: effectiveIncludeSecrets,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to list configs: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, configs: [], count: 0 },
        });
      }
    },
  );
};
