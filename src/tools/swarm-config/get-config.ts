import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getResolvedConfig, maskSecrets } from "@/be/db";
import { overlayOperatorEnvValue, overlayOperatorEnvValues } from "@/be/swarm-config-guard";
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

type GetConfigArgs = {
  agentId?: string;
  repoId?: string;
  key?: string;
  includeSecrets?: boolean;
};

/** Exported for direct testing, mirroring the other tool handlers. */
export const getConfigHandler = async (
  { agentId, repoId, key, includeSecrets }: GetConfigArgs,
  requestInfo: { agentId?: string },
) => {
  if (!requestInfo.agentId) {
    return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
      data: { configs: [], count: 0 },
    });
  }

  try {
    let configs = getResolvedConfig(agentId, repoId);

    if (key) {
      configs = overlayOperatorEnvValue(
        configs.filter((c) => c.key === key),
        key,
      );
    } else {
      // The unfiltered read is the audit path — an operator's env-only kill
      // switch (e.g. DREAMING_ENABLED=false) must show up here too, exactly
      // as it does on the REST resolved-config route.
      configs = overlayOperatorEnvValues(configs);
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
        secretsNote = " (secret values masked: reading unmasked secrets requires the lead agent)";
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
                `- ${c.key}=${c.isSecret && !effectiveIncludeSecrets ? "********" : c.value} (scope: ${c.scope}${c.scopeId ? `, scopeId: ${c.scopeId}` : ""})`,
            )
            .join("\n");

    return toolOk(count === 0 ? "No configs found." : `Found ${count} config(s).${secretsNote}`, {
      details: configList,
      data: { yourAgentId: requestInfo.agentId, configs: result, count },
      // Deliberate reveal when the lead asked for unmasked secrets — the
      // volatile secrets registered above would otherwise be redacted by
      // the finalize scrubber.
      allowSecretEgress: effectiveIncludeSecrets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return toolErr(`Failed to get config: ${message}`, {
      data: { yourAgentId: requestInfo.agentId, configs: [], count: 0 },
    });
  }
};

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        configs: z.array(configEntryShape).optional(),
        count: z.number().optional(),
      }),
    },
    (args, requestInfo) => getConfigHandler(args, requestInfo),
  );
};
