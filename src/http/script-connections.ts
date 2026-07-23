import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "@/be/audit-user";
import { normalizeDate } from "@/be/date-utils";
import { getAgentById, getDb } from "@/be/db";
import {
  deleteAuthorizationById,
  deleteOAuthTokens,
  getAuthorizationById,
  getOAuthApp,
  getOAuthAppById,
  getOAuthTokens,
  listAuthorizationsForApp,
  type OAuthAuthorization,
  updateAuthorizationTokens,
  upsertOAuthApp,
} from "@/be/db-queries/oauth";
import {
  getOAuthBindingTokenStatus,
  type OAuthBindingTokenStatus,
  oauthAppToProviderConfig,
} from "@/be/oauth-credential-bindings";
import {
  getScriptConnectionById,
  listRelationalCredentialBindings,
  listScriptConnections,
  refreshScriptConnection,
  type ScriptConnectionKind,
  type ScriptConnectionRecord,
  type ScriptCredentialBindingRecord,
  setScriptConnectionEnabled,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "@/be/script-connections";
import { listVendoredOpenapiEntries } from "@/be/vendored-openapi";
import { assertOAuthAppUrlsSafe, assertOAuthProviderIsNotReserved } from "@/oauth/app-validation";
import { forceRefreshTokenOrThrow } from "@/oauth/ensure-token";
import { assertUrlSafe, publicEndpointSsrfOptions } from "@/oauth/mcp-wrapper";
import { buildAuthorizationUrl, refreshTokenGrant } from "@/oauth/wrapper";
import { can } from "@/rbac";
import {
  CredentialBindingSchema,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import type { OAuthApp } from "@/tracker/types";
import { getRequestAuth } from "@/utils/request-auth-context";
import { resolveScopedResourceId, scopedResourceScopeIdSchema } from "@/utils/scoped-resource";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { staticOAuthCallbackUri } from "./oauth-callback";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const providerSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);

const scopeSchema = z.enum(["global", "agent", "repo"]);
const connectionKindSchema = z.enum(["openapi", "graphql", "mcp"]);

const idParamsSchema = z.object({ id: z.string().uuid() });
const providerParamsSchema = z.object({ provider: providerSchema });
// OAuth app ids are `hex(randomblob(16))` and authorization ids may be
// migrated (non-UUID) identifiers — accept any opaque id, not just UUIDs.
const oauthResourceIdParamsSchema = z.object({ id: z.string().min(1).max(255) });

const listConnectionsQuerySchema = z.object({
  kind: connectionKindSchema.optional(),
  scope: scopeSchema.optional(),
  scopeId: z.string().optional(),
});

const connectionBaseBodySchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(80),
  displayName: z.string().max(160).optional(),
  scope: scopeSchema.optional(),
  scopeId: scopedResourceScopeIdSchema.nullable().optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  credentialBindingId: z.string().uuid().nullable().optional(),
  configKey: z.string().min(1).max(255).optional(),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  authKind: z.enum(["config", "oauth"]).optional(),
  oauthAuthorizationId: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
});

const vendoredSpecSourceSchema = z.object({
  kind: z.literal("vendored"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});

const upsertConnectionBodySchema = z.discriminatedUnion("kind", [
  connectionBaseBodySchema.extend({
    kind: z.literal("openapi"),
    baseUrl: z.string().url().optional(),
    openapiSpecUrl: z.string().url().optional(),
    openapiSpecJson: z.string().optional(),
    specSource: vendoredSpecSourceSchema.optional(),
  }),
  connectionBaseBodySchema.extend({
    kind: z.literal("graphql"),
    baseUrl: z.string().url(),
    allowedHosts: z.array(z.string().min(1)).min(1),
  }),
  connectionBaseBodySchema.extend({
    kind: z.literal("mcp"),
    mcpServerId: z.string().uuid(),
  }),
]);

const disableConnectionBodySchema = z.object({ enabled: z.boolean() });

const credentialBindingBodySchema = z.object({
  id: z.string().uuid().optional(),
  configKey: z.string().min(1).max(255),
  allowedHosts: z.array(z.string().min(1)).min(1),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  scope: scopeSchema.default("global").optional(),
  scopeId: scopedResourceScopeIdSchema.nullable().optional(),
  active: z.boolean().default(true).optional(),
  authKind: z.enum(["config", "oauth"]).default("config").optional(),
  oauthAuthorizationId: z.string().min(1).max(255).optional(),
});

const oauthAppBodySchema = z.object({
  provider: providerSchema,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  authorizeUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string().min(1)).default([]).optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
  tokenAuthStyle: z.enum(["body", "basic"]).optional(),
  tokenBodyFormat: z.enum(["form", "json"]).optional(),
});

const discoverOAuthAppBodySchema = z.object({
  url: z.string().url(),
});

const listConnectionsRoute = route({
  method: "get",
  path: "/api/script-connections",
  pattern: ["api", "script-connections"],
  operationId: "script_connections_list",
  summary: "List script connections",
  description:
    "Dashboard read of OpenAPI, GraphQL, and MCP script connections with credential summaries.",
  tags: ["Script Connections"],
  query: listConnectionsQuerySchema,
  responses: {
    200: { description: "Script connections" },
    400: { description: "Validation error" },
  },
});

const getConnectionRoute = route({
  method: "get",
  path: "/api/script-connections/{id}",
  pattern: ["api", "script-connections", null],
  operationId: "script_connections_get",
  summary: "Get script connection detail",
  tags: ["Script Connections"],
  params: idParamsSchema,
  responses: {
    200: { description: "Script connection detail" },
    404: { description: "Script connection not found" },
  },
});

const upsertConnectionRoute = route({
  method: "post",
  path: "/api/script-connections",
  pattern: ["api", "script-connections"],
  operationId: "script_connections_upsert",
  summary: "Create or update a script connection",
  tags: ["Script Connections"],
  body: upsertConnectionBodySchema,
  responses: {
    200: { description: "Saved script connection" },
    400: { description: "Validation or generation error" },
    403: { description: "Only the lead agent can manage script connections" },
  },
  rbac: { permission: "script-connection.manage" },
});

const refreshConnectionRoute = route({
  method: "post",
  path: "/api/script-connections/{id}/refresh",
  pattern: ["api", "script-connections", null, "refresh"],
  operationId: "script_connections_refresh",
  summary: "Refresh a script connection",
  tags: ["Script Connections"],
  params: idParamsSchema,
  responses: {
    200: { description: "Refreshed script connection" },
    400: { description: "Connection cannot be refreshed" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "Script connection not found" },
  },
  rbac: { permission: "script-connection.manage" },
});

const setConnectionEnabledRoute = route({
  method: "post",
  path: "/api/script-connections/{id}/disable",
  pattern: ["api", "script-connections", null, "disable"],
  operationId: "script_connections_set_enabled",
  summary: "Enable or disable a script connection",
  tags: ["Script Connections"],
  params: idParamsSchema,
  body: disableConnectionBodySchema,
  responses: {
    200: { description: "Updated script connection" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "Script connection not found" },
  },
  rbac: { permission: "script-connection.manage" },
});

const listCredentialBindingsRoute = route({
  method: "get",
  path: "/api/credential-bindings",
  pattern: ["api", "credential-bindings"],
  operationId: "credential_bindings_list",
  summary: "List script credential bindings",
  tags: ["Script Connections"],
  responses: {
    200: { description: "Credential bindings" },
  },
});

