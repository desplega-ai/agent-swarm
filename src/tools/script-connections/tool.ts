import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  ConnectionAuthInputSchema,
  connectionAuthInputFromFlat,
  getScriptConnectionById,
  listScriptConnections,
  refreshScriptConnection,
  setScriptConnectionEnabled,
  upsertScriptConnection,
} from "@/be/script-connections";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
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
  auth: ConnectionAuthInputSchema.optional().describe(
    "Inline connection auth. type=bearer|header|query with an inline `secret` (stored encrypted under a derived key) or a shared `configKey`; type=oauth with an `authorizationId`; type=none clears auth. Auto-manages the connection's credential binding.",
  ),
  configKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Deprecated flat alias for auth: config key for a derived credential binding."),
  headerTemplate: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Deprecated flat alias for auth: header template containing the config-key placeholder.",
    ),
  queryTemplate: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Deprecated flat alias for auth: query parameter template containing the config-key placeholder.",
    ),
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

const scriptConnectionsOutputSchema = swarmToolOutputSchema({
  yourAgentId: z.string().optional(),
  connections: z.array(z.unknown()).optional(),
});

type ScriptConnectionsArgs = z.infer<typeof scriptConnectionsInputSchema>;
type ExistingConnection = NonNullable<Awaited<ReturnType<typeof getScriptConnectionById>>>;

function baseUrlProvenanceText(connection: {
  slug: string;
  baseUrlSource: string;
  baseUrlMismatch?: { specUrl: string; effectiveUrl: string };
}): string {
  return `${connection.slug}: baseUrlSource=${connection.baseUrlSource}${connection.baseUrlMismatch ? `, baseUrlMismatch=${JSON.stringify(connection.baseUrlMismatch)}` : ""}`;
}

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
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      const agent = await getAgentById(requestInfo.agentId);
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
        return toolErr("Only the lead can manage script connections.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      if (args.action === "list") {
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
        const provenanceLines = connections
          .filter((connection) => connection.kind === "openapi" || connection.baseUrl !== null)
          .map(baseUrlProvenanceText);
        return toolOk(`Found ${connections.length} script connection(s).`, {
          details: provenanceLines.length > 0 ? provenanceLines.join("\n") : undefined,
          data: { yourAgentId: requestInfo.agentId, connections },
        });
      }

      if (args.action === "disable") {
        if (!args.id) {
          return toolErr("id is required for disable.", {
            data: {
              yourAgentId: requestInfo.agentId,
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          });
        }
        await setScriptConnectionEnabled(args.id, false);
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
        return toolOk("Script connection disabled.", {
          data: { yourAgentId: requestInfo.agentId, connections },
        });
      }

      if (args.action === "refresh") {
        if (!args.id) {
          return toolErr("id is required for refresh.", {
            data: {
              yourAgentId: requestInfo.agentId,
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          });
        }
        const refreshed = await refreshScriptConnection(args.id, null, requestInfo.agentId);
        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
        if (!refreshed) {
          return toolErr("Script connection not found.", {
            data: { yourAgentId: requestInfo.agentId, connections },
          });
        }
        const extras = {
          details: baseUrlProvenanceText(refreshed),
          data: { yourAgentId: requestInfo.agentId, connections },
        };
        return refreshed.generationError
          ? toolErr(`Refreshed but generation failed: ${refreshed.generationError}`, extras)
          : toolOk(`Script connection ${refreshed.slug} refreshed.`, extras);
      }

      if (args.action === "upsert-mcp") {
        if (!args.slug || !args.mcpServerId) {
          return toolErr("slug and mcpServerId are required.", {
            data: {
              yourAgentId: requestInfo.agentId,
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          });
        }

        const existing = args.id ? await getScriptConnectionById(args.id) : null;
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
        const extras = { data: { yourAgentId: requestInfo.agentId, connections } };
        return connection.generationError
          ? toolErr(`Saved but generation failed: ${connection.generationError}`, extras)
          : toolOk(`Script MCP connection ${connection.slug} saved.`, extras);
      }

      if (args.action === "upsert-graphql") {
        if (!args.slug || !args.baseUrl || !args.allowedHosts?.length) {
          return toolErr("slug, baseUrl, and allowedHosts are required.", {
            data: {
              yourAgentId: requestInfo.agentId,
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          });
        }

        const existing = args.id ? await getScriptConnectionById(args.id) : null;
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
          auth: connectionAuthInputFromFlat({
            auth: args.auth,
            configKey: args.configKey,
            headerTemplate: args.headerTemplate,
            queryTemplate: args.queryTemplate,
            allowedHosts: args.allowedHosts,
          }),
          credentialBindingId: args.credentialBindingId ?? undefined,
          enabled: resolveConnectionEnabled(args, existing),
        });

        const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
        const extras = { data: { yourAgentId: requestInfo.agentId, connections } };
        return connection.generationError
          ? toolErr(`Saved but generation failed: ${connection.generationError}`, extras)
          : toolOk(`Script GraphQL connection ${connection.slug} saved.`, extras);
      }

      if (!args.slug || (!args.openapiSpecJson && !args.openapiSpecUrl && !args.specSource)) {
        return toolErr(
          "slug and exactly one OpenAPI spec source (openapiSpecJson, openapiSpecUrl, or specSource) are required.",
          {
            data: {
              yourAgentId: requestInfo.agentId,
              connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
            },
          },
        );
      }
      if ([args.openapiSpecJson, args.openapiSpecUrl, args.specSource].filter(Boolean).length > 1) {
        return toolErr("Provide exactly one OpenAPI spec source.", {
          data: {
            yourAgentId: requestInfo.agentId,
            connections: listScriptConnections({ includeDisabled: true, allScopes: true }),
          },
        });
      }

      const existing = args.id ? await getScriptConnectionById(args.id) : null;
      const { scope, scopeId } = resolveConnectionScope(args, existing);
      const connection = await upsertScriptConnection({
        id: args.id,
        slug: args.slug,
        displayName: args.displayName,
        kind: "openapi",
        scope,
        scopeId,
        baseUrl: args.baseUrl,
        allowedHosts: args.allowedHosts,
        auth: connectionAuthInputFromFlat({
          auth: args.auth,
          configKey: args.configKey,
          headerTemplate: args.headerTemplate,
          queryTemplate: args.queryTemplate,
          allowedHosts: args.allowedHosts,
        }),
        credentialBindingId: args.credentialBindingId ?? undefined,
        openapiSpecSourceKind: args.specSource ? "vendored" : undefined,
        openapiSpecSource: args.specSource?.slug,
        openapiSpecUrl: args.openapiSpecUrl,
        openapiSpecJson: args.openapiSpecJson,
        enabled: resolveConnectionEnabled(args, existing),
      });

      const connections = listScriptConnections({ includeDisabled: true, allScopes: true });
      const extras = {
        details: baseUrlProvenanceText(connection),
        data: { yourAgentId: requestInfo.agentId, connections },
      };
      return connection.generationError
        ? toolErr(`Saved but generation failed: ${connection.generationError}`, extras)
        : toolOk(`Script connection ${connection.slug} saved.`, extras);
    },
  );
};
