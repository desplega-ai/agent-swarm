import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  getScriptConnectionById,
  listScriptConnections,
  refreshScriptConnection,
  setScriptConnectionEnabled,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "@/be/script-connections";
import { can } from "@/rbac";
import { placeholderForConfigKey } from "@/scripts-runtime/credential-broker";
import { createToolRegistrar } from "@/tools/utils";
import { resolveScopedResourceId, scopedResourceScopeIdSchema } from "@/utils/scoped-resource";

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
  scope: z.enum(["global", "agent", "repo"]).optional().describe("Connection visibility scope."),
  scopeId: scopedResourceScopeIdSchema
    .nullable()
    .optional()
    .describe("Agent UUID for agent scope or repo id (owner/name) for repo scope."),
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
  specSource: z
    .object({ kind: z.literal("vendored"), slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) })
    .optional()
    .describe(
      "Vendored OpenAPI source. Mutually exclusive with openapiSpecUrl and openapiSpecJson.",
    ),
  enabled: z.boolean().optional().describe("Whether the connection is enabled."),
});

const scriptConnectionsOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  connections: z.array(z.unknown()),
});

type ScriptConnectionsArgs = z.infer<typeof scriptConnectionsInputSchema>;
type ExistingConnection = NonNullable<ReturnType<typeof getScriptConnectionById>>;

function resolveConnectionScope(
  args: ScriptConnectionsArgs,
  existing: ExistingConnection | null,
): { scope: "global" | "agent" | "repo"; scopeId: string | null } {
  const scopeWasProvided = Object.hasOwn(args, "scope");
  const scopeIdWasProvided = Object.hasOwn(args, "scopeId");
  const scope = (scopeWasProvided ? args.scope : existing?.scope) ?? "global";
  const scopeIdInput = scopeIdWasProvided
    ? args.scopeId
    : existing && scope === existing.scope
      ? existing.scopeId
      : null;
  return {
    scope,
    scopeId: resolveScopedResourceId(scope, scopeIdInput, "connections"),
  };
}

function resolveConnectionEnabled(
  args: ScriptConnectionsArgs,
  existing: ExistingConnection | null,
): boolean {
  return Object.hasOwn(args, "enabled") ? args.enabled !== false : (existing?.enabled ?? true);
}

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
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          };
        }
        setScriptConnectionEnabled(args.id, false);
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          };
        }
        const refreshed = await refreshScriptConnection(args.id, null, requestInfo.agentId);
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          };
        }

        const existing = args.id ? getScriptConnectionById(args.id) : null;
        const { scope, scopeId } = resolveConnectionScope(args, existing);
        const connection = await upsertScriptConnection({
          id: args.id,
          slug: args.slug,
          displayName: args.displayName,
          kind: "mcp",
          scope,
          scopeId,
          mcpServerId: args.mcpServerId,
          enabled: resolveConnectionEnabled(args, existing),
          agentId: requestInfo.agentId,
        });

        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          };
        }

        let credentialBindingId = args.credentialBindingId ?? null;
        if (!credentialBindingId && args.configKey) {
          const placeholder = placeholderForConfigKey(args.configKey);
          const bindingScope = args.scope ?? "global";
          const binding = upsertCredentialBinding({
            configKey: args.configKey,
            allowedHosts: args.allowedHosts,
            headerTemplate:
              args.headerTemplate ??
              (args.queryTemplate ? undefined : `Authorization: Bearer ${placeholder}`),
            queryTemplate: args.queryTemplate,
            scope: bindingScope,
            scopeId: resolveScopedResourceId(bindingScope, args.scopeId, "bindings"),
          });
          credentialBindingId = binding.id;
        }

        const existing = args.id ? getScriptConnectionById(args.id) : null;
        const { scope, scopeId } = resolveConnectionScope(args, existing);
        const connection = await upsertScriptConnection({
          id: args.id,
          slug: args.slug,
          displayName: args.displayName,
          kind: "graphql",
          scope,
          scopeId,
          baseUrl: args.baseUrl,
          allowedHosts: args.allowedHosts,
          credentialBindingId,
          enabled: resolveConnectionEnabled(args, existing),
        });

        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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

      if (
        !args.slug ||
        (!args.openapiSpecJson && !args.openapiSpecUrl && !args.specSource) ||
        (!args.baseUrl && !args.specSource)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "slug, baseUrl (unless vendored), and exactly one OpenAPI spec source are required.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "slug, baseUrl (unless vendored), and exactly one OpenAPI spec source are required.",
            connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
          },
        };
      }
      if ([args.openapiSpecJson, args.openapiSpecUrl, args.specSource].filter(Boolean).length > 1) {
        return {
          content: [
            {
              type: "text",
              text: "Provide exactly one OpenAPI spec source.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Provide exactly one OpenAPI spec source.",
            connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
          },
        };
      }

      let credentialBindingId = args.credentialBindingId ?? null;
      if (!credentialBindingId && args.configKey) {
        const placeholder = placeholderForConfigKey(args.configKey);
        const bindingScope = args.scope ?? "global";
        const binding = upsertCredentialBinding({
          configKey: args.configKey,
          allowedHosts: args.allowedHosts ?? (args.baseUrl ? [new URL(args.baseUrl).hostname] : []),
          headerTemplate:
            args.headerTemplate ??
            (args.queryTemplate ? undefined : `Authorization: Bearer ${placeholder}`),
          queryTemplate: args.queryTemplate,
          scope: bindingScope,
          scopeId: resolveScopedResourceId(bindingScope, args.scopeId, "bindings"),
        });
        credentialBindingId = binding.id;
      }

      const existing = args.id ? getScriptConnectionById(args.id) : null;
      const { scope, scopeId } = resolveConnectionScope(args, existing);
      const connection = await upsertScriptConnection({
        id: args.id,
        slug: args.slug,
        displayName: args.displayName,
        kind: "openapi",
        scope,
        scopeId,
        baseUrl: args.baseUrl,
        allowedHosts: args.allowedHosts ?? (args.baseUrl ? [new URL(args.baseUrl).hostname] : []),
        credentialBindingId,
        openapiSpecSourceKind: args.specSource ? "vendored" : undefined,
        openapiSpecSource: args.specSource?.slug,
        openapiSpecUrl: args.openapiSpecUrl,
        openapiSpecJson: args.openapiSpecJson,
        enabled: resolveConnectionEnabled(args, existing),
      });

      const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
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