const upsertCredentialBindingRoute = route({
  method: "post",
  path: "/api/credential-bindings",
  pattern: ["api", "credential-bindings"],
  operationId: "credential_bindings_upsert",
  summary: "Create or update a script credential binding",
  tags: ["Script Connections"],
  body: credentialBindingBodySchema,
  responses: {
    200: { description: "Saved credential binding" },
    400: { description: "Validation error" },
    403: { description: "Only the lead agent can manage script connections" },
  },
  rbac: { permission: "script-connection.manage" },
});

const listOAuthAppsRoute = route({
  method: "get",
  path: "/api/oauth-apps",
  pattern: ["api", "oauth-apps"],
  operationId: "oauth_apps_list",
  summary: "List OAuth apps for script credential bindings",
  tags: ["Script Connections"],
  responses: {
    200: { description: "OAuth apps without client secrets" },
  },
});

const upsertOAuthAppRoute = route({
  method: "post",
  path: "/api/oauth-apps",
  pattern: ["api", "oauth-apps"],
  operationId: "oauth_apps_upsert",
  summary: "Create or update an OAuth app for script credential bindings",
  tags: ["Script Connections"],
  body: oauthAppBodySchema,
  responses: {
    200: { description: "Saved OAuth app without client secret" },
    400: { description: "Validation error" },
    403: { description: "Only the lead agent can manage script connections" },
  },
  rbac: { permission: "oauth-app.manage" },
});

const discoverOAuthAppRoute = route({
  method: "post",
  path: "/api/oauth-apps/discover",
  pattern: ["api", "oauth-apps", "discover"],
  operationId: "oauth_apps_discover",
  summary: "Discover OAuth endpoints from provider metadata",
  tags: ["Script Connections"],
  body: discoverOAuthAppBodySchema,
  responses: {
    200: { description: "Discovered OAuth metadata" },
    400: { description: "Discovery failed" },
    403: { description: "Only the lead agent can manage script connections" },
  },
  rbac: { permission: "oauth-app.manage" },
});

const deleteOAuthAppRoute = route({
  method: "delete",
  path: "/api/oauth-apps/{provider}",
  pattern: ["api", "oauth-apps", null],
  operationId: "oauth_apps_delete",
  summary: "Delete an OAuth app and its tokens",
  tags: ["Script Connections"],
  params: providerParamsSchema,
  responses: {
    200: { description: "OAuth app deleted" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "OAuth app not found" },
  },
  rbac: { permission: "oauth-app.manage" },
});

const authorizeUrlBodySchema = z
  .object({
    label: z.string().min(1).max(255).default("default").optional(),
    finalRedirect: z.string().url().optional(),
  })
  .optional();

const authorizeUrlRoute = route({
  method: "post",
  path: "/api/oauth-apps/{id}/authorize-url",
  pattern: ["api", "oauth-apps", null, "authorize-url"],
  operationId: "oauth_apps_authorize_url",
  summary: "Build an OAuth authorization URL for a labeled authorization",
  tags: ["Script Connections"],
  params: oauthResourceIdParamsSchema,
  body: authorizeUrlBodySchema,
  responses: {
    200: { description: "OAuth authorization URL + state" },
    403: { description: "Only the lead agent can manage OAuth authorizations" },
    404: { description: "OAuth app not found" },
  },
  rbac: { permission: "oauth-authorization.manage" },
});

const listAuthorizationsRoute = route({
  method: "get",
  path: "/api/oauth-apps/{id}/authorizations",
  pattern: ["api", "oauth-apps", null, "authorizations"],
  operationId: "oauth_app_authorizations_list",
  summary: "List the labeled authorizations for an OAuth app (never token material)",
  tags: ["Script Connections"],
  params: oauthResourceIdParamsSchema,
  responses: {
    200: { description: "Authorizations without token material" },
    404: { description: "OAuth app not found" },
  },
});

const deleteAuthorizationRoute = route({
  method: "delete",
  path: "/api/oauth-authorizations/{id}",
  pattern: ["api", "oauth-authorizations", null],
  operationId: "oauth_authorization_delete",
  summary: "Revoke (best-effort) and delete a single OAuth authorization",
  tags: ["Script Connections"],
  params: oauthResourceIdParamsSchema,
  responses: {
    200: { description: "Authorization revoked + deleted" },
    403: { description: "Only the lead agent can manage OAuth authorizations" },
    404: { description: "Authorization not found" },
  },
  rbac: { permission: "oauth-authorization.manage" },
});

const refreshAuthorizationRoute = route({
  method: "post",
  path: "/api/oauth-authorizations/{id}/refresh",
  pattern: ["api", "oauth-authorizations", null, "refresh"],
  operationId: "oauth_authorization_refresh",
  summary: "Force-refresh a single OAuth authorization (never returns token values)",
  tags: ["Script Connections"],
  params: oauthResourceIdParamsSchema,
  responses: {
    200: { description: "Refresh result with token status and new expiry" },
    400: { description: "No refresh token stored" },
    403: { description: "Only the lead agent can manage OAuth authorizations" },
    404: { description: "Authorization not found" },
    502: { description: "Provider token endpoint rejected the refresh" },
  },
  rbac: { permission: "oauth-authorization.manage" },
});

const integrationsCatalogRoute = route({
  method: "get",
  path: "/api/integrations-catalog",
  pattern: ["api", "integrations-catalog"],
  operationId: "integrations_catalog_list",
  summary: "Proxy integrations.sh catalog entries",
  tags: ["Script Connections"],
  responses: {
    200: { description: "Integrations catalog entries" },
    502: { description: "Catalog upstream unavailable" },
  },
});

const surfaceDomainSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9.-]+$/i);

const integrationsSurfaceRoute = route({
  method: "get",
  path: "/api/integrations-catalog/{domain}/surface",
  pattern: ["api", "integrations-catalog", null, "surface"],
  operationId: "integrations_catalog_surface",
  summary: "Proxy integrations.sh per-domain surface details (trimmed for the Add Connection flow)",
  tags: ["Script Connections"],
  params: z.object({ domain: surfaceDomainSchema }),
  responses: {
    200: { description: "Trimmed integration surface details for a domain" },
    404: { description: "No surface data for this domain" },
    502: { description: "Surface upstream unavailable" },
  },
});

const disconnectOAuthAppRoute = route({
  method: "delete",
  path: "/api/oauth-apps/{provider}/tokens",
  pattern: ["api", "oauth-apps", null, "tokens"],
  operationId: "oauth_app_disconnect",
  summary:
    "Disconnect an OAuth app: delete stored tokens (best-effort remote revocation when a revocation endpoint is known)",
  tags: ["Script Connections"],
  params: providerParamsSchema,
  responses: {
    200: { description: "Disconnect result" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "OAuth app not found" },
  },
  rbac: { permission: "oauth-app.manage" },
});

const refreshOAuthAppTokensRoute = route({
  method: "post",
  path: "/api/oauth-apps/{provider}/refresh",
  pattern: ["api", "oauth-apps", null, "refresh"],
  operationId: "oauth_app_refresh_tokens",
  summary: "Force-refresh the stored OAuth tokens for a provider (never returns token values)",
  tags: ["Script Connections"],
  params: providerParamsSchema,
  responses: {
    200: { description: "Refresh result with token status and new expiry" },
    400: { description: "No stored tokens or provider does not support refresh" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "OAuth app not found" },
    502: { description: "Provider token endpoint rejected the refresh" },
  },
  rbac: { permission: "oauth-app.manage" },
});

