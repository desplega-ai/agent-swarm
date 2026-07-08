import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  listScriptConnections,
  refreshScriptConnection,
  setScriptConnectionEnabled,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "@/be/script-connections";
import { can } from "@/rbac";
import { placeholderForConfigKey } from "@/scripts-runtime/credential-broker";
import { createToolRegistrar } from "@/tools/utils";

const scriptConnectionsInputSchema = z.object({
  action: z
    .enum(["list", "upsert-openapi", "upsert-mcp", "upsert-graphql", "refresh", "disable"])
    .describe("List, create/update, refresh, or disable a script connection."),
  id: z
    .string()
    .uuid()
    .optional()
    .describe("Existing connection ID for update, refresh, or disable."),
  slug: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Stable script namespace slug exposed under ctx.api or ctx.mcp."),
  displayName: z.string().max(160).optional().describe("Human-readable connection name."),
  scope: z
    .enum(["global", "agent", "repo"])
    .default("global")
    .optional()
    .describe("Connection visibility scope."),
  scopeId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Agent or repo UUID when scope is agent or repo."),
  mcpServerId: z
    .string()
    .uuid()
    .optional()
    .describe("Registered MCP server ID for upsert-mcp connections."),
  baseUrl: z.string().url().optional().describe("Base URL for OpenAPI or GraphQL connections."),
  allowedHosts: z
    .array(z.string().min(1))
    .optional()
    .describe("Allowed outbound hostnames for credential substitution."),
  credentialBindingId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Existing credential binding ID to attach to the connection."),
  configKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Config key used to create a credential binding when credentialBindingId is omitted.",
    ),
  headerTemplate: z
    .string()
    .min(1)
    .optional()
    .describe("Header template containing the config-key placeholder."),
  queryTemplate: z
    .string()
    .min(1)
    .optional()
    .describe("Query parameter template containing the config-key placeholder."),
  openapiSpecUrl: z
    .string()
    .url()
    .optional()
    .describe("URL to fetch and store an OpenAPI spec for upsert-openapi and refresh."),
  openapiSpecJson: z
    .string()
    .optional()
    .describe("Inline OpenAPI JSON for upsert-openapi. Mutually exclusive with openapiSpecUrl."),
  enabled: z.boolean().default(true).optional().describe("Whether the connection is enabled."),
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
        "Lead-only registry management for scripts ctx.api/ctx.mcp connections. Supports OpenAPI, MCP, and GraphQL script connections.",
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
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "script-connection.manage",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
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

      if (args.action === "refresh") {
        if (!args.id) {
          return {
            content: [{ type: "text", text: "id is required for refresh." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "id is required for refresh.",
              connections: listScriptConnections({ includeDisabled: true }),
            },
          };
        }
        const refreshed = await refreshScriptConnection(args.id);
        const connections = listScriptConnections({ includeDisabled: true });
        if (!refreshed) {
          return {
            content: [{ type: "text", text: "Script connection not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Script connection not found.",
              connections,
            },
          };
        }
        return {
          content: [{ type: "text", text: `Script connection ${refreshed.slug} refreshed.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: !refreshed.generationError,
            message: refreshed.generationError
              ? `Refreshed but generation failed: ${refreshed.generationError}`
              : `Script connection ${refreshed.slug} refreshed.`,
            connections,
          },
        };
      }

      if (args.action === "upsert-mcp") {
        if (!args.slug || !args.mcpServerId) {
          return {
            content: [{ type: "text", text: "slug and mcpServerId are required." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "slug and mcpServerId are required.",
              connections: listScriptConnections({ includeDisabled: true }),
            },
          };
        }

        const connection = await upsertScriptConnection({
          id: args.id,
          slug: args.slug,
          displayName: args.displayName,
          kind: "mcp",
          scope: args.scope ?? "global",
          scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
          mcpServerId: args.mcpServerId,
          enabled: args.enabled !== false,
          agentId: requestInfo.agentId,
        });

        const connections = listScriptConnections({ includeDisabled: true });
        return {
          content: [{ type: "text", text: `Script MCP connection ${connection.slug} saved.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: !connection.generationError,
            message: connection.generationError
              ? `Saved but generation failed: ${connection.generationError}`
              : `Script MCP connection ${connection.slug} saved.`,
            connections,
          },
        };
      }

      if (args.action === "upsert-graphql") {
        if (!args.slug || !args.baseUrl || !args.allowedHosts?.length) {
          return {
            content: [{ type: "text", text: "slug, baseUrl, and allowedHosts are required." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "slug, baseUrl, and allowedHosts are required.",
              connections: listScriptConnections({ includeDisabled: true }),
            },
          };
        }

        let credentialBindingId = args.credentialBindingId ?? null;
        if (!credentialBindingId && args.configKey) {
          const placeholder = placeholderForConfigKey(args.configKey);
          const binding = upsertCredentialBinding({
            configKey: args.configKey,
            allowedHosts: args.allowedHosts,
            headerTemplate: args.headerTemplate ?? `Authorization: Bearer ${placeholder}`,
            queryTemplate: args.queryTemplate,
            scope: args.scope ?? "global",
            scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
          });
          credentialBindingId = binding.id;
        }

        const connection = await upsertScriptConnection({
          id: args.id,
          slug: args.slug,
          displayName: args.displayName,
          kind: "graphql",
          scope: args.scope ?? "global",
          scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
          baseUrl: args.baseUrl,
          allowedHosts: args.allowedHosts,
          credentialBindingId,
          enabled: args.enabled !== false,
        });

        const connections = listScriptConnections({ includeDisabled: true });
        return {
          content: [{ type: "text", text: `Script GraphQL connection ${connection.slug} saved.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: !connection.generationError,
            message: connection.generationError
              ? `Saved but generation failed: ${connection.generationError}`
              : `Script GraphQL connection ${connection.slug} saved.`,
            connections,
          },
        };
      }

      if (!args.slug || !args.baseUrl || (!args.openapiSpecJson && !args.openapiSpecUrl)) {
        return {
          content: [
            {
              type: "text",
              text: "slug, baseUrl, and either openapiSpecJson or openapiSpecUrl are required.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "slug, baseUrl, and either openapiSpecJson or openapiSpecUrl are required.",
            connections: listScriptConnections({ includeDisabled: true }),
          },
        };
      }
      if (args.openapiSpecJson && args.openapiSpecUrl) {
        return {
          content: [
            {
              type: "text",
              text: "Provide either openapiSpecJson or openapiSpecUrl, not both.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Provide either openapiSpecJson or openapiSpecUrl, not both.",
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

      const connection = await upsertScriptConnection({
        id: args.id,
        slug: args.slug,
        displayName: args.displayName,
        kind: "openapi",
        scope: args.scope ?? "global",
        scopeId: args.scope === "global" ? null : (args.scopeId ?? null),
        baseUrl: args.baseUrl,
        allowedHosts: args.allowedHosts ?? [new URL(args.baseUrl).hostname],
        credentialBindingId,
        openapiSpecUrl: args.openapiSpecUrl,
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
