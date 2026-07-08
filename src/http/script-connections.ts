import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "@/be/audit-user";
import { getAgentById, getDb } from "@/be/db";
import {
  deleteOAuthTokens,
  getOAuthApp,
  getOAuthTokens,
  upsertOAuthApp,
} from "@/be/db-queries/oauth";
import {
  getOAuthBindingTokenStatus,
  getOAuthProviderConfig,
  type OAuthBindingTokenStatus,
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
import { buildAuthorizationUrl } from "@/oauth/wrapper";
import { can } from "@/rbac";
import {
  CredentialBindingSchema,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import type { OAuthApp } from "@/tracker/types";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { getRequestAuth } from "@/utils/request-auth-context";
import { scrubSecrets } from "@/utils/secret-scrubber";
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

const listConnectionsQuerySchema = z.object({
  kind: connectionKindSchema.optional(),
  scope: scopeSchema.optional(),
  scopeId: z.string().optional(),
});

const connectionBaseBodySchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().min(1).max(80),
  displayName: z.string().max(160).optional(),
  scope: scopeSchema.default("global").optional(),
  scopeId: z.string().uuid().nullable().optional(),
  allowedHosts: z.array(z.string().min(1)).optional(),
  credentialBindingId: z.string().uuid().nullable().optional(),
  configKey: z.string().min(1).max(255).optional(),
  headerTemplate: z.string().min(1).optional(),
  queryTemplate: z.string().min(1).optional(),
  authKind: z.enum(["config", "oauth"]).default("config").optional(),
  oauthProvider: providerSchema.optional(),
  enabled: z.boolean().default(true).optional(),
});