type BindingSummary = {
  id: string;
  configKey: string;
  authKind: "config" | "oauth";
  oauthAuthorizationId?: string;
  tokenStatus?: OAuthBindingTokenStatus;
};

type DecoratedBinding = ScriptCredentialBindingRecord & {
  tokenStatus?: OAuthBindingTokenStatus;
};

type DecoratedConnection = Omit<
  ScriptConnectionRecord,
  "openapiSpecJson" | "generatedTypes" | "generatedRuntimeJson"
> & {
  operationCount: number;
  toolCount: number;
  credentialBinding: BindingSummary | null;
};

type ConnectionOperationParameter = {
  name: string;
  in: string;
  required: boolean;
  schema?: unknown;
};

type ConnectionDetail = DecoratedConnection & {
  operations: Array<{
    name: string;
    method: string;
    path: string;
    parameters?: ConnectionOperationParameter[];
    hasBody?: boolean;
    successStatus?: string;
    requestBodySchema?: unknown;
    responseSchema?: unknown;
  }>;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  graphql: boolean;
  generatedTypes: string;
  specSummary?: { title?: string; version?: string; pathCount: number };
  specPreview?: { json: string; truncated: boolean };
};

type OAuthAppRow = {
  id: string;
  provider: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string;
  tokenExpiresAt: string | null;
  tokenUpdatedAt: string | null;
  authorizationId: string | null;
  extraParamsJson: string | null;
  tokenAuthStyle: "body" | "basic";
  tokenBodyFormat: "form" | "json";
  createdAt: string;
  updatedAt: string;
};

type IntegrationsCatalogEntry = {
  id: string;
  kind: string;
  slug: string;
  name: string;
  description: string;
  url: string;
  icon: string | null;
  domain: string;
  categories: string[];
  feeds: string[];
  vendoredSlug?: string;
  presetId?: string;
};

const BLESSED_CATALOG_ENTRIES: IntegrationsCatalogEntry[] = listVendoredOpenapiEntries().map(
  (entry) => ({
    id: entry.slug,
    kind: "openapi",
    slug: entry.slug,
    name: entry.name,
    description: `Blessed ${entry.name} integration`,
    url: entry.docsUrl,
    icon: null,
    domain: entry.domain,
    categories: entry.categories,
    feeds: ["blessed"],
    vendoredSlug: entry.slug,
    ...(entry.presetId ? { presetId: entry.presetId } : {}),
  }),
);

const DISCOVERY_TIMEOUT_MS = 10_000;
const INTEGRATIONS_CATALOG_TIMEOUT_MS = 15_000;
const INTEGRATIONS_CATALOG_TTL_MS = 60 * 60 * 1000;
const SPEC_PREVIEW_MAX_BYTES = 50 * 1024;

let integrationsCatalogCache: {
  expiresAtMs: number;
  payload: { entries: IntegrationsCatalogEntry[]; cachedAt: string };
} | null = null;

export function resetIntegrationsCatalogCacheForTesting(): void {
  integrationsCatalogCache = null;
}

type IntegrationsSurfaceMechanics = {
  in: string;
  headerName: string | null;
  scheme: string | null;
};

type IntegrationsSurfaceEntry = {
  type: string;
  name: string;
  url: string | null;
  docs: string | null;
  /** OpenAPI spec URL advertised by http surfaces (may be YAML). */
  spec: string | null;
  auth: {
    required: boolean;
    credentialIds: string[];
    mechanics: IntegrationsSurfaceMechanics | null;
  };
};

type IntegrationsSurfaceCredential = {
  type: string;
  label: string;
  generateUrl: string | null;
  setup: string | null;
};

type IntegrationsSurfacePayload = {
  domain: string;
  summary: string;
  surfaces: IntegrationsSurfaceEntry[];
  credentials: Record<string, IntegrationsSurfaceCredential>;
};

const INTEGRATIONS_SURFACE_CACHE_MAX_ENTRIES = 200;
const integrationsSurfaceCache = new Map<
  string,
  { expiresAtMs: number; payload: IntegrationsSurfacePayload }
>();

class SurfaceNotFoundError extends Error {}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function ensureConnectionAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
): boolean {
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator" || auth?.kind === "user") return true;

  const callerAgentId = agentId ?? singleHeader(req, "x-agent-id");
  const agent = callerAgentId ? getAgentById(callerAgentId) : undefined;
  const decision = can({
    principal: {
      kind: "agent",
      agentId: callerAgentId ?? "",
      isLead: agent?.isLead ?? false,
    },
    verb: "script-connection.manage",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Only the lead can manage script connections.", 403);
    return false;
  }
  return true;
}

/**
 * Generic principal gate for OAuth-app / OAuth-authorization management. Mirrors
 * {@link ensureConnectionAdmin} but keys on the OAuth-specific verbs so the two
 * surfaces can diverge in a future role-based rollout.
 */
function ensureVerbAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
  verb: "oauth-app.manage" | "oauth-authorization.manage",
  denyMessage: string,
): boolean {
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator" || auth?.kind === "user") return true;

  const callerAgentId = agentId ?? singleHeader(req, "x-agent-id");
  const agent = callerAgentId ? getAgentById(callerAgentId) : undefined;
  const decision = can({
    principal: { kind: "agent", agentId: callerAgentId ?? "", isLead: agent?.isLead ?? false },
    verb,
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, denyMessage, 403);
    return false;
  }
  return true;
}

function ensureOAuthAppAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
): boolean {
  return ensureVerbAdmin(
    req,
    res,
    agentId,
    "oauth-app.manage",
    "Only the lead can manage OAuth apps.",
  );
}

function ensureOAuthAuthorizationAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
): boolean {
  return ensureVerbAdmin(
    req,
    res,
    agentId,
    "oauth-authorization.manage",
    "Only the lead can manage OAuth authorizations.",
  );
}

function tokenStatusForBinding(
  binding: ScriptCredentialBindingRecord,
): OAuthBindingTokenStatus | undefined {
  if (binding.authKind !== "oauth") return undefined;
  return binding.oauthAuthorizationId
    ? getOAuthBindingTokenStatus(binding.oauthAuthorizationId)
    : "missing";
}

function decorateBinding(binding: ScriptCredentialBindingRecord): DecoratedBinding {
  const tokenStatus = tokenStatusForBinding(binding);
  return tokenStatus ? { ...binding, tokenStatus } : binding;
}

function bindingSummary(binding: ScriptCredentialBindingRecord | undefined): BindingSummary | null {
  if (!binding) return null;
  const tokenStatus = tokenStatusForBinding(binding);
  return {
    id: binding.id,
    configKey: binding.configKey,
    authKind: binding.authKind ?? "config",
    ...(binding.oauthAuthorizationId ? { oauthAuthorizationId: binding.oauthAuthorizationId } : {}),
    ...(tokenStatus ? { tokenStatus } : {}),
  };
}

