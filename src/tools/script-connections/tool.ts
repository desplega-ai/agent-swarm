import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  listScriptConnections,
  setScriptConnectionEnabled,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "@/be/script-connections";
import { placeholderForConfigKey } from "@/scripts-runtime/credential-broker";
import { createToolRegistrar } from "@/tools/utils";

const scriptConnectionsInputSchema = z.object({
  action: z
    .enum(["list", "upsert-openapi", "disable"])
    .describe("List, create/update, or disable a script connection."),
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(80).optional(),
  displayName: z.string().max(160).optional(),
  scope: z.enum(["global", "agent", "repo"]).default("global").optional(),
  scopeId: z.string().uuid().nullable().optional(),
  baseUrl: z.string().url().optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  credentialBindingId: z.string().uuid().nullable().optional(),
  configKey: z.string().min(1).max(255).optional(),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  openapiSpecJson: z.string().optional(),
  enabled: z.boolean().default(true).optional(),
});

const scriptConnectionsOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  connections: z.array(z.unknown()),
});

export const registerScriptConnectionsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-connections",
    {
      title: "Script Connections",
      description:
        "Lead-only registry management for scripts ctx.api/ctx.mcp connections. Phase 1 supports OpenAPI ctx.api connections with generated args and response types.",
      annotations: { idempotentHint: true },
      inputSchema: scriptConnectionsInputSchema,
      outputSchema: scriptConnectionsOutputSchema,
    },
    async (args, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            connections: [],
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
      if (!agent?.isLead) {
        return {
          content: [{ type: "text", text: "Only the lead can manage script connections." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only the lead can manage script connections.",
            connections: [],
          },
        };
      }

      if (args.action === "list") {
        const connections = listScriptConnections({ includeDisabled: true });
        return {
          content: [{ type: "text", text: `Found ${connections.length} script connection(s).` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${connections.length} script connection(s).`,
            connections,
          },
        };
      }

      if (args.action === "disable") {
        if (!args.id) {
          return {
            content: [{ type: "text", text: "id is required for disable." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "id is required for disable.",
              connections: listScriptConnections({ includeDisabled: true }),
            },
          };
        }
        setScriptConnectionEnabled(args.id, false);
        const connections = listScriptConnections({ includeDisabled: true });
        return {
          content: [{ type: "text", text: "Script connection disabled." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: "Script connection disabled.",
            connections,
          },
        };
      }

      if (!args.slug || !args.baseUrl || !args.openapiSpecJson) {
        return {
          content: [{ type: "text", text: "slug, baseUrl, and openapiSpecJson are required." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "slug, baseUrl, and openapiSpecJson are required.",
            connections: listScriptConnections({ includeDisabled: true }),
          },
        };
      }

      let credentialBindingId = args.credentialBindingId ?? null;
      if (!credentialBindingId && args.configKey) {
        const placeholder = placeholderForConfigKey(args.configKey);
        const binding = upsertCredentialBinding({
          configKey: args.configKey,
          allowedHosts: args.allowedHosts ?? [new URL(args.baseUrl).hostname],
          headerTemplate: args.headerTemplate ?? `Authorization: Bearer ${placeholder}`,
          queryTemplate: args.queryTemplate,
          scope: args.scope ?? "global",
          scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
        });
        credentialBindingId = binding.id;
      }

      const connection = upsertScriptConnection({
        id: args.id,
        slug: args.slug,
        displayName: args.displayName,
        kind: "openapi",
        scope: args.scope ?? "global",
        scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
        baseUrl: args.baseUrl,
        allowedHosts: args.allowedHosts ?? [new URL(args.baseUrl).hostname],
        credentialBindingId,
        openapiSpecJson: args.openapiSpecJson,
        enabled: args.enabled !== false,
      });

      const connections = listScriptConnections({ includeDisabled: true });
      return {
        content: [{ type: "text", text: `Script connection ${connection.slug} saved.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: !connection.generationError,
          message: connection.generationError
            ? `Saved but generation failed: ${connection.generationError}`
            : `Script connection ${connection.slug} saved.`,
          connections,
        },
      };
    },
  );
};
