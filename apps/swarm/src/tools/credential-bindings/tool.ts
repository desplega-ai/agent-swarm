import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  disableCredentialBinding,
  importLegacyCredentialBindings,
  listRelationalCredentialBindings,
  upsertCredentialBinding,
} from "@/be/script-connections";
import {
  CredentialBindingSchema,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import { createToolRegistrar } from "@/tools/utils";

const credentialBindingsOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  bindings: z.array(CredentialBindingSchema),
});

const credentialBindingsInputSchema = z.object({
  action: z
    .enum(["list", "upsert", "disable", "import-legacy"])
    .describe("List, add/update, disable, or import legacy JSON bindings."),
  id: z.string().uuid().optional(),
  configKey: z.string().min(1).max(255).optional(),
  allowedHosts: z.array(z.string().min(1)).min(1).optional(),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  scope: z.enum(["global", "agent", "repo"]).default("global").optional(),
  scopeId: z.string().uuid().nullable().optional(),
});

export const registerCredentialBindingsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "credential-bindings",
    {
      title: "Credential Bindings",
      description:
        "Lead-only management for scripts-runtime credential broker bindings. Bindings map config keys to allowed egress hosts; scripts consume them only through fetch-layer placeholder substitution.",
      annotations: { idempotentHint: true },
      inputSchema: credentialBindingsInputSchema,
      outputSchema: credentialBindingsOutputSchema,
    },
    async (args, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            bindings: [],
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent?.isLead) {
        return {
          content: [{ type: "text", text: "Only the lead can manage credential bindings." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only the lead can manage credential bindings.",
            bindings: [],
          },
        };
      }

      const bindings = listRelationalCredentialBindings({ includeInactive: true });

      if (args.action === "list") {
        return {
          content: [
            {
              type: "text",
              text:
                bindings.length === 0
                  ? "No configured credential bindings."
                  : `Found ${bindings.length} credential binding(s).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message:
              bindings.length === 0
                ? "No configured credential bindings."
                : `Found ${bindings.length} credential binding(s).`,
            bindings,
          },
        };
      }

      if (args.action === "import-legacy") {
        const imported = importLegacyCredentialBindings();
        const nextBindings = listRelationalCredentialBindings({ includeInactive: true });
        return {
          content: [{ type: "text", text: `Imported ${imported} legacy credential binding(s).` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Imported ${imported} legacy credential binding(s).`,
            bindings: nextBindings,
          },
        };
      }

      if (args.action === "disable") {
        const disabled = args.id ? disableCredentialBinding(args.id) : null;
        if (!disabled) {
          return {
            content: [{ type: "text", text: "Credential binding id not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Credential binding id not found.",
              bindings,
            },
          };
        }

        const nextBindings = listRelationalCredentialBindings({ includeInactive: true });
        return {
          content: [{ type: "text", text: `Credential binding ${disabled.configKey} disabled.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Credential binding ${disabled.configKey} disabled.`,
            bindings: nextBindings,
          },
        };
      }

      if (!args.configKey) {
        return {
          content: [{ type: "text", text: "configKey is required for upsert." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "configKey is required for upsert.",
            bindings,
          },
        };
      }

      const scope = args.scope ?? "global";
      const scopeId = scope === "global" ? null : (args.scopeId ?? null);
      if (scope !== "global" && !scopeId) {
        return {
          content: [{ type: "text", text: `scopeId is required for ${scope} bindings.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `scopeId is required for ${scope} bindings.`,
            bindings,
          },
        };
      }

      if (!args.allowedHosts || (!args.headerTemplate && !args.queryTemplate)) {
        return {
          content: [
            {
              type: "text",
              text: "allowedHosts and at least one of headerTemplate or queryTemplate are required for upsert.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "allowedHosts and at least one of headerTemplate or queryTemplate are required for upsert.",
            bindings,
          },
        };
      }

      const placeholder = placeholderForConfigKey(args.configKey);
      if (args.headerTemplate && !args.headerTemplate.includes(placeholder)) {
        return {
          content: [{ type: "text", text: `headerTemplate must include ${placeholder}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `headerTemplate must include ${placeholder}.`,
            bindings,
          },
        };
      }
      if (args.queryTemplate && !args.queryTemplate.includes(placeholder)) {
        return {
          content: [{ type: "text", text: `queryTemplate must include ${placeholder}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `queryTemplate must include ${placeholder}.`,
            bindings,
          },
        };
      }

      const nextBinding = CredentialBindingSchema.parse({
        configKey: args.configKey,
        allowedHosts: args.allowedHosts,
        headerTemplate: args.headerTemplate,
        queryTemplate: args.queryTemplate,
        scope,
        scopeId,
        active: true,
      });

      upsertCredentialBinding({
        id: args.id,
        configKey: nextBinding.configKey,
        allowedHosts: nextBinding.allowedHosts,
        headerTemplate: nextBinding.headerTemplate,
        queryTemplate: nextBinding.queryTemplate,
        scope: nextBinding.scope,
        scopeId: nextBinding.scopeId ?? null,
        active: true,
      });
      const nextBindings = listRelationalCredentialBindings({ includeInactive: true });

      return {
        content: [{ type: "text", text: `Credential binding ${args.configKey} saved.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Credential binding ${args.configKey} saved.`,
          bindings: nextBindings,
        },
      };
    },
  );
};