function runtimeCounts(connection: ScriptConnectionRecord): {
  operationCount: number;
  toolCount: number;
} {
  if (!connection.generatedRuntimeJson) {
    return { operationCount: 0, toolCount: 0 };
  }
  try {
    const runtime = JSON.parse(connection.generatedRuntimeJson) as {
      operations?: unknown;
      tools?: unknown;
      kind?: unknown;
    };
    const operationCount = Array.isArray(runtime.operations)
      ? runtime.operations.length
      : connection.kind === "graphql"
        ? 1
        : 0;
    const toolCount = Array.isArray(runtime.tools) ? runtime.tools.length : 0;
    return { operationCount, toolCount };
  } catch {
    return { operationCount: 0, toolCount: 0 };
  }
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function connectionDetail(connection: ScriptConnectionRecord): ConnectionDetail {
  const decorated = decorateConnections([connection])[0];
  if (!decorated) throw new Error("Failed to decorate connection detail.");

  const runtime = parseRecord(connection.generatedRuntimeJson);
  const operations = Array.isArray(runtime?.operations)
    ? runtime.operations
        .filter((operation): operation is Record<string, unknown> => {
          return operation !== null && typeof operation === "object" && !Array.isArray(operation);
        })
        .map((operation) => ({
          name: String(operation.name ?? ""),
          method: String(operation.method ?? ""),
          path: String(operation.path ?? ""),
          ...(Array.isArray(operation.parameters)
            ? {
                parameters: operation.parameters
                  .filter((param): param is Record<string, unknown> => {
                    return param !== null && typeof param === "object" && !Array.isArray(param);
                  })
                  .map((param) => ({
                    name: String(param.name ?? ""),
                    in: String(param.in ?? "query"),
                    required: param.required === true,
                    ...(param.schema !== undefined ? { schema: param.schema } : {}),
                  }))
                  .filter((param) => param.name),
              }
            : {}),
          ...(typeof operation.hasBody === "boolean" ? { hasBody: operation.hasBody } : {}),
          ...(typeof operation.successStatus === "string"
            ? { successStatus: operation.successStatus }
            : {}),
          ...(operation.requestBodySchema !== undefined
            ? { requestBodySchema: operation.requestBodySchema }
            : {}),
          ...(operation.responseSchema !== undefined
            ? { responseSchema: operation.responseSchema }
            : {}),
        }))
        .filter((operation) => operation.name && operation.method && operation.path)
    : [];
  const tools = Array.isArray(runtime?.tools)
    ? runtime.tools
        .filter((tool): tool is Record<string, unknown> => {
          return tool !== null && typeof tool === "object" && !Array.isArray(tool);
        })
        .map((tool) => ({
          name: String(tool.name ?? ""),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }))
        .filter((tool) => tool.name)
    : [];

  const detail: ConnectionDetail = {
    ...decorated,
    operations,
    tools,
    graphql: connection.kind === "graphql",
    generatedTypes: connection.generatedTypes ?? "",
  };

  if (connection.kind === "openapi" && connection.openapiSpecJson) {
    try {
      const spec = JSON.parse(connection.openapiSpecJson) as Record<string, unknown>;
      const info =
        spec.info && typeof spec.info === "object" && !Array.isArray(spec.info)
          ? (spec.info as Record<string, unknown>)
          : {};
      const paths =
        spec.paths && typeof spec.paths === "object" && !Array.isArray(spec.paths)
          ? (spec.paths as Record<string, unknown>)
          : {};
      const pretty = JSON.stringify(spec, null, 2);
      const truncated = pretty.length > SPEC_PREVIEW_MAX_BYTES;
      detail.specSummary = {
        ...(typeof info.title === "string" ? { title: info.title } : {}),
        ...(typeof info.version === "string" ? { version: info.version } : {}),
        pathCount: Object.keys(paths).length,
      };
      detail.specPreview = {
        json: truncated ? pretty.slice(0, SPEC_PREVIEW_MAX_BYTES) : pretty,
        truncated,
      };
    } catch {
      detail.specPreview = {
        json: connection.openapiSpecJson.slice(0, SPEC_PREVIEW_MAX_BYTES),
        truncated: connection.openapiSpecJson.length > SPEC_PREVIEW_MAX_BYTES,
      };
    }
  }

  return detail;
}

function decorateConnections(connections: ScriptConnectionRecord[]): DecoratedConnection[] {
  const bindings = new Map(
    listRelationalCredentialBindings({ includeInactive: true }).map((binding) => [
      binding.id,
      binding,
    ]),
  );
  return connections.map((connection) => {
    const {
      openapiSpecJson: _openapiSpecJson,
      generatedTypes: _generatedTypes,
      generatedRuntimeJson: _generatedRuntimeJson,
      ...safeConnection
    } = connection;
    return {
      ...safeConnection,
      ...runtimeCounts(connection),
      credentialBinding: bindingSummary(
        connection.credentialBindingId ? bindings.get(connection.credentialBindingId) : undefined,
      ),
    };
  });
}

function listConnections(query: z.infer<typeof listConnectionsQuerySchema>): DecoratedConnection[] {
  const connections = listScriptConnections({
    includeDisabled: true,
    allScopes: true,
    kind: query.kind as ScriptConnectionKind | undefined,
  }).filter((connection) => {
    if (query.scope && connection.scope !== query.scope) return false;
    if (query.scopeId && connection.scopeId !== query.scopeId) return false;
    return true;
  });
  return decorateConnections(connections);
}

function connectionScopeId(
  scope: "global" | "agent" | "repo" | undefined,
  scopeId?: string | null,
  subject = "connections",
) {
  return resolveScopedResourceId(scope, scopeId, subject);
}

function validateCredentialTemplate(input: {
  configKey: string;
  headerTemplate?: string;
  queryTemplate?: string;
  requireTemplate?: boolean;
}) {
  if (input.requireTemplate && !input.headerTemplate && !input.queryTemplate) {
    throw new Error("At least one of headerTemplate or queryTemplate is required.");
  }
  const placeholder = placeholderForConfigKey(input.configKey);
  if (input.headerTemplate && !input.headerTemplate.includes(placeholder)) {
    throw new Error(`headerTemplate must include ${placeholder}.`);
  }
  if (input.queryTemplate && !input.queryTemplate.includes(placeholder)) {
    throw new Error(`queryTemplate must include ${placeholder}.`);
  }
}

function maybeCreateInlineBinding(
  data: z.infer<typeof upsertConnectionBodySchema>,
  resolvedScope?: "global" | "agent" | "repo",
  resolvedScopeId?: string | null,
) {
  if (data.credentialBindingId || !data.configKey) return data.credentialBindingId ?? null;

  const scope = resolvedScope ?? data.scope ?? "global";
  const scopeId =
    resolvedScopeId !== undefined
      ? resolvedScopeId
      : connectionScopeId(scope, data.scopeId, "bindings");
  const allowedHosts =
    data.allowedHosts ??
    ("baseUrl" in data && data.baseUrl ? [new URL(data.baseUrl).hostname] : []);
  const authKind = data.authKind ?? "config";
  const placeholder = placeholderForConfigKey(data.configKey);
  const headerTemplate =
    data.headerTemplate ??
    (data.queryTemplate ? undefined : `Authorization: Bearer ${placeholder}`);

  validateCredentialTemplate({
    configKey: data.configKey,
    headerTemplate,
    queryTemplate: data.queryTemplate,
  });
  if (authKind === "oauth" && !data.oauthAuthorizationId) {
    throw new Error("oauthAuthorizationId is required for oauth credential bindings.");
  }

  return upsertCredentialBinding({
    configKey: data.configKey,
    allowedHosts,
    headerTemplate,
    queryTemplate: data.queryTemplate,
    scope,
    scopeId,
    active: true,
    authKind,
    oauthAuthorizationId: data.oauthAuthorizationId ?? null,
  }).id;
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseScopes(scopes: string): string[] {
  try {
    const parsed = JSON.parse(scopes);
    if (Array.isArray(parsed)) {
      return parsed.filter((scope): scope is string => typeof scope === "string");
    }
  } catch {
    // Provider adapters accepted comma-delimited scopes before migration 117.
  }
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** Sanitized view of an authorization — never includes token material. */
function sanitizeAuthorization(authorization: OAuthAuthorization) {
  return {
    id: authorization.id,
    label: authorization.label,
    accountEmail: authorization.accountEmail,
    status: authorization.status,
    expiresAt: authorization.expiresAt,
    scope: authorization.scope,
    hasRefreshToken: authorization.refreshToken != null && authorization.refreshToken !== "",
    lastRefreshedAt: authorization.lastRefreshedAt,
    createdAt: authorization.createdAt,
    updatedAt: authorization.updatedAt,
  };
}

function sanitizeOAuthApp(row: OAuthAppRow) {
  const extraParamsObject = parseMetadata(row.extraParamsJson);
  const extraParams = Object.fromEntries(
    Object.entries(extraParamsObject).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    id: row.id,
    provider: row.provider,
    clientId: row.clientId,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    redirectUri: row.redirectUri,
    scopes: parseScopes(row.scopes),
    ...(Object.keys(extraParams).length > 0 ? { extraParams } : {}),
    tokenAuthStyle: row.tokenAuthStyle,
    tokenBodyFormat: row.tokenBodyFormat,
    tokenStatus: row.authorizationId ? getOAuthBindingTokenStatus(row.authorizationId) : "missing",
    expiresAt: row.tokenExpiresAt,
    lastRefreshedAt: normalizeDate(row.tokenUpdatedAt),
    authorizations: listAuthorizationsForApp(row.id).map(sanitizeAuthorization),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listOAuthApps() {
  const rows = getDb()
    .prepare<OAuthAppRow, []>(
      `SELECT a.id, a.provider, a.clientId, a.authorizeUrl, a.tokenUrl, a.redirectUri,
              a.scopes, a.extraParamsJson, a.tokenAuthStyle, a.tokenBodyFormat,
              z.id AS authorizationId, z.expiresAt AS tokenExpiresAt,
              z.updatedAt AS tokenUpdatedAt, a.createdAt, a.updatedAt
       FROM oauth_apps a
       LEFT JOIN oauth_authorizations z ON z.appId = a.id AND z.label = 'default'
       WHERE a.mcpServerId IS NULL
       ORDER BY a.provider ASC`,
    )
    .all();
  return rows.map(sanitizeOAuthApp);
}

/**
 * Best-effort RFC 7009 token revocation. Returns true when a revocation
 * request was attempted (a revocationUrl is configured), false otherwise.
 * Network/HTTP failures are logged (scrubbed) and never fail the caller.
 */
async function attemptRemoteRevocation(app: OAuthApp, accessToken: string): Promise<boolean> {
  const revocationUrl = app.revocationUrl ?? undefined;
  if (!revocationUrl) return false;

  const body = new URLSearchParams({
    token: accessToken,
    token_type_hint: "access_token",
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (app.tokenAuthStyle === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", app.clientId);
    body.set("client_secret", app.clientSecret);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(revocationUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn(
      scrubSecrets(
        `OAuth token revocation request failed for provider ${app.provider}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
  return true;
}

function oauthDiscoveryUrls(inputUrl: string): string[] {
  const parsed = new URL(inputUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const base = `${parsed.origin}${pathname === "/" ? "" : pathname}`;
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
    parsed.toString(),
  ].filter((url, index, urls) => urls.indexOf(url) === index);
}

async function fetchJsonMetadata(url: string, signal: AbortSignal): Promise<unknown> {
  let current = assertUrlSafe(url, publicEndpointSsrfOptions());
  let response: Response | null = null;
  for (let hop = 0; hop <= 5; hop += 1) {
    response = await fetch(current, {
      headers: { accept: "application/json" },
      signal,
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400 || response.status === 304) break;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`HTTP ${response.status} redirect missing Location header`);
    }
    current = assertUrlSafe(new URL(location, current).toString(), publicEndpointSsrfOptions());
    if (hop === 5) throw new Error("OAuth discovery exceeded 5 redirects.");
  }
  if (!response) throw new Error("OAuth discovery failed before receiving a response.");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Response was not JSON.");
  }
}

function extractOAuthDiscovery(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (
    typeof record.authorization_endpoint !== "string" ||
    typeof record.token_endpoint !== "string"
  ) {
    return null;
  }
  const scopes = Array.isArray(record.scopes_supported)
    ? record.scopes_supported.filter((scope): scope is string => typeof scope === "string")
    : [];
  return {
    authorizeUrl: record.authorization_endpoint,
    tokenUrl: record.token_endpoint,
    scopes,
  };
}

async function discoverOAuthApp(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const failures: string[] = [];
  try {
    for (const candidate of oauthDiscoveryUrls(url)) {
      try {
        const metadata = await fetchJsonMetadata(candidate, controller.signal);
        const discovered = extractOAuthDiscovery(metadata);
        if (discovered) {
          assertOAuthAppUrlsSafe(discovered);
          return { ...discovered, sourceUrl: candidate };
        }
        failures.push(`${candidate}: missing authorization_endpoint or token_endpoint`);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("OAuth discovery timed out after 10s.");
        }
        if (isUrlSafetyError(error)) throw error;
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`OAuth discovery failed. ${failures.join(" ")}`);
}

function isUrlSafetyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("Refusing ") ||
    error.message.startsWith("Invalid URL:") ||
    error.message.startsWith("Missing hostname:")
  );
}

function stringFromCatalogEntry(entry: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function stringArrayFromCatalogEntry(entry: Record<string, unknown>, key: string): string[] {
  const value = entry[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeCatalogEntry(entry: unknown): IntegrationsCatalogEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const kind = stringFromCatalogEntry(record, ["kind", "type"]);
  if (!kind || kind === "cli") return null;
  const slug = stringFromCatalogEntry(record, ["slug", "id", "name"]);
  const name = stringFromCatalogEntry(record, ["name", "title"]) || slug;
  const domain = stringFromCatalogEntry(record, ["domain", "hostname"]);
  return {
    id: stringFromCatalogEntry(record, ["id", "slug"]) || slug || name,
    kind,
    slug,
    name,
    description: stringFromCatalogEntry(record, ["description", "summary"]),
    url: stringFromCatalogEntry(record, ["url", "homepage", "baseUrl"]),
    icon: stringFromCatalogEntry(record, ["icon", "logo"]) || null,
    domain,
    categories: stringArrayFromCatalogEntry(record, "categories"),
    feeds: stringArrayFromCatalogEntry(record, "feeds"),
  };
}

function catalogEntriesFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["entries", "integrations", "data", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

async function fetchIntegrationsCatalog() {
  const now = Date.now();
  if (integrationsCatalogCache && integrationsCatalogCache.expiresAtMs > now) {
    return integrationsCatalogCache.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTEGRATIONS_CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch("https://integrations.sh/api.json", {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`integrations.sh returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const entries = catalogEntriesFromPayload(payload)
      .map(normalizeCatalogEntry)
      .filter((entry): entry is IntegrationsCatalogEntry => Boolean(entry));
    const cachedAt = new Date().toISOString();
    integrationsCatalogCache = {
      expiresAtMs: now + INTEGRATIONS_CATALOG_TTL_MS,
      payload: { entries, cachedAt },
    };
    return integrationsCatalogCache.payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Timed out fetching integrations catalog after 15s.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mergeBlessedCatalogEntries(
  entries: IntegrationsCatalogEntry[],
): IntegrationsCatalogEntry[] {
  const blessedDomains = new Set(
    BLESSED_CATALOG_ENTRIES.map((entry) => entry.domain.toLowerCase()),
  );
  return [
    ...BLESSED_CATALOG_ENTRIES,
    ...entries.filter((entry) => !blessedDomains.has(entry.domain.toLowerCase())),
  ];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

// Trim the upstream surface payload to what the Add Connection flow needs.
// CLI surfaces are dropped (connections are http/mcp only) and the credentials
// map is narrowed to ids referenced by the retained surfaces.
function trimSurfacePayload(domain: string, payload: unknown): IntegrationsSurfacePayload {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const rawSurfaces = Array.isArray(record.surfaces) ? record.surfaces : [];
  const surfaces: IntegrationsSurfaceEntry[] = [];
  const referencedCredentialIds = new Set<string>();

  for (const raw of rawSurfaces) {
    if (!raw || typeof raw !== "object") continue;
    const surface = raw as Record<string, unknown>;
    const type = typeof surface.type === "string" ? surface.type : "";
    if (type !== "http" && type !== "mcp") continue;

    const auth = (surface.auth && typeof surface.auth === "object" ? surface.auth : {}) as Record<
      string,
      unknown
    >;
    const entries = Array.isArray(auth.entries) ? auth.entries : [];
    const credentialIds: string[] = [];
    let mechanics: IntegrationsSurfaceMechanics | null = null;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const uses = Array.isArray((entry as Record<string, unknown>).use)
        ? ((entry as Record<string, unknown>).use as unknown[])
        : [];
      for (const use of uses) {
        if (!use || typeof use !== "object") continue;
        const useRecord = use as Record<string, unknown>;
        const id = typeof useRecord.id === "string" ? useRecord.id : "";
        if (id && !credentialIds.includes(id)) credentialIds.push(id);
        const rawMechanics = (
          useRecord.mechanics && typeof useRecord.mechanics === "object" ? useRecord.mechanics : {}
        ) as Record<string, unknown>;
        const mechanicsIn = typeof rawMechanics.in === "string" ? rawMechanics.in : "";
        // Prefer the first header mechanics (that is what the credential
        // header-template prefill can use); fall back to any positioned use.
        if (
          mechanicsIn &&
          (!mechanics || (mechanics.in !== "header" && mechanicsIn === "header"))
        ) {
          mechanics = {
            in: mechanicsIn,
            headerName: stringOrNull(rawMechanics.headerName),
            scheme: stringOrNull(rawMechanics.scheme),
          };
        }
      }
    }
    for (const id of credentialIds) referencedCredentialIds.add(id);
    surfaces.push({
      type,
      name: typeof surface.name === "string" ? surface.name : "",
      url: stringOrNull(surface.url),
      docs: stringOrNull(surface.docs),
      spec: stringOrNull(surface.spec),
      auth: { required: auth.status === "required", credentialIds, mechanics },
    });
  }

  const rawCredentials = (
    record.credentials && typeof record.credentials === "object" ? record.credentials : {}
  ) as Record<string, unknown>;
  const credentials: Record<string, IntegrationsSurfaceCredential> = {};
  for (const [id, raw] of Object.entries(rawCredentials)) {
    if (!referencedCredentialIds.has(id) || !raw || typeof raw !== "object") continue;
    const credential = raw as Record<string, unknown>;
    credentials[id] = {
      type: typeof credential.type === "string" ? credential.type : "unknown",
      label: typeof credential.label === "string" ? credential.label : id,
      generateUrl: stringOrNull(credential.generateUrl),
      setup: stringOrNull(credential.setup),
    };
  }

  return {
    domain: typeof record.domain === "string" && record.domain ? record.domain : domain,
    summary: typeof record.summary === "string" ? record.summary : "",
    surfaces,
    credentials,
  };
}

async function fetchIntegrationsSurface(domain: string): Promise<IntegrationsSurfacePayload> {
  const cacheKey = domain.toLowerCase();
  const now = Date.now();
  const cached = integrationsSurfaceCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.payload;
  integrationsSurfaceCache.delete(cacheKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTEGRATIONS_CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://integrations.sh/api/${encodeURIComponent(cacheKey)}/surface`,
      { headers: { accept: "application/json" }, signal: controller.signal },
    );
    if (response.status === 404) {
      throw new SurfaceNotFoundError(`No integration surface found for ${domain}.`);
    }
    if (!response.ok) {
      throw new Error(`integrations.sh returned HTTP ${response.status}`);
    }
    const payload = trimSurfacePayload(cacheKey, (await response.json()) as unknown);
    if (integrationsSurfaceCache.size >= INTEGRATIONS_SURFACE_CACHE_MAX_ENTRIES) {
      const oldestKey = integrationsSurfaceCache.keys().next().value;
      if (oldestKey !== undefined) integrationsSurfaceCache.delete(oldestKey);
    }
    integrationsSurfaceCache.set(cacheKey, {
      expiresAtMs: now + INTEGRATIONS_CATALOG_TTL_MS,
      payload,
    });
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Timed out fetching integration surface after 15s.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function deleteOAuthApp(provider: string): boolean {
  const existing = getOAuthApp(provider);
  if (!existing) return false;
  const tx = getDb().transaction(() => {
    deleteOAuthTokens(provider);
    getDb().query("DELETE FROM oauth_apps WHERE id = ?").run(existing.id);
  });
  tx();
  return true;
}

async function refreshHttpConnection(
  id: string,
  userId: string | null,
  agentId: string | undefined,
): Promise<ScriptConnectionRecord | null> {
  return refreshScriptConnection(id, userId, agentId);
}

export async function handleScriptConnections(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (listConnectionsRoute.match(req.method, pathSegments)) {
    const parsed = await listConnectionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    json(res, { connections: listConnections(parsed.query) });
    return true;
  }

  if (getConnectionRoute.match(req.method, pathSegments)) {
    const parsed = await getConnectionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const connection =
      listScriptConnections({ includeDisabled: true, allScopes: true }).find(
        (candidate) => candidate.id === parsed.params.id,
      ) ?? null;
    if (!connection) {
      jsonError(res, "Script connection not found.", 404);
      return true;
    }
    json(res, { connection: connectionDetail(connection) });
    return true;
  }

  if (upsertConnectionRoute.match(req.method, pathSegments)) {
    const parsed = await upsertConnectionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;

    try {
      if (
        parsed.body.kind === "openapi" &&
        [parsed.body.openapiSpecJson, parsed.body.openapiSpecUrl, parsed.body.specSource].filter(
          Boolean,
        ).length > 1
      ) {
        jsonError(res, "Provide exactly one OpenAPI spec source.", 400);
        return true;
      }
      const existingConnection = parsed.body.id ? getScriptConnectionById(parsed.body.id) : null;
      const existingOpenapiConnection =
        existingConnection?.kind === "openapi" ? existingConnection : null;
      if (
        parsed.body.kind === "openapi" &&
        !parsed.body.openapiSpecJson &&
        !parsed.body.openapiSpecUrl &&
        !parsed.body.specSource &&
        !existingOpenapiConnection
      ) {
        jsonError(res, "Provide exactly one OpenAPI spec source.", 400);
        return true;
      }

      const scopeWasProvided = Object.hasOwn(parsed.body, "scope");
      const scopeIdWasProvided = Object.hasOwn(parsed.body, "scopeId");
      const enabledWasProvided = Object.hasOwn(parsed.body, "enabled");
      const scope = (scopeWasProvided ? parsed.body.scope : existingConnection?.scope) ?? "global";
      const scopeIdInput = scopeIdWasProvided
        ? parsed.body.scopeId
        : existingConnection && scope === existingConnection.scope
          ? existingConnection.scopeId
          : null;
      const scopeId = connectionScopeId(scope, scopeIdInput);
      const enabled = enabledWasProvided
        ? parsed.body.enabled !== false
        : (existingConnection?.enabled ?? true);
      const credentialBindingId = maybeCreateInlineBinding(parsed.body, scope, scopeId);
      const userId = resolveHttpAuditUserId(req, agentId);
      const openapiSpecUrl =
        parsed.body.kind === "openapi" ? parsed.body.openapiSpecUrl : undefined;
      const openapiSpecJson =
        parsed.body.kind === "openapi" ? parsed.body.openapiSpecJson : undefined;
      const vendoredSpecSource =
        parsed.body.kind === "openapi" ? parsed.body.specSource : undefined;
      const openapiSpecUrlChanged =
        parsed.body.kind === "openapi" &&
        Boolean(openapiSpecUrl) &&
        openapiSpecUrl !== existingOpenapiConnection?.openapiSpecSource;
      const reuseExistingOpenapiSpec =
        parsed.body.kind === "openapi" &&
        Boolean(existingOpenapiConnection) &&
        openapiSpecJson === undefined &&
        !openapiSpecUrlChanged;

      const connection = await upsertScriptConnection({
        id: parsed.body.id,
        slug: parsed.body.slug,
        displayName: parsed.body.displayName,
        kind: parsed.body.kind,
        scope,
        scopeId,
        baseUrl: "baseUrl" in parsed.body ? parsed.body.baseUrl : undefined,
        allowedHosts: parsed.body.allowedHosts,
        credentialBindingId,
        openapiSpecSourceKind: vendoredSpecSource
          ? "vendored"
          : reuseExistingOpenapiSpec && !openapiSpecUrl
            ? existingOpenapiConnection?.openapiSpecSourceKind
            : undefined,
        openapiSpecSource:
          vendoredSpecSource?.slug ??
          (reuseExistingOpenapiSpec && !openapiSpecUrl
            ? existingOpenapiConnection?.openapiSpecSource
            : undefined),
        openapiSpecUrl,
        openapiSpecJson:
          parsed.body.kind === "openapi"
            ? (openapiSpecJson ??
              (reuseExistingOpenapiSpec
                ? (existingOpenapiConnection?.openapiSpecJson ?? undefined)
                : undefined))
            : undefined,
        openapiSpecEtag: reuseExistingOpenapiSpec
          ? existingOpenapiConnection?.openapiSpecEtag
          : undefined,
        openapiSpecFetchedAt: reuseExistingOpenapiSpec
          ? existingOpenapiConnection?.openapiSpecFetchedAt
          : undefined,
        mcpServerId: parsed.body.kind === "mcp" ? parsed.body.mcpServerId : null,
        enabled,
        agentId,
        userId,
      });

      json(res, { connection: decorateConnections([connection])[0] });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (refreshConnectionRoute.match(req.method, pathSegments)) {
    const parsed = await refreshConnectionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;
    try {
      const refreshed = await refreshHttpConnection(
        parsed.params.id,
        resolveHttpAuditUserId(req, agentId),
        agentId,
      );
      if (!refreshed) {
        jsonError(res, "Script connection not found.", 404);
        return true;
      }
      json(res, { connection: decorateConnections([refreshed])[0] });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (setConnectionEnabledRoute.match(req.method, pathSegments)) {
    const parsed = await setConnectionEnabledRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;
    const updated = setScriptConnectionEnabled(
      parsed.params.id,
      parsed.body.enabled,
      resolveHttpAuditUserId(req, agentId),
    );
    if (!updated) {
      jsonError(res, "Script connection not found.", 404);
      return true;
    }
    json(res, { connection: decorateConnections([updated])[0] });
    return true;
  }

  if (listCredentialBindingsRoute.match(req.method, pathSegments)) {
    json(res, {
      bindings: listRelationalCredentialBindings({ includeInactive: true }).map(decorateBinding),
    });
    return true;
  }

  if (upsertCredentialBindingRoute.match(req.method, pathSegments)) {
    const parsed = await upsertCredentialBindingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;

    try {
      const scope = parsed.body.scope ?? "global";
      const scopeId = connectionScopeId(scope, parsed.body.scopeId, "bindings");
      if (!parsed.body.headerTemplate && !parsed.body.queryTemplate) {
        jsonError(res, "At least one of headerTemplate or queryTemplate is required.", 400);
        return true;
      }
      if ((parsed.body.authKind ?? "config") === "oauth" && !parsed.body.oauthAuthorizationId) {
        jsonError(res, "oauthAuthorizationId is required for oauth credential bindings.", 400);
        return true;
      }
      validateCredentialTemplate({
        configKey: parsed.body.configKey,
        headerTemplate: parsed.body.headerTemplate,
        queryTemplate: parsed.body.queryTemplate,
        requireTemplate: true,
      });
      const nextBinding = CredentialBindingSchema.parse({
        configKey: parsed.body.configKey,
        allowedHosts: parsed.body.allowedHosts,
        headerTemplate: parsed.body.headerTemplate,
        queryTemplate: parsed.body.queryTemplate,
        scope,
        scopeId,
        active: parsed.body.active ?? true,
        authKind: parsed.body.authKind ?? "config",
        oauthAuthorizationId: parsed.body.oauthAuthorizationId,
      });
      const binding = upsertCredentialBinding({
        id: parsed.body.id,
        configKey: nextBinding.configKey,
        allowedHosts: nextBinding.allowedHosts,
        headerTemplate: nextBinding.headerTemplate,
        queryTemplate: nextBinding.queryTemplate,
        scope: nextBinding.scope,
        scopeId: nextBinding.scopeId ?? null,
        active: nextBinding.active,
        authKind: nextBinding.authKind,
        oauthAuthorizationId: nextBinding.oauthAuthorizationId ?? null,
        userId: resolveHttpAuditUserId(req, agentId),
      });
      json(res, { binding: decorateBinding(binding) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (listOAuthAppsRoute.match(req.method, pathSegments)) {
    json(res, { oauthApps: listOAuthApps() });
    return true;
  }

  if (upsertOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await upsertOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAppAdmin(req, res, agentId)) return true;

    try {
      assertOAuthProviderIsNotReserved(parsed.body.provider);
      assertOAuthAppUrlsSafe(parsed.body);
      const existing = getOAuthApp(parsed.body.provider);
      const clientSecret = parsed.body.clientSecret ?? existing?.clientSecret;
      if (!clientSecret) {
        jsonError(res, "clientSecret is required when creating a new OAuth app.", 400);
        return true;
      }

      // All flows now redirect to the single static callback.
      const redirectUri = staticOAuthCallbackUri();
      upsertOAuthApp(parsed.body.provider, {
        clientId: parsed.body.clientId,
        clientSecret,
        authorizeUrl: parsed.body.authorizeUrl,
        tokenUrl: parsed.body.tokenUrl,
        redirectUri,
        scopes: (parsed.body.scopes ?? []).join(","),
        ...(parsed.body.extraParams ? { extraParams: parsed.body.extraParams } : {}),
        ...(parsed.body.tokenAuthStyle ? { tokenAuthStyle: parsed.body.tokenAuthStyle } : {}),
        ...(parsed.body.tokenBodyFormat ? { tokenBodyFormat: parsed.body.tokenBodyFormat } : {}),
      });
      const app = listOAuthApps().find((row) => row.provider === parsed.body.provider);
      json(res, { oauthApp: app });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (discoverOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await discoverOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAppAdmin(req, res, agentId)) return true;
    try {
      const discovered = await discoverOAuthApp(parsed.body.url);
      json(res, discovered);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (deleteOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await deleteOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAppAdmin(req, res, agentId)) return true;
    if (!deleteOAuthApp(parsed.params.provider)) {
      jsonError(res, `OAuth app ${parsed.params.provider} not found.`, 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  if (listAuthorizationsRoute.match(req.method, pathSegments)) {
    const parsed = await listAuthorizationsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const app = getOAuthAppById(parsed.params.id);
    if (!app || app.mcpServerId !== null) {
      jsonError(res, `OAuth app ${parsed.params.id} not found.`, 404);
      return true;
    }
    json(res, {
      authorizations: listAuthorizationsForApp(app.id).map(sanitizeAuthorization),
    });
    return true;
  }

  if (authorizeUrlRoute.match(req.method, pathSegments)) {
    const parsed = await authorizeUrlRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAuthorizationAdmin(req, res, agentId)) return true;

    const app = getOAuthAppById(parsed.params.id);
    if (!app || app.mcpServerId !== null) {
      jsonError(res, `OAuth app ${parsed.params.id} is not configured.`, 404);
      return true;
    }
    const label = parsed.body?.label ?? "default";
    // Every authorization redirects to the single static callback.
    const config = { ...oauthAppToProviderConfig(app), redirectUri: staticOAuthCallbackUri() };
    try {
      const result = await buildAuthorizationUrl(config, {
        appId: app.id,
        label,
        flow: "generic",
        ...(parsed.body?.finalRedirect ? { finalRedirect: parsed.body.finalRedirect } : {}),
        userId: resolveHttpAuditUserId(req, agentId),
      });
      json(res, {
        authorizeUrl: result.url,
        state: result.state,
        label,
        redirectUri: config.redirectUri,
      });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err), 400);
    }
    return true;
  }

  if (deleteAuthorizationRoute.match(req.method, pathSegments)) {
    const parsed = await deleteAuthorizationRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAuthorizationAdmin(req, res, agentId)) return true;

    const authorization = getAuthorizationById(parsed.params.id);
    if (!authorization) {
      jsonError(res, `Authorization ${parsed.params.id} not found.`, 404);
      return true;
    }
    const app = getOAuthAppById(authorization.appId);
    let revocationAttempted = false;
    if (app && authorization.accessToken && authorization.status !== "revoked") {
      revocationAttempted = await attemptRemoteRevocation(app, authorization.accessToken);
    }
    deleteAuthorizationById(authorization.id);
    json(res, { deleted: true, revocationAttempted });
    return true;
  }

  if (refreshAuthorizationRoute.match(req.method, pathSegments)) {
    const parsed = await refreshAuthorizationRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAuthorizationAdmin(req, res, agentId)) return true;

    const authorization = getAuthorizationById(parsed.params.id);
    if (!authorization) {
      jsonError(res, `Authorization ${parsed.params.id} not found.`, 404);
      return true;
    }
    const app = getOAuthAppById(authorization.appId);
    if (!app || app.mcpServerId !== null) {
      jsonError(res, `Authorization ${parsed.params.id} not found.`, 404);
      return true;
    }
    if (!authorization.refreshToken) {
      jsonError(res, "Authorization has no refresh token stored.", 400);
      return true;
    }
    try {
      const config = oauthAppToProviderConfig(app);
      const tokens = await refreshTokenGrant(config, authorization.refreshToken);
      const expiresAt = tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const updated = updateAuthorizationTokens(authorization.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? authorization.refreshToken,
        expiresAt,
        ...(tokens.scope != null ? { scope: tokens.scope } : {}),
        expectedTokenVersion: authorization.tokenVersion,
      });
      if (!updated) {
        jsonError(res, "Authorization changed during refresh; retry.", 409);
        return true;
      }
      json(res, { ok: true, status: updated.status, expiresAt: updated.expiresAt });
    } catch (err) {
      jsonError(res, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    return true;
  }

  if (integrationsCatalogRoute.match(req.method, pathSegments)) {
    try {
      const catalog = await fetchIntegrationsCatalog();
      json(res, {
        ...catalog,
        entries: mergeBlessedCatalogEntries(catalog.entries),
        partial: false,
      });
    } catch (err) {
      if (BLESSED_CATALOG_ENTRIES.length > 0) {
        json(res, {
          entries: BLESSED_CATALOG_ENTRIES,
          cachedAt: new Date().toISOString(),
          partial: true,
        });
      } else {
        jsonError(
          res,
          `Failed to fetch integrations catalog: ${err instanceof Error ? err.message : String(err)}`,
          502,
        );
      }
    }
    return true;
  }

  if (integrationsSurfaceRoute.match(req.method, pathSegments)) {
    const parsed = await integrationsSurfaceRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      json(res, await fetchIntegrationsSurface(parsed.params.domain));
    } catch (err) {
      if (err instanceof SurfaceNotFoundError) {
        jsonError(res, err.message, 404);
        return true;
      }
      jsonError(
        res,
        `Failed to fetch integration surface: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    return true;
  }

  if (disconnectOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await disconnectOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAppAdmin(req, res, agentId)) return true;

    const app = getOAuthApp(parsed.params.provider);
    if (!app) {
      jsonError(res, `OAuth app ${parsed.params.provider} is not configured.`, 404);
      return true;
    }
    const tokens = getOAuthTokens(parsed.params.provider);
    if (!tokens) {
      json(res, { disconnected: false, message: "no stored tokens" });
      return true;
    }
    const revocationAttempted = await attemptRemoteRevocation(app, tokens.accessToken);
    deleteOAuthTokens(parsed.params.provider);
    json(res, { disconnected: true, revocationAttempted });
    return true;
  }

  if (refreshOAuthAppTokensRoute.match(req.method, pathSegments)) {
    const parsed = await refreshOAuthAppTokensRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOAuthAppAdmin(req, res, agentId)) return true;

    const provider = parsed.params.provider;
    if (!getOAuthApp(provider)) {
      jsonError(res, `OAuth app ${provider} is not configured.`, 404);
      return true;
    }
    const tokens = getOAuthTokens(provider);
    if (!tokens) {
      jsonError(res, "Nothing to refresh — authorize first.", 400);
      return true;
    }
    if (!tokens.refreshToken) {
      jsonError(
        res,
        `OAuth app ${provider} does not support refresh (no refresh token stored).`,
        400,
      );
      return true;
    }

    try {
      await forceRefreshTokenOrThrow(provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, scrubSecrets(`Token refresh failed: ${message}`), 502);
      return true;
    }

    json(res, {
      refreshed: true,
      tokenStatus: getOAuthBindingTokenStatus(tokens.id),
      expiresAt: getOAuthTokens(provider)?.expiresAt ?? null,
    });
    return true;
  }

  return false;
}