const upsertConnectionBodySchema = z.discriminatedUnion("kind", [
  connectionBaseBodySchema.extend({
    kind: z.literal("openapi"),
    baseUrl: z.string().url(),
    openapiSpecUrl: z.string().url().optional(),
    openapiSpecJson: z.string().optional(),
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
  scopeId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true).optional(),
  authKind: z.enum(["config", "oauth"]).default("config").optional(),
  oauthProvider: providerSchema.optional(),
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
  rbac: { permission: "script-connection.manage" },
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
  rbac: { permission: "script-connection.manage" },
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
  rbac: { permission: "script-connection.manage" },
});

const authorizeUrlRoute = route({
  method: "post",
  path: "/api/oauth-apps/{provider}/authorize-url",
  pattern: ["api", "oauth-apps", null, "authorize-url"],
  operationId: "oauth_apps_authorize_url",
  summary: "Build an OAuth authorization URL",
  tags: ["Script Connections"],
  params: providerParamsSchema,
  responses: {
    200: { description: "OAuth authorization URL" },
    403: { description: "Only the lead agent can manage script connections" },
    404: { description: "OAuth app not found" },
  },
  rbac: { permission: "script-connection.manage" },
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
  rbac: { permission: "script-connection.manage" },
});

type BindingSummary = {
  id: string;
  configKey: string;
  authKind: "config" | "oauth";
  oauthProvider?: string;
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

type ConnectionDetail = DecoratedConnection & {
  operations: Array<{ name: string; method: string; path: string }>;
  tools: Array<{ name: string; description?: string }>;
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
  metadata: string;
  tokenExpiresAt: string | null;
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
};

const DISCOVERY_TIMEOUT_MS = 10_000;
const INTEGRATIONS_CATALOG_TIMEOUT_MS = 15_000;
const INTEGRATIONS_CATALOG_TTL_MS = 60 * 60 * 1000;
const SPEC_PREVIEW_MAX_BYTES = 50 * 1024;

let integrationsCatalogCache: {
  expiresAtMs: number;
  payload: { entries: IntegrationsCatalogEntry[]; cachedAt: string };
} | null = null;

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

function tokenStatusForBinding(
  binding: ScriptCredentialBindingRecord,
): OAuthBindingTokenStatus | undefined {
  return binding.authKind === "oauth" && binding.oauthProvider
    ? getOAuthBindingTokenStatus(binding.oauthProvider)
    : undefined;
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
    ...(binding.oauthProvider ? { oauthProvider: binding.oauthProvider } : {}),
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
) {
  return scope === "global" || !scope ? null : (scopeId ?? null);
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

function maybeCreateInlineBinding(data: z.infer<typeof upsertConnectionBodySchema>) {
  if (data.credentialBindingId || !data.configKey) return data.credentialBindingId ?? null;

  const scope = data.scope ?? "global";
  const scopeId = connectionScopeId(scope, data.scopeId);
  const allowedHosts =
    data.allowedHosts ?? ("baseUrl" in data ? [new URL(data.baseUrl).hostname] : []);
  const authKind = data.authKind ?? "config";
  const placeholder = placeholderForConfigKey(data.configKey);
  const headerTemplate = data.headerTemplate ?? `Authorization: Bearer ${placeholder}`;

  validateCredentialTemplate({
    configKey: data.configKey,
    headerTemplate,
    queryTemplate: data.queryTemplate,
  });
  if (authKind === "oauth" && !data.oauthProvider) {
    throw new Error("oauthProvider is required for oauth credential bindings.");
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
    oauthProvider: data.oauthProvider ?? null,
  }).id;
}

function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseScopes(scopes: string): string[] {
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function sanitizeOAuthApp(row: OAuthAppRow) {
  const metadata = parseMetadata(row.metadata);
  const extraParams =
    metadata.extraParams &&
    typeof metadata.extraParams === "object" &&
    !Array.isArray(metadata.extraParams)
      ? Object.fromEntries(
          Object.entries(metadata.extraParams as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    id: row.id,
    provider: row.provider,
    clientId: row.clientId,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    redirectUri: row.redirectUri,
    scopes: parseScopes(row.scopes),
    extraParams,
    tokenAuthStyle: metadata.tokenAuthStyle === "basic" ? "basic" : "body",
    tokenBodyFormat: metadata.tokenBodyFormat === "json" ? "json" : "form",
    tokenStatus: getOAuthBindingTokenStatus(row.provider),
    expiresAt: row.tokenExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listOAuthApps() {
  const rows = getDb()
    .prepare<OAuthAppRow, []>(
      `SELECT a.id, a.provider, a.clientId, a.authorizeUrl, a.tokenUrl, a.redirectUri,
              a.scopes, a.metadata, t.expiresAt AS tokenExpiresAt, a.createdAt, a.updatedAt
       FROM oauth_apps a
       LEFT JOIN oauth_tokens t ON t.provider = a.provider
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
  const metadata = parseMetadata(app.metadata);
  const revocationUrl =
    typeof metadata.revocationUrl === "string" ? metadata.revocationUrl : undefined;
  if (!revocationUrl) return false;

  const body = new URLSearchParams({
    token: accessToken,
    token_type_hint: "access_token",
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (metadata.tokenAuthStyle === "basic") {
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

function genericOAuthRedirectUri(provider: string): string {
  return `${getPublicMcpBaseUrl()}/api/oauth/${encodeURIComponent(provider)}/callback`;
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
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
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
        if (discovered) return { ...discovered, sourceUrl: candidate };
        failures.push(`${candidate}: missing authorization_endpoint or token_endpoint`);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("OAuth discovery timed out after 10s.");
        }
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`OAuth discovery failed. ${failures.join(" ")}`);
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

function deleteOAuthApp(provider: string): boolean {
  const existing = getOAuthApp(provider);
  if (!existing) return false;
  const tx = getDb().transaction(() => {
    deleteOAuthTokens(provider);
    getDb().query("DELETE FROM oauth_apps WHERE provider = ?").run(provider);
  });
  tx();
  return true;
}

async function refreshHttpConnection(
  id: string,
  userId: string | null,
  agentId: string | undefined,
): Promise<ScriptConnectionRecord | null> {
  const connection = getScriptConnectionById(id);
  if (!connection) return null;
  if (connection.kind !== "mcp") {
    return refreshScriptConnection(id, userId);
  }
  if (!connection.mcpServerId) {
    throw new Error("mcpServerId is required for MCP connections.");
  }
  return upsertScriptConnection({
    id: connection.id,
    slug: connection.slug,
    displayName: connection.displayName,
    kind: "mcp",
    scope: connection.scope,
    scopeId: connection.scopeId,
    mcpServerId: connection.mcpServerId,
    enabled: connection.enabled,
    agentId,
    userId,
  });
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
    const connection = getScriptConnectionById(parsed.params.id);
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
        Boolean(parsed.body.openapiSpecJson) &&
        Boolean(parsed.body.openapiSpecUrl)
      ) {
        jsonError(res, "Provide exactly one of openapiSpecJson or openapiSpecUrl.", 400);
        return true;
      }
      const existingConnection = parsed.body.id ? getScriptConnectionById(parsed.body.id) : null;
      if (
        parsed.body.kind === "openapi" &&
        !parsed.body.openapiSpecJson &&
        !parsed.body.openapiSpecUrl &&
        !existingConnection
      ) {
        jsonError(res, "Provide exactly one of openapiSpecJson or openapiSpecUrl.", 400);
        return true;
      }

      const credentialBindingId = maybeCreateInlineBinding(parsed.body);
      const scope = parsed.body.scope ?? "global";
      const scopeId = connectionScopeId(scope, parsed.body.scopeId);
      const userId = resolveHttpAuditUserId(req, agentId);

      const connection = await upsertScriptConnection({
        id: parsed.body.id,
        slug: parsed.body.slug,
        displayName: parsed.body.displayName,
        kind: parsed.body.kind,
        scope,
        scopeId,
        baseUrl: "baseUrl" in parsed.body ? parsed.body.baseUrl : null,
        allowedHosts:
          parsed.body.allowedHosts ??
          ("baseUrl" in parsed.body ? [new URL(parsed.body.baseUrl).hostname] : []),
        credentialBindingId,
        openapiSpecSourceKind:
          parsed.body.kind === "openapi" &&
          !parsed.body.openapiSpecJson &&
          !parsed.body.openapiSpecUrl
            ? existingConnection?.openapiSpecSourceKind
            : undefined,
        openapiSpecSource:
          parsed.body.kind === "openapi" &&
          !parsed.body.openapiSpecJson &&
          !parsed.body.openapiSpecUrl
            ? existingConnection?.openapiSpecSource
            : undefined,
        openapiSpecUrl: parsed.body.kind === "openapi" ? parsed.body.openapiSpecUrl : undefined,
        openapiSpecJson:
          parsed.body.kind === "openapi"
            ? (parsed.body.openapiSpecJson ?? existingConnection?.openapiSpecJson ?? undefined)
            : undefined,
        openapiSpecEtag:
          parsed.body.kind === "openapi" &&
          !parsed.body.openapiSpecJson &&
          !parsed.body.openapiSpecUrl
            ? existingConnection?.openapiSpecEtag
            : undefined,
        openapiSpecFetchedAt:
          parsed.body.kind === "openapi" &&
          !parsed.body.openapiSpecJson &&
          !parsed.body.openapiSpecUrl
            ? existingConnection?.openapiSpecFetchedAt
            : undefined,
        mcpServerId: parsed.body.kind === "mcp" ? parsed.body.mcpServerId : null,
        enabled: parsed.body.enabled !== false,
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
      const scopeId = connectionScopeId(scope, parsed.body.scopeId);
      if (scope !== "global" && !scopeId) {
        jsonError(res, `scopeId is required for ${scope} bindings.`, 400);
        return true;
      }
      if (!parsed.body.headerTemplate && !parsed.body.queryTemplate) {
        jsonError(res, "At least one of headerTemplate or queryTemplate is required.", 400);
        return true;
      }
      if ((parsed.body.authKind ?? "config") === "oauth" && !parsed.body.oauthProvider) {
        jsonError(res, "oauthProvider is required for oauth credential bindings.", 400);
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
        oauthProvider: parsed.body.oauthProvider,
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
        oauthProvider: nextBinding.oauthProvider ?? null,
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
    if (!ensureConnectionAdmin(req, res, agentId)) return true;

    const existing = getOAuthApp(parsed.body.provider);
    const clientSecret = parsed.body.clientSecret ?? existing?.clientSecret;
    if (!clientSecret) {
      jsonError(res, "clientSecret is required when creating a new OAuth app.", 400);
      return true;
    }

    const redirectUri = genericOAuthRedirectUri(parsed.body.provider);
    upsertOAuthApp(parsed.body.provider, {
      clientId: parsed.body.clientId,
      clientSecret,
      authorizeUrl: parsed.body.authorizeUrl,
      tokenUrl: parsed.body.tokenUrl,
      redirectUri,
      scopes: (parsed.body.scopes ?? []).join(","),
      ...(parsed.body.extraParams || parsed.body.tokenAuthStyle || parsed.body.tokenBodyFormat
        ? {
            metadata: JSON.stringify({
              ...(parsed.body.extraParams ? { extraParams: parsed.body.extraParams } : {}),
              ...(parsed.body.tokenAuthStyle ? { tokenAuthStyle: parsed.body.tokenAuthStyle } : {}),
              ...(parsed.body.tokenBodyFormat
                ? { tokenBodyFormat: parsed.body.tokenBodyFormat }
                : {}),
            }),
          }
        : {}),
    });
    const app = listOAuthApps().find((row) => row.provider === parsed.body.provider);
    json(res, { oauthApp: app });
    return true;
  }

  if (discoverOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await discoverOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;
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
    if (!ensureConnectionAdmin(req, res, agentId)) return true;
    if (!deleteOAuthApp(parsed.params.provider)) {
      jsonError(res, `OAuth app ${parsed.params.provider} not found.`, 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  if (authorizeUrlRoute.match(req.method, pathSegments)) {
    const parsed = await authorizeUrlRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;

    const config = getOAuthProviderConfig(parsed.params.provider);
    if (!config) {
      jsonError(res, `OAuth app ${parsed.params.provider} is not configured.`, 404);
      return true;
    }
    const result = await buildAuthorizationUrl(config);
    json(res, { authorizeUrl: result.url, redirectUri: config.redirectUri });
    return true;
  }

  if (integrationsCatalogRoute.match(req.method, pathSegments)) {
    try {
      json(res, await fetchIntegrationsCatalog());
    } catch (err) {
      jsonError(
        res,
        `Failed to fetch integrations catalog: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    return true;
  }

  if (disconnectOAuthAppRoute.match(req.method, pathSegments)) {
    const parsed = await disconnectOAuthAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureConnectionAdmin(req, res, agentId)) return true;

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

  return false;
}
