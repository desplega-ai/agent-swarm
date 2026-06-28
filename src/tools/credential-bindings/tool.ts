import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getSwarmConfigs, upsertSwarmConfig } from "@/be/db";
import { scheduleIntegrationsReload } from "@/http/core";
import {
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  type CredentialBinding,
  CredentialBindingSchema,
  normalizeCredentialBindingsDocument,
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
  action: z.enum(["list", "upsert", "disable"]).describe("List, add/update, or disable a binding."),
  configKey: z.string().min(1).max(255).optional(),
  allowedHosts: z.array(z.string().min(1)).min(1).optional(),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  scope: z.enum(["global", "agent", "repo"]).default("global").optional(),
  scopeId: z.string().uuid().nullable().optional(),
});

function bindingIdentity(binding: Pick<CredentialBinding, "configKey" | "scope" | "scopeId">) {
  return `${binding.scope}:${binding.scopeId ?? ""}:${binding.configKey}`;
}

function readGlobalBindings(): CredentialBinding[] {
  const row = getSwarmConfigs({ scope: "global", key: CREDENTIAL_BINDINGS_CONFIG_KEY })[0];
  if (!row) return [];

  try {
    return normalizeCredentialBindingsDocument(JSON.parse(row.value));
  } catch {
    return [];
  }
}

function writeGlobalBindings(bindings: CredentialBinding[]) {
  upsertSwarmConfig({
    scope: "global",
    key: CREDENTIAL_BINDINGS_CONFIG_KEY,
    value: JSON.stringify({ bindings }, null, 2),
    isSecret: false,
    description: "Lead-managed scripts-runtime credential broker bindings.",
  });
  scheduleIntegrationsReload();
}

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

      const bindings = readGlobalBindings();

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

      if (!args.configKey) {
        return {
          content: [{ type: "text", text: "configKey is required for upsert and disable." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "configKey is required for upsert and disable.",
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

      const targetIdentity = bindingIdentity({ configKey: args.configKey, scope, scopeId });
      const existingIndex = bindings.findIndex(
        (binding) => bindingIdentity(binding) === targetIdentity,
      );

      if (args.action === "disable") {
        const existing = bindings[existingIndex];
        if (!existing) {
          return {
            content: [{ type: "text", text: `Credential binding ${args.configKey} not found.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Credential binding ${args.configKey} not found.`,
              bindings,
            },
          };
        }

        bindings[existingIndex] = { ...existing, active: false };
        writeGlobalBindings(bindings);
        return {
          content: [{ type: "text", text: `Credential binding ${args.configKey} disabled.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Credential binding ${args.configKey} disabled.`,
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

      if (existingIndex >= 0) bindings[existingIndex] = nextBinding;
      else bindings.push(nextBinding);
      writeGlobalBindings(bindings);

      return {
        content: [{ type: "text", text: `Credential binding ${args.configKey} saved.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Credential binding ${args.configKey} saved.`,
          bindings,
        },
      };
    },
  );
};
