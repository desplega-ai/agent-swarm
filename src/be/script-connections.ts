import { z } from "zod";
import { getDb, upsertSwarmConfig } from "@/be/db";
import { getAuthorizationById, getOAuthAppById } from "@/be/db-queries/oauth";
import { assertUrlSafe, publicEndpointSsrfOptions } from "@/oauth/mcp-wrapper";
import type {
  ScriptApiConnectionDescriptor,
  ScriptApiJsonSchema,
  ScriptApiJsonValue,
  ScriptApiOperationDescriptor,
  ScriptMcpConnectionDescriptor,
  ScriptMcpToolDescriptor,
} from "@/scripts-runtime/api-types";
import {
  type CredentialBinding,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import { refreshSecretScrubberCache } from "@/utils/secret-scrubber";
import { listMcpServerTools } from "./mcp-proxy";
import { readVendoredOpenapiSpec } from "./vendored-openapi";

export type ScriptConnectionScope = "global" | "agent" | "repo";
export type ScriptConnectionKind = "raw" | "openapi" | "mcp" | "graphql";
export type ScriptConnectionBaseUrlSource = "user" | "spec";
export type ScriptConnectionAuthType = "none" | "bearer" | "header" | "query" | "oauth";

/**
 * Inline auth declared on a connection upsert. The connection owns a single
 * auto-managed credential binding derived from this intent; scripts never see
 * the raw secret (only the `[REDACTED:<key>]` placeholder substituted at the
 * fetch layer toward the connection's allowed hosts).
 */
export type ConnectionAuthInput =
  | { type: "none" }
  | {
      type: "bearer";
      secret?: string;
      configKey?: string;
      template?: string;
      hosts?: string[];
    }
  | {
      type: "header";
      headerName: string;
      secret?: string;
      configKey?: string;
      template?: string;
      hosts?: string[];
    }
  | {
      type: "query";
      paramName: string;
      secret?: string;
      configKey?: string;
      template?: string;
      hosts?: string[];
    }
  | {
      type: "oauth";
      authorizationId: string;
      configKey?: string;
      template?: string;
      hosts?: string[];
    };

export type ConnectionAuthSummary = {
  type: ScriptConnectionAuthType;
  configKey?: string;
  authorizationId?: string;
  paramName?: string;
};

const authHostsSchema = z.array(z.string().min(1)).optional();
const authSecretSchema = z.string().min(1).optional();
const authConfigKeySchema = z.string().min(1).max(255).optional();
const authTemplateSchema = z.string().min(1).optional();

/** Zod schema mirroring {@link ConnectionAuthInput} for HTTP + MCP tool bodies. */
export const ConnectionAuthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    secret: authSecretSchema,
    configKey: authConfigKeySchema,
    template: authTemplateSchema,
    hosts: authHostsSchema,
  }),
  z.object({
    type: z.literal("header"),
    headerName: z.string().min(1).max(255),
    secret: authSecretSchema,
    configKey: authConfigKeySchema,
    template: authTemplateSchema,
    hosts: authHostsSchema,
  }),
  z.object({
    type: z.literal("query"),
    paramName: z.string().min(1).max(255),
    secret: authSecretSchema,
    configKey: authConfigKeySchema,
    template: authTemplateSchema,
    hosts: authHostsSchema,
  }),
  z.object({
    type: z.literal("oauth"),
    authorizationId: z.string().min(1).max(255),
    configKey: authConfigKeySchema,
    template: authTemplateSchema,
    hosts: authHostsSchema,
  }),
]);

export type ScriptConnectionBaseUrlMismatch = {
  specUrl: string;
  effectiveUrl: string;
};

export type ScriptCredentialBindingRecord = CredentialBinding & {
  id: string;
  source: "default" | "user" | "migration" | "connection";
  managedByConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export type ScriptConnectionRecord = {
  id: string;
  slug: string;
  displayName: string | null;
  kind: ScriptConnectionKind;
  scope: ScriptConnectionScope;
  scopeId: string | null;
  baseUrl: string | null;
  baseUrlSource: ScriptConnectionBaseUrlSource;
  baseUrlMismatch?: ScriptConnectionBaseUrlMismatch;
  allowedHosts: string[];
  credentialBindingId: string | null;
  authType: ScriptConnectionAuthType;
  authConfigKey: string | null;
  authAuthorizationId: string | null;
  authParamName: string | null;
  authTemplateOverride: string | null;
  authHostsOverride: string[] | null;
  openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
  openapiSpecSource: string | null;
  openapiSpecJson: string | null;
  openapiSpecEtag: string | null;
  openapiSpecFetchedAt: string | null;
  mcpServerId: string | null;
  generatedTypes: string | null;
  generatedRuntimeJson: string | null;
  generatedAt: string | null;
  generationError: string | null;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

type BindingRow = {
  id: string;
  config_key: string;
  allowed_hosts_json: string;
  header_template: string | null;
  query_template: string | null;
  scope: string;
  scope_id: string | null;
  active: number;
  auth_kind: string;
  oauth_authorization_id: string | null;
  managed_by_connection_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

type ConnectionRow = {
  id: string;
  slug: string;
  display_name: string | null;
  kind: string;
  scope: string;
  scope_id: string | null;
  base_url: string | null;
  base_url_source: string;
  allowed_hosts_json: string;
  credential_binding_id: string | null;
  auth_type: string;
  auth_config_key: string | null;
  auth_authorization_id: string | null;
  auth_param_name: string | null;
  auth_template_override: string | null;
  auth_hosts_override_json: string | null;
  openapi_spec_source_kind: string | null;
  openapi_spec_source: string | null;
  openapi_spec_json: string | null;
  openapi_spec_etag: string | null;
  openapi_spec_fetched_at: string | null;
  mcp_server_id: string | null;
  generated_types: string | null;
  generated_runtime_json: string | null;
  generated_at: string | null;
  generation_error: string | null;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const AUTH_TYPES: ScriptConnectionAuthType[] = ["none", "bearer", "header", "query", "oauth"];

function normalizeAuthType(value: string): ScriptConnectionAuthType {
  return (AUTH_TYPES as string[]).includes(value) ? (value as ScriptConnectionAuthType) : "none";
}

export function connectionAuthSummary(connection: ScriptConnectionRecord): ConnectionAuthSummary {
  return {
    type: connection.authType,
    ...(connection.authConfigKey ? { configKey: connection.authConfigKey } : {}),
    ...(connection.authAuthorizationId ? { authorizationId: connection.authAuthorizationId } : {}),
    ...(connection.authParamName ? { paramName: connection.authParamName } : {}),
  };
}

function bindingFromRow(row: BindingRow): ScriptCredentialBindingRecord {
  return {
    id: row.id,
    configKey: row.config_key,
    allowedHosts: parseJsonArray(row.allowed_hosts_json),
    headerTemplate: row.header_template ?? undefined,
    queryTemplate: row.query_template ?? undefined,
    scope: row.scope as ScriptConnectionScope,
    scopeId: row.scope_id,
    active: row.active === 1,
    authKind: row.auth_kind === "oauth" ? "oauth" : "config",
    oauthAuthorizationId: row.oauth_authorization_id ?? undefined,
    source: row.source as ScriptCredentialBindingRecord["source"],
    managedByConnectionId: row.managed_by_connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function connectionFromRow(row: ConnectionRow): ScriptConnectionRecord {
  const baseUrlSource: ScriptConnectionBaseUrlSource =
    row.base_url_source === "spec" ? "spec" : "user";
  const specBaseUrl =
    row.kind === "openapi" && row.openapi_spec_json
      ? (() => {
          try {
            return extractSpecBaseUrl(
              JSON.parse(row.openapi_spec_json),
              row.openapi_spec_source_kind === "url"
                ? (row.openapi_spec_source ?? undefined)
                : undefined,
            );
          } catch {
            return null;
          }
        })()
      : null;
  const baseUrlMismatch =
    baseUrlSource === "user" && row.base_url && specBaseUrl && !urlsMatch(row.base_url, specBaseUrl)
      ? { specUrl: specBaseUrl, effectiveUrl: row.base_url }
      : undefined;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    kind: row.kind as ScriptConnectionKind,
    scope: row.scope as ScriptConnectionScope,
    scopeId: row.scope_id,
    baseUrl: row.base_url,
    baseUrlSource,
    ...(baseUrlMismatch ? { baseUrlMismatch } : {}),
    allowedHosts: parseJsonArray(row.allowed_hosts_json),
    credentialBindingId: row.credential_binding_id,
    authType: normalizeAuthType(row.auth_type),
    authConfigKey: row.auth_config_key,
    authAuthorizationId: row.auth_authorization_id,
    authParamName: row.auth_param_name,
    authTemplateOverride: row.auth_template_override,
    authHostsOverride: row.auth_hosts_override_json
      ? parseJsonArray(row.auth_hosts_override_json)
      : null,
    openapiSpecSourceKind:
      row.openapi_spec_source_kind as ScriptConnectionRecord["openapiSpecSourceKind"],
    openapiSpecSource: row.openapi_spec_source,
    openapiSpecJson: row.openapi_spec_json,
    openapiSpecEtag: row.openapi_spec_etag,
    openapiSpecFetchedAt: row.openapi_spec_fetched_at,
    mcpServerId: row.mcp_server_id,
    generatedTypes: row.generated_types,
    generatedRuntimeJson: row.generated_runtime_json,
    generatedAt: row.generated_at,
    generationError: row.generation_error,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function applies(
  scope: ScriptConnectionScope,
  scopeId: string | null,
  context: { agentId?: string; repoId?: string },
) {
  if (scope === "global") return true;
  if (scope === "agent") return Boolean(context.agentId && scopeId === context.agentId);
  return Boolean(context.repoId && scopeId === context.repoId);
}

function normalizeSlug(slug: string): string {
  const cleaned = slug
    .trim()
    .replace(/[^A-Za-z0-9]+(.)/g, (_m, chr: string) => chr.toUpperCase())
    .replace(/^[^A-Za-z_]+/, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) throw new Error("slug must contain at least one letter");
  return `${cleaned[0]?.toLowerCase()}${cleaned.slice(1)}`;
}

function pascal(name: string): string {
  const camel = normalizeSlug(name);
  return `${camel[0]?.toUpperCase()}${camel.slice(1)}`;
}

export function listRelationalCredentialBindings(context?: {
  agentId?: string;
  repoId?: string;
  includeInactive?: boolean;
  // Managed bindings back embedded connection auth. They are included by default
  // (the credential broker and connection decorators need them) and only the
  // standalone binding surfaces pass `excludeManaged` to hide them.
  excludeManaged?: boolean;
}): ScriptCredentialBindingRecord[] {
  const rows = getDb()
    .prepare<BindingRow, []>("SELECT * FROM script_credential_bindings ORDER BY config_key ASC")
    .all();
  return rows
    .map(bindingFromRow)
    .filter((binding) => context?.includeInactive || binding.active !== false)
    .filter((binding) => !context?.excludeManaged || binding.managedByConnectionId === null)
    .filter((binding) => !context || applies(binding.scope, binding.scopeId ?? null, context));
}

function findManagedBindingByConnectionId(
  connectionId: string,
): ScriptCredentialBindingRecord | null {
  const row = getDb()
    .prepare<BindingRow, [string]>(
      "SELECT * FROM script_credential_bindings WHERE managed_by_connection_id = ?",
    )
    .get(connectionId);
  return row ? bindingFromRow(row) : null;
}

export function getCredentialBindingById(id: string): ScriptCredentialBindingRecord | null {
  const row = getDb()
    .prepare<BindingRow, [string]>("SELECT * FROM script_credential_bindings WHERE id = ?")
    .get(id);
  return row ? bindingFromRow(row) : null;
}

function findCredentialBindingByIdentity(data: {
  configKey: string;
  scope: ScriptConnectionScope;
  scopeId: string | null;
  headerTemplate?: string | null;
  queryTemplate?: string | null;
  managedByConnectionId?: string | null;
}): ScriptCredentialBindingRecord | null {
  // Managed ownership is part of the identity: a connection-managed upsert
  // (managedByConnectionId set) may ONLY reuse a row already managed by that
  // same connection, and a standalone upsert (null) may ONLY reuse a standalone
  // row. `allowedHosts` is deliberately NOT part of the identity, so without
  // this fence a managed upsert could ADOPT a user-created standalone raw-fetch
  // binding that shares configKey/scope/template — stamping source='connection'
  // + managed_by_connection_id onto it, hiding it from the raw-fetch UI and
  // letting later connection-auth changes mutate/delete the user's credential.
  const row = getDb()
    .prepare<BindingRow, [string, string, string, string, string, string]>(
      `SELECT * FROM script_credential_bindings
       WHERE config_key = ?
         AND scope = ?
         AND COALESCE(scope_id, '') = ?
         AND COALESCE(header_template, '') = ?
         AND COALESCE(query_template, '') = ?
         AND COALESCE(managed_by_connection_id, '') = ?`,
    )
    .get(
      data.configKey,
      data.scope,
      data.scopeId ?? "",
      data.headerTemplate ?? "",
      data.queryTemplate ?? "",
      data.managedByConnectionId ?? "",
    );
  return row ? bindingFromRow(row) : null;
}

export function upsertCredentialBinding(data: {
  id?: string;
  configKey: string;
  allowedHosts: string[];
  headerTemplate?: string | null;
  queryTemplate?: string | null;
  scope?: ScriptConnectionScope;
  scopeId?: string | null;
  active?: boolean;
  authKind?: CredentialBinding["authKind"];
  oauthAuthorizationId?: string | null;
  source?: "default" | "user" | "migration" | "connection";
  managedByConnectionId?: string | null;
  userId?: string | null;
}): ScriptCredentialBindingRecord {
  const now = new Date().toISOString();
  const id = data.id ?? crypto.randomUUID();
  const scope = data.scope ?? "global";
  const scopeId = scope === "global" ? null : (data.scopeId ?? null);
  const active = data.active === false ? 0 : 1;
  const authKind = data.authKind ?? "config";
  const managedByConnectionId = data.managedByConnectionId ?? null;
  if (authKind === "oauth" && !data.oauthAuthorizationId) {
    throw new Error("oauthAuthorizationId is required for oauth credential bindings");
  }
  if (authKind === "oauth" && data.oauthAuthorizationId) {
    const authorization = getAuthorizationById(data.oauthAuthorizationId);
    if (!authorization) {
      throw new Error(`OAuth authorization ${data.oauthAuthorizationId} was not found`);
    }
    const app = getOAuthAppById(authorization.appId);
    if (!app || app.mcpServerId !== null) {
      throw new Error(
        `OAuth authorization ${data.oauthAuthorizationId} is not a generic provider authorization`,
      );
    }
    // Managed (connection-owned) bindings may be attached before the OAuth flow
    // is completed; a non-active authorization simply resolves to no token at
    // egress time. Standalone bindings keep the stricter active-only guard.
    if (!managedByConnectionId && authorization.status !== "active") {
      throw new Error(`OAuth authorization ${data.oauthAuthorizationId} is not active`);
    }
  }
  const oauthAuthorizationId = data.oauthAuthorizationId ?? null;
  const source = data.source ?? (managedByConnectionId ? "connection" : "user");
  const existing =
    (data.id ? getCredentialBindingById(data.id) : null) ??
    findCredentialBindingByIdentity({
      configKey: data.configKey,
      scope,
      scopeId,
      headerTemplate: data.headerTemplate,
      queryTemplate: data.queryTemplate,
      managedByConnectionId,
    });

  if (existing) {
    const targetId = existing.id;
    const row = getDb()
      .prepare<
        BindingRow,
        [
          string,
          string,
          string | null,
          string | null,
          string,
          string | null,
          number,
          string,
          string | null,
          string,
          string | null,
          string | null,
          string,
          string,
        ]
      >(
        `UPDATE script_credential_bindings
         SET config_key = ?, allowed_hosts_json = ?, header_template = ?, query_template = ?,
             scope = ?, scope_id = ?, active = ?, auth_kind = ?, oauth_authorization_id = ?,
             source = ?, managed_by_connection_id = ?, updated_by = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        data.configKey,
        JSON.stringify(data.allowedHosts),
        data.headerTemplate ?? null,
        data.queryTemplate ?? null,
        scope,
        scopeId,
        active,
        authKind,
        oauthAuthorizationId,
        source,
        managedByConnectionId,
        data.userId ?? null,
        now,
        targetId,
      );
    if (!row) throw new Error("Failed to update credential binding");
    return bindingFromRow(row);
  }

  const row = getDb()
    .prepare<
      BindingRow,
      [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        number,
        string,
        string | null,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO script_credential_bindings
       (id, config_key, allowed_hosts_json, header_template, query_template, scope, scope_id,
        active, auth_kind, oauth_authorization_id, source, managed_by_connection_id,
        created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      data.configKey,
      JSON.stringify(data.allowedHosts),
      data.headerTemplate ?? null,
      data.queryTemplate ?? null,
      scope,
      scopeId,
      active,
      authKind,
      oauthAuthorizationId,
      source,
      managedByConnectionId,
      now,
      now,
      data.userId ?? null,
      data.userId ?? null,
    );
  if (!row) throw new Error("Failed to create credential binding");
  return bindingFromRow(row);
}

export function disableCredentialBinding(
  id: string,
  userId?: string | null,
): ScriptCredentialBindingRecord | null {
  const row = getDb()
    .prepare<BindingRow, [string, string | null, string]>(
      `UPDATE script_credential_bindings SET active = 0, updated_at = ?, updated_by = ? WHERE id = ? RETURNING *`,
    )
    .get(new Date().toISOString(), userId ?? null, id);
  return row ? bindingFromRow(row) : null;
}

export function listScriptConnections(context?: {
  agentId?: string;
  repoId?: string;
  kind?: ScriptConnectionKind;
  includeDisabled?: boolean;
  allScopes?: boolean;
}): ScriptConnectionRecord[] {
  const rows = getDb()
    .prepare<ConnectionRow, []>("SELECT * FROM script_connections ORDER BY slug ASC")
    .all();
  return rows
    .map(connectionFromRow)
    .filter((connection) => !context?.kind || connection.kind === context.kind)
    .filter((connection) => context?.includeDisabled || connection.enabled)
    .filter(
      (connection) =>
        !context ||
        context.allScopes === true ||
        applies(connection.scope, connection.scopeId, context),
    );
}

export function getScriptConnectionById(id: string): ScriptConnectionRecord | null {
  const row = getDb()
    .prepare<ConnectionRow, [string]>("SELECT * FROM script_connections WHERE id = ?")
    .get(id);
  return row ? connectionFromRow(row) : null;
}

function resolveLocalReference(
  root: Record<string, unknown>,
  value: unknown,
  seen = new Set<string>(),
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref !== "string" || !record.$ref.startsWith("#/")) return value;
  if (seen.has(record.$ref)) return undefined;
  let resolved: unknown = root;
  for (const rawSegment of record.$ref.slice(2).split("/")) {
    const segment = decodeURIComponent(rawSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return undefined;
    resolved = (resolved as Record<string, unknown>)[segment];
  }
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return resolved;
  const nextSeen = new Set(seen).add(record.$ref);
  const nested = resolveLocalReference(root, resolved, nextSeen);
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
  const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
  return { ...(nested as Record<string, unknown>), ...siblings };
}

function schemaToTs(
  schema: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>(),
): string {
  if (!schema || typeof schema !== "object") return "JsonValue";
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    if (seen.has(s.$ref)) return "JsonValue";
    const resolved = resolveLocalReference(root, s);
    return resolved ? schemaToTs(resolved, root, new Set(seen).add(s.$ref)) : "JsonValue";
  }
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ") || "JsonValue";
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const alternatives = (Array.isArray(s.oneOf) ? s.oneOf : s.anyOf) as unknown[];
    return alternatives.map((item) => schemaToTs(item, root, new Set(seen))).join(" | ");
  }
  if (Array.isArray(s.allOf)) {
    return s.allOf.map((item) => schemaToTs(item, root, new Set(seen))).join(" & ");
  }
  const type = s.type;
  if (type === "string") return "string";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return `(${schemaToTs(s.items, root, new Set(seen))})[]`;
  if (type === "object" || s.properties) {
    const required = new Set(
      Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : [],
    );
    const props =
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {};
    const entries = Object.entries(props);
    if (entries.length === 0) {
      return s.additionalProperties
        ? `{ [key: string]: ${schemaToTs(s.additionalProperties, root, new Set(seen))} }`
        : "{ [key: string]: JsonValue }";
    }
    return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${schemaToTs(value, root, new Set(seen))}`).join("; ")} }`;
  }
  return "JsonValue";
}

function toJsonValue(value: unknown): ScriptApiJsonValue | undefined {
  if (value === null) return null;
  if (["boolean", "number", "string"].includes(typeof value)) return value as ScriptApiJsonValue;
  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonValue(item))
      .filter((item): item is ScriptApiJsonValue => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, toJsonValue(item)] as const)
        .filter((entry): entry is readonly [string, ScriptApiJsonValue] => entry[1] !== undefined),
    );
  }
  return undefined;
}

function dereferenceSchema(
  schema: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>(),
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(item, root, new Set(seen)));
  }
  if (!schema || typeof schema !== "object") return schema;
  const record = schema as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    if (seen.has(record.$ref)) return {};
    const resolved = resolveLocalReference(root, record);
    return resolved ? dereferenceSchema(resolved, root, new Set(seen).add(record.$ref)) : {};
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      dereferenceSchema(value, root, new Set(seen)),
    ]),
  );
}

function jsonSchema(schema: unknown, root: Record<string, unknown>): ScriptApiJsonSchema {
  if (typeof schema === "boolean") return schema;
  const value = toJsonValue(dereferenceSchema(schema, root));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function methodName(operationId: string | undefined, method: string, path: string): string {
  if (operationId) return normalizeSlug(operationId);
  return normalizeSlug(`${method}_${path.replace(/[{}]/g, "").replace(/\//g, "_")}`);
}

function urlsMatch(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return left === right;
  }
}

function resolveTemplatedServerUrl(value: string, variables: unknown): string | null {
  const definitions =
    variables && typeof variables === "object" && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
  let missingDefault = false;
  const resolved = value.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const definition = definitions[name];
    if (!definition || typeof definition !== "object" || !("default" in definition)) {
      missingDefault = true;
      return _match;
    }
    const defaultValue = (definition as { default?: unknown }).default;
    if (defaultValue === undefined || defaultValue === null) {
      missingDefault = true;
      return _match;
    }
    return String(defaultValue);
  });
  return missingDefault ? null : resolved;
}

/**
 * Return the first usable server URL declared by an OpenAPI 3 or Swagger 2
 * document. Relative OAS3 servers only have meaning for URL-sourced specs, so
 * they are resolved against that spec URL when it is available.
 */
export function extractSpecBaseUrl(spec: unknown, specSourceUrl?: string): string | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const root = spec as Record<string, unknown>;
  const servers = root.servers;
  if (Array.isArray(servers) && servers.length > 0) {
    const server = servers[0];
    if (!server || typeof server !== "object" || Array.isArray(server)) return null;
    const value = (server as { url?: unknown }).url;
    if (typeof value !== "string" || !value.trim()) return null;
    const resolvedTemplate = resolveTemplatedServerUrl(
      value,
      (server as { variables?: unknown }).variables,
    );
    if (!resolvedTemplate) return null;
    try {
      return new URL(resolvedTemplate, specSourceUrl).toString();
    } catch {
      return null;
    }
  }

  if (typeof root.host !== "string" || !root.host.trim()) return null;
  const schemes = Array.isArray(root.schemes)
    ? root.schemes.filter((scheme): scheme is string => typeof scheme === "string")
    : [];
  const scheme = schemes.find((candidate) => candidate.toLowerCase() === "https") ?? schemes[0];
  if (!scheme) return null;
  const basePath = typeof root.basePath === "string" ? root.basePath : "";
  const path = basePath ? (basePath.startsWith("/") ? basePath : `/${basePath}`) : "";
  try {
    return new URL(`${scheme}://${root.host}${path}`).toString();
  } catch {
    return null;
  }
}

function extractOperations(
  spec: unknown,
  slug: string,
): { operations: ScriptApiOperationDescriptor[]; types: string } {
  if (!spec || typeof spec !== "object") throw new Error("OpenAPI spec must be an object");
  const root = spec as Record<string, unknown>;
  const paths = root.paths;
  if (!paths || typeof paths !== "object") throw new Error("OpenAPI spec must contain paths");
  const operations: ScriptApiOperationDescriptor[] = [];
  const typeBlocks: string[] = [];
  const verbs = new Set(["get", "post", "put", "patch", "delete"]);

  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const inheritedParams = Array.isArray((pathItem as { parameters?: unknown }).parameters)
      ? (pathItem as { parameters: unknown[] }).parameters
      : [];
    for (const [method, op] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!verbs.has(method) || !op || typeof op !== "object") continue;
      const operation = op as Record<string, unknown>;
      const name = methodName(
        typeof operation.operationId === "string" ? operation.operationId : undefined,
        method,
        path,
      );
      const typeBase = `${pascal(slug)}${pascal(name)}`;
      const rawParameters = [
        ...inheritedParams,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ].map((param) => resolveLocalReference(root, param));
      const parameters = rawParameters
        .filter((param): param is Record<string, unknown> =>
          Boolean(
            param &&
              typeof param === "object" &&
              typeof (param as Record<string, unknown>).name === "string" &&
              ["path", "query", "header"].includes(String((param as Record<string, unknown>).in)),
          ),
        )
        .map((param) => {
          const parameterSchema =
            param.schema ??
            Object.fromEntries(
              ["type", "format", "items", "enum", "default"].flatMap((key) =>
                param[key] === undefined ? [] : [[key, param[key]]],
              ),
            );
          return {
            name: String(param.name),
            in: String(param.in) as "path" | "query" | "header",
            required: param.required === true,
            type: schemaToTs(parameterSchema, root),
            schema: jsonSchema(parameterSchema, root),
          };
        });
      const resolvedRequestBody = resolveLocalReference(root, operation.requestBody);
      const requestBody =
        resolvedRequestBody &&
        typeof resolvedRequestBody === "object" &&
        !Array.isArray(resolvedRequestBody)
          ? (resolvedRequestBody as Record<string, unknown>)
          : null;
      const jsonContent =
        requestBody && typeof requestBody.content === "object"
          ? ((requestBody.content as Record<string, { schema?: unknown }>)["application/json"] ??
            Object.values(requestBody.content as Record<string, { schema?: unknown }>)[0])
          : undefined;
      const swaggerBodyParameter = rawParameters.find((param): param is Record<string, unknown> =>
        Boolean(
          param && typeof param === "object" && (param as Record<string, unknown>).in === "body",
        ),
      );
      const swaggerFormParameters = rawParameters.filter(
        (param): param is Record<string, unknown> =>
          Boolean(
            param &&
              typeof param === "object" &&
              (param as Record<string, unknown>).in === "formData" &&
              typeof (param as Record<string, unknown>).name === "string",
          ),
      );
      const swaggerFormSchema =
        swaggerFormParameters.length > 0
          ? {
              type: "object",
              properties: Object.fromEntries(
                swaggerFormParameters.map((param) => [
                  String(param.name),
                  param.schema ??
                    Object.fromEntries(
                      ["type", "format", "items", "enum", "default"].flatMap((key) =>
                        param[key] === undefined ? [] : [[key, param[key]]],
                      ),
                    ),
                ]),
              ),
              required: swaggerFormParameters
                .filter((param) => param.required === true)
                .map((param) => String(param.name)),
            }
          : undefined;
      const rawRequestBodySchema =
        jsonContent?.schema ?? swaggerBodyParameter?.schema ?? swaggerFormSchema;
      const requestBodySchema = rawRequestBodySchema
        ? jsonSchema(rawRequestBodySchema, root)
        : undefined;
      const bodyType = rawRequestBodySchema ? schemaToTs(rawRequestBodySchema, root) : "JsonValue";
      const responses =
        operation.responses && typeof operation.responses === "object"
          ? (operation.responses as Record<string, unknown>)
          : {};
      const successStatus =
        Object.keys(responses).find((status) => /^2\d\d$/.test(status)) ?? "default";
      const response = resolveLocalReference(root, responses[successStatus]);
      const responseContent =
        response &&
        typeof response === "object" &&
        !Array.isArray(response) &&
        typeof (response as { content?: unknown }).content === "object"
          ? ((response as { content: Record<string, { schema?: unknown }> }).content[
              "application/json"
            ] ??
            Object.values(
              (response as { content: Record<string, { schema?: unknown }> }).content,
            )[0])
          : undefined;
      const swaggerResponseSchema =
        response && typeof response === "object" && !Array.isArray(response)
          ? (response as Record<string, unknown>).schema
          : undefined;
      const rawResponseSchema = responseContent?.schema ?? swaggerResponseSchema;
      const responseType = rawResponseSchema ? schemaToTs(rawResponseSchema, root) : "JsonValue";
      const responseSchema = rawResponseSchema ? jsonSchema(rawResponseSchema, root) : {};
      const paramsByPlace = (place: "path" | "query" | "header") =>
        parameters
          .filter((param) => param.in === place)
          .map(
            (param) => `${JSON.stringify(param.name)}${param.required ? "" : "?"}: ${param.type}`,
          )
          .join("; ");
      // Some generated specs (e.g. readme.io exports) declare a requestBody on
      // GET operations; fetch() rejects GET/HEAD bodies, so never generate one.
      const methodAllowsBody = method !== "get" && method !== "head";
      const hasBody = methodAllowsBody && Boolean(rawRequestBodySchema || requestBody);
      const requestType = `export type ${typeBase}Args = {${paramsByPlace("path") ? ` path: { ${paramsByPlace("path")} };` : ""}${paramsByPlace("query") ? ` query?: { ${paramsByPlace("query")} };` : ""}${paramsByPlace("header") ? ` header?: { ${paramsByPlace("header")} };` : ""}${hasBody ? ` body: ${bodyType};` : ""}};`;
      const responseDecl = `export type ${typeBase}Response = ${responseType};`;
      typeBlocks.push(requestType, responseDecl);
      operations.push({
        name,
        method: method.toUpperCase(),
        path,
        parameters: parameters.map(({ name, in: where, required, schema }) => ({
          name,
          in: where,
          required,
          schema,
        })),
        hasBody,
        successStatus,
        requestBodySchema,
        responseSchema,
        requestType: `${typeBase}Args`,
        responseType: `${typeBase}Response`,
      });
    }
  }

  if (operations.length === 0) throw new Error("OpenAPI spec did not contain supported operations");
  return { operations, types: typeBlocks.join("\n") };
}

type CredentialDescriptorInput = {
  configKey: string;
  headerTemplate?: string | null;
  queryTemplate?: string | null;
} | null;

export function buildGeneratedArtifacts(input: {
  slug: string;
  baseUrl: string;
  credential: CredentialDescriptorInput;
  openapiSpec: unknown;
}): { generatedTypes: string; generatedRuntimeJson: string } {
  const slug = normalizeSlug(input.slug);
  const { operations, types } = extractOperations(input.openapiSpec, slug);
  const credential = credentialDescriptor(input.credential);
  const descriptor: ScriptApiConnectionDescriptor = {
    slug,
    baseUrl: input.baseUrl,
    credential,
    operations,
  };
  const generatedTypes = [
    types,
    `export interface ${pascal(slug)}Api {`,
    ...operations.flatMap((operation) => [
      `  ${operation.name}(args: ${operation.requestType}): Promise<${operation.responseType}>;`,
      `  ${operation.name}(args: ${operation.requestType}, options: ScriptApiRawOptions): Promise<ScriptApiRawResult>;`,
    ]),
    "}",
  ].join("\n");
  return { generatedTypes, generatedRuntimeJson: JSON.stringify(descriptor) };
}

function credentialDescriptor(credential: CredentialDescriptorInput) {
  return credential
    ? {
        configKey: credential.configKey,
        headerTemplate: credential.headerTemplate ?? undefined,
        queryTemplate: credential.queryTemplate ?? undefined,
      }
    : null;
}

export function buildGraphqlGeneratedArtifacts(input: {
  slug: string;
  baseUrl: string;
  credential: CredentialDescriptorInput;
}): { generatedTypes: string; generatedRuntimeJson: string } {
  const slug = normalizeSlug(input.slug);
  const descriptor: ScriptApiConnectionDescriptor = {
    slug,
    kind: "graphql",
    baseUrl: input.baseUrl,
    credential: credentialDescriptor(input.credential),
  };
  const generatedTypes = [
    `export interface ${pascal(slug)}Api {`,
    "  graphql<T = JsonValue>(query: string, variables?: Record<string, JsonValue>): Promise<T>;",
    "}",
  ].join("\n");
  return { generatedTypes, generatedRuntimeJson: JSON.stringify(descriptor) };
}

type AuthColumns = {
  authType: ScriptConnectionAuthType;
  authConfigKey: string | null;
  authAuthorizationId: string | null;
  authParamName: string | null;
  authTemplateOverride: string | null;
  authHostsOverrideJson: string | null;
};

const NONE_AUTH_COLUMNS: AuthColumns = {
  authType: "none",
  authConfigKey: null,
  authAuthorizationId: null,
  authParamName: null,
  authTemplateOverride: null,
  authHostsOverrideJson: null,
};

type DerivedConnectionBinding = {
  configKey: string;
  headerTemplate: string | null;
  queryTemplate: string | null;
  allowedHosts: string[];
  authKind: "config" | "oauth";
  oauthAuthorizationId: string | null;
  authColumns: AuthColumns;
  credential: CredentialDescriptorInput;
  secretWrite: {
    scope: ScriptConnectionScope;
    scopeId: string | null;
    key: string;
    value: string;
  } | null;
};

/**
 * Resolve inline connection auth into a managed credential binding spec.
 *
 * Inline secrets land in a derived, write-only, encrypted `swarm_config` key
 * (`connection.<slug>.secret`); explicit `configKey` values are used as-is
 * (shared/rotated secrets). Templates are derived per auth type — a `query`
 * binding NEVER falls back to a header (see the Phase-0 regression). Scripts
 * only ever see the `[REDACTED:<key>]` placeholder.
 */
function deriveConnectionBinding(
  auth: ConnectionAuthInput,
  ctx: {
    slug: string;
    baseUrl: string | null;
    scope: ScriptConnectionScope;
    scopeId: string | null;
  },
): DerivedConnectionBinding | null {
  if (auth.type === "none") return null;

  let configKey: string;
  let secretWrite: DerivedConnectionBinding["secretWrite"] = null;
  if (auth.type === "oauth") {
    if (!auth.authorizationId) {
      throw new Error("oauth connection auth requires an authorizationId.");
    }
    const authorization = getAuthorizationById(auth.authorizationId);
    if (!authorization) {
      throw new Error(`OAuth authorization ${auth.authorizationId} was not found.`);
    }
    const app = getOAuthAppById(authorization.appId);
    if (!app || app.mcpServerId !== null) {
      throw new Error(
        `OAuth authorization ${auth.authorizationId} is not a generic provider authorization.`,
      );
    }
    configKey = auth.configKey ?? `connection.${ctx.slug}.oauth`;
  } else if (auth.secret !== undefined) {
    if (auth.configKey) {
      throw new Error("Provide either `secret` or `configKey` for connection auth, not both.");
    }
    // Derived, write-only encrypted secret. LIFECYCLE: nothing but this
    // connection references this key, so every path that supersedes or removes
    // the connection's inline-secret auth MUST delete this swarm_config row via
    // deleteManagedConnectionSecret() (the managed binding CASCADEs, this does
    // not). upsertScriptConnection handles supersession; a future
    // connection-delete path must handle deletion.
    configKey = `connection.${ctx.slug}.secret`;
    secretWrite = { scope: ctx.scope, scopeId: ctx.scopeId, key: configKey, value: auth.secret };
  } else if (auth.configKey) {
    configKey = auth.configKey;
  } else {
    throw new Error(`Connection auth of type '${auth.type}' requires 'secret' or 'configKey'.`);
  }

  const placeholder = placeholderForConfigKey(configKey);
  let headerTemplate: string | null = null;
  let queryTemplate: string | null = null;
  if (auth.type === "query") {
    queryTemplate = auth.template ?? `${auth.paramName}=${placeholder}`;
  } else if (auth.type === "header") {
    headerTemplate = auth.template ?? `${auth.headerName}: ${placeholder}`;
  } else {
    // bearer + oauth both resolve to a bearer Authorization header.
    headerTemplate = auth.template ?? `Authorization: Bearer ${placeholder}`;
  }
  if (!headerTemplate?.includes(placeholder) && !queryTemplate?.includes(placeholder)) {
    throw new Error(`Connection auth template must include ${placeholder}.`);
  }

  const hosts = auth.hosts ?? (ctx.baseUrl ? [new URL(ctx.baseUrl).hostname] : []);
  if (hosts.length === 0) {
    throw new Error(
      "Connection auth requires a baseUrl or explicit hosts for egress allowlisting.",
    );
  }

  const paramName =
    auth.type === "header" ? auth.headerName : auth.type === "query" ? auth.paramName : null;

  return {
    configKey,
    headerTemplate,
    queryTemplate,
    allowedHosts: hosts,
    authKind: auth.type === "oauth" ? "oauth" : "config",
    oauthAuthorizationId: auth.type === "oauth" ? auth.authorizationId : null,
    credential: { configKey, headerTemplate, queryTemplate },
    secretWrite,
    authColumns: {
      authType: auth.type,
      authConfigKey: configKey,
      authAuthorizationId: auth.type === "oauth" ? auth.authorizationId : null,
      authParamName: paramName,
      authTemplateOverride: auth.template ?? null,
      authHostsOverrideJson: auth.hosts ? JSON.stringify(auth.hosts) : null,
    },
  };
}

/**
 * Rebuild the auth intent from a connection's persisted columns so metadata-only
 * upserts and refreshes re-derive the managed binding (propagating slug/baseUrl
 * changes) WITHOUT rewriting the underlying secret (it already lives under the
 * stored configKey).
 */
function reconstructAuthFromConnection(conn: ScriptConnectionRecord | null): ConnectionAuthInput {
  if (!conn || conn.authType === "none") return { type: "none" };
  const configKey = conn.authConfigKey ?? undefined;
  const template = conn.authTemplateOverride ?? undefined;
  const hosts = conn.authHostsOverride ?? undefined;
  switch (conn.authType) {
    case "bearer":
      return { type: "bearer", configKey, template, hosts };
    case "header":
      return {
        type: "header",
        headerName: conn.authParamName ?? "Authorization",
        configKey,
        template,
        hosts,
      };
    case "query":
      return {
        type: "query",
        paramName: conn.authParamName ?? "api_key",
        configKey,
        template,
        hosts,
      };
    case "oauth":
      return {
        type: "oauth",
        authorizationId: conn.authAuthorizationId ?? "",
        configKey,
        template,
        hosts,
      };
    default:
      return { type: "none" };
  }
}

/**
 * Map the legacy flat auth args (`configKey` + `headerTemplate`/`queryTemplate`,
 * or `authKind:'oauth'` + `oauthAuthorizationId`) onto the unified
 * {@link ConnectionAuthInput}. An explicit `auth` object always wins. Returns
 * `undefined` when no auth intent is expressed (upsert then preserves existing
 * embedded auth or leaves the connection unauthenticated).
 */
export function connectionAuthInputFromFlat(input: {
  auth?: ConnectionAuthInput;
  configKey?: string | null;
  headerTemplate?: string | null;
  queryTemplate?: string | null;
  authKind?: "config" | "oauth";
  oauthAuthorizationId?: string | null;
  allowedHosts?: string[];
}): ConnectionAuthInput | undefined {
  const hosts =
    input.allowedHosts && input.allowedHosts.length > 0 ? input.allowedHosts : undefined;
  if (input.auth) {
    if (input.auth.type !== "none" && input.auth.hosts === undefined && hosts) {
      return { ...input.auth, hosts };
    }
    return input.auth;
  }
  if (input.authKind === "oauth" && input.oauthAuthorizationId) {
    return { type: "oauth", authorizationId: input.oauthAuthorizationId, hosts };
  }
  if (input.configKey) {
    if (input.queryTemplate) {
      const paramName = input.queryTemplate.split("=")[0] || "api_key";
      return {
        type: "query",
        paramName,
        configKey: input.configKey,
        template: input.queryTemplate,
        hosts,
      };
    }
    if (input.headerTemplate) {
      const headerName = input.headerTemplate.split(":")[0] || "Authorization";
      return {
        type: "header",
        headerName,
        configKey: input.configKey,
        template: input.headerTemplate,
        hosts,
      };
    }
    return { type: "bearer", configKey: input.configKey, hosts };
  }
  return undefined;
}

function deleteManagedBindingForConnection(connectionId: string): void {
  getDb()
    .prepare<unknown, [string]>(
      "DELETE FROM script_credential_bindings WHERE managed_by_connection_id = ?",
    )
    .run(connectionId);
}

/**
 * Delete the derived, encrypted `connection.<slug>.secret` swarm_config row that
 * backs an inline-secret connection auth.
 *
 * The managed credential binding CASCADE-deletes with its connection, but this
 * swarm_config secret row does NOT — nothing else references it — so it must be
 * removed explicitly or it lingers forever (encrypted on disk + in the secret
 * scrubber cache). Callers must {@link refreshSecretScrubberCache} afterwards.
 *
 * Two call sites need this:
 *   1. upsertScriptConnection, when an upsert SUPERSEDES a previously-derived
 *      inline secret (slug change, or the new auth no longer uses that derived
 *      key). Handled below.
 *   2. FUTURE connection-delete path: there is no deleteScriptConnection today
 *      (only mcp_server_id CASCADE), but any such path MUST call this for the
 *      connection's derived `connection.<slug>.secret` key (when auth_type used a
 *      derived inline secret) so the secret is not orphaned.
 */
function deleteManagedConnectionSecret(input: {
  scope: ScriptConnectionScope;
  scopeId: string | null;
  key: string;
}): void {
  const scopeId = input.scope === "global" ? null : input.scopeId;
  if (scopeId === null) {
    getDb()
      .prepare<unknown, [string, string]>(
        "DELETE FROM swarm_config WHERE scope = ? AND scopeId IS NULL AND key = ?",
      )
      .run(input.scope, input.key);
  } else {
    getDb()
      .prepare<unknown, [string, string, string]>(
        "DELETE FROM swarm_config WHERE scope = ? AND scopeId = ? AND key = ?",
      )
      .run(input.scope, scopeId, input.key);
  }
}

/**
 * Matches the reserved derived namespaces an inline secret / oauth placeholder
 * mints for a connection (`connection.<slug>.secret`, `connection.<slug>.oauth`).
 * User-supplied `configKey`s are barred from these namespaces (see
 * {@link assertConfigKeyNotReserved}), so any auth_config_key matching one was
 * minted by the connection itself.
 */
const RESERVED_DERIVED_CONFIG_KEY = /^connection\..+\.(secret|oauth)$/;
const DERIVED_INLINE_SECRET_KEY = /^connection\..+\.secret$/;

/** Reject user-supplied configKeys that collide with a connection's reserved
 * derived-credential namespace. Reconstruction of an existing connection's auth
 * bypasses this (it is not user input), so a metadata-only rename that preserves
 * `connection.<oldSlug>.secret` still round-trips. */
function assertConfigKeyNotReserved(auth: ConnectionAuthInput | undefined): void {
  if (!auth || auth.type === "none" || auth.type === "oauth") return;
  const configKey = auth.configKey;
  if (configKey && RESERVED_DERIVED_CONFIG_KEY.test(configKey)) {
    throw new Error(
      "configKey may not use the reserved `connection.*.secret` / `connection.*.oauth` namespace; that space is reserved for connection-derived credentials.",
    );
  }
}

/**
 * The derived, write-only key an inline-secret auth mints for a connection.
 * Returns null unless the connection's persisted auth actually points at a
 * derived inline secret (i.e. an inline secret, not an explicit shared
 * `configKey` nor an oauth `.oauth` key) — so we never delete a secret the
 * connection doesn't own.
 *
 * Recognizes the key by the reserved `connection.*.secret` namespace rather than
 * recomputing it from the CURRENT slug: a metadata-only rename preserves the old
 * `connection.<oldSlug>.secret` in `authConfigKey` while the slug changes, so a
 * slug-derived comparison would miss it and orphan the encrypted secret when
 * auth is later switched to oauth/config/none. User configKeys can't occupy this
 * namespace, so a namespace match unambiguously identifies an owned secret.
 */
function derivedInlineSecretKey(connection: ScriptConnectionRecord | null): string | null {
  if (!connection) return null;
  if (connection.authType === "none" || connection.authType === "oauth") return null;
  const key = connection.authConfigKey;
  return key && DERIVED_INLINE_SECRET_KEY.test(key) ? key : null;
}

type OpenapiSpecFetchResult =
  | {
      status: "fetched";
      spec: unknown;
      specJson: string;
      etag: string | null;
      fetchedAt: string;
    }
  | {
      status: "not_modified";
      etag: string | null;
      fetchedAt: string;
    };

let openapiSpecFetchForTesting: typeof fetch | null = null;

export function setOpenapiSpecFetchForTesting(fetchImpl: typeof fetch | null): void {
  openapiSpecFetchForTesting = fetchImpl;
}

function openapiSpecUrlOptions() {
  return publicEndpointSsrfOptions();
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

function mcpToolMethodName(name: string): string {
  return normalizeSlug(name);
}

function mcpToolMethodNames<T extends { name: string }>(
  tools: T[],
): Array<{ tool: T; methodName: string }> {
  const used = new Set<string>();
  const baseCounts = new Map<string, number>();
  return tools.map((tool) => {
    const base = mcpToolMethodName(tool.name);
    const count = baseCounts.get(base) ?? 0;
    baseCounts.set(base, count + 1);
    let methodName = count === 0 ? base : `${base}${count + 1}`;
    let suffix = count + 2;
    while (used.has(methodName)) {
      methodName = `${base}${suffix}`;
      suffix += 1;
    }
    used.add(methodName);
    return { tool, methodName };
  });
}

function mcpToolArgsType(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") return "Record<string, JsonValue>";
  const schema = inputSchema as Record<string, unknown>;
  if (Object.keys(schema).length === 0) return "Record<string, JsonValue>";
  const type = schemaToTs(schema, schema);
  return type === "JsonValue" ? "Record<string, JsonValue>" : type;
}

export function buildMcpGeneratedArtifacts(input: {
  slug: string;
  connectionId: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}): { generatedTypes: string; generatedRuntimeJson: string } {
  const slug = normalizeSlug(input.slug);
  const methodNames = mcpToolMethodNames(input.tools);
  const tools: ScriptMcpToolDescriptor[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema(tool.inputSchema ?? {}, tool.inputSchema ?? {}),
  }));
  const generatedTypes = [
    `export interface ${pascal(slug)}Mcp {`,
    ...methodNames.map(
      ({ tool, methodName }) =>
        `  ${methodName}(args: ${mcpToolArgsType(tool.inputSchema)}): Promise<JsonValue>;`,
    ),
    "}",
  ].join("\n");
  const descriptor: ScriptMcpConnectionDescriptor = {
    slug,
    kind: "mcp",
    connectionId: input.connectionId,
    tools,
  };
  return { generatedTypes, generatedRuntimeJson: JSON.stringify(descriptor) };
}

function parseOpenapiSpecBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (jsonErr) {
    const yaml = (Bun as unknown as { YAML?: { parse(input: string): unknown } }).YAML;
    if (!yaml) {
      throw new Error(
        `OpenAPI spec response was not valid JSON. JSON specs only unless Bun.YAML.parse is available: ${
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
        }`,
      );
    }
    try {
      return yaml.parse(body);
    } catch (yamlErr) {
      throw new Error(
        `OpenAPI spec response was neither valid JSON nor valid YAML: ${
          yamlErr instanceof Error ? yamlErr.message : String(yamlErr)
        }`,
      );
    }
  }
}

export async function fetchOpenapiSpec(
  url: string,
  opts: { etag?: string | null } = {},
): Promise<OpenapiSpecFetchResult> {
  let parsed = assertUrlSafe(url, openapiSpecUrlOptions());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = new Headers({
      Accept: "application/json, application/yaml;q=0.9, text/yaml;q=0.8, */*;q=0.5",
    });
    if (opts.etag) headers.set("If-None-Match", opts.etag);
    const fetchImpl = openapiSpecFetchForTesting ?? Bun.fetch;
    let response: Response | null = null;
    for (let hop = 0; hop <= 5; hop += 1) {
      response = await fetchImpl(parsed, {
        headers,
        signal: controller.signal,
        redirect: "manual",
      });
      if (!isRedirectStatus(response.status)) break;
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`OpenAPI spec redirect missing Location header: HTTP ${response.status}`);
      }
      parsed = assertUrlSafe(new URL(location, parsed).toString(), openapiSpecUrlOptions());
      if (hop === 5) throw new Error("OpenAPI spec fetch exceeded 5 redirects.");
    }
    if (!response) throw new Error("OpenAPI spec fetch failed before receiving a response.");
    const fetchedAt = new Date().toISOString();
    const etag = response.headers.get("etag");
    if (response.status === 304) {
      return { status: "not_modified", etag, fetchedAt };
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: HTTP ${response.status}`);
    }
    const spec = parseOpenapiSpecBody(await response.text());
    return {
      status: "fetched",
      spec,
      specJson: JSON.stringify(spec),
      etag,
      fetchedAt,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Timed out fetching OpenAPI spec after 15s");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function upsertScriptConnection(data: {
  id?: string;
  slug: string;
  displayName?: string | null;
  kind: ScriptConnectionKind;
  scope?: ScriptConnectionScope;
  scopeId?: string | null;
  baseUrl?: string | null;
  allowedHosts?: string[];
  credentialBindingId?: string | null;
  // Inline auth intent. When provided, the connection owns an auto-managed
  // credential binding derived from it. When omitted on an update, existing
  // embedded auth is preserved (and re-derived so slug/baseUrl changes flow
  // through). `{ type: 'none' }` explicitly clears embedded auth.
  auth?: ConnectionAuthInput;
  openapiSpecSourceKind?: "url" | "inline" | "agent_fs" | "vendored" | null;
  openapiSpecSource?: string | null;
  openapiSpecUrl?: string | null;
  openapiSpecJson?: string | null;
  openapiSpecEtag?: string | null;
  openapiSpecFetchedAt?: string | null;
  mcpServerId?: string | null;
  enabled?: boolean;
  agentId?: string;
  userId?: string | null;
}): Promise<ScriptConnectionRecord> {
  const now = new Date().toISOString();
  const id = data.id ?? crypto.randomUUID();
  const scope = data.scope ?? "global";
  const scopeId = scope === "global" ? null : (data.scopeId ?? null);
  const normalizedSlug = normalizeSlug(data.slug);
  let generatedTypes: string | null = null;
  let generatedRuntimeJson: string | null = null;
  let generationError: string | null = null;
  let generatedAt: string | null = null;
  let openapiSpecJson = data.openapiSpecJson ?? null;
  let openapiSpecSourceKind =
    data.openapiSpecSourceKind ??
    (data.kind === "openapi" ? (data.openapiSpecUrl ? "url" : "inline") : null);
  let openapiSpecSource = data.openapiSpecSource ?? data.openapiSpecUrl ?? null;
  let openapiSpecEtag = data.openapiSpecEtag ?? null;
  let openapiSpecFetchedAt = data.openapiSpecFetchedAt ?? null;
  let openapiSpec: unknown;

  const existing = data.id
    ? getDb()
        .prepare<ConnectionRow, [string]>("SELECT * FROM script_connections WHERE id = ?")
        .get(data.id)
    : getDb()
        .prepare<ConnectionRow, [string, string, string | null]>(
          "SELECT * FROM script_connections WHERE slug = ? AND scope = ? AND COALESCE(scope_id, '') = COALESCE(?, '')",
        )
        .get(normalizedSlug, scope, scopeId);
  const connectionId = existing?.id ?? id;
  const existingConnection = existing ? connectionFromRow(existing) : null;
  let effectiveBaseUrl = data.baseUrl ?? null;
  let baseUrlSource: ScriptConnectionBaseUrlSource = "user";
  let allowedHosts = data.allowedHosts ?? [];
  let vendoredBaseUrl: string | null = null;

  // MCP connections resolve auth through their MCP server, never inline.
  if (data.kind === "mcp" && data.auth && data.auth.type !== "none") {
    throw new Error(
      "MCP connections resolve auth through their MCP server; `auth` is not supported.",
    );
  }
  // Keep the reserved derived-credential namespaces exclusive so a user-supplied
  // configKey can never collide with (or later be mistaken for) a connection's
  // own derived inline secret. Checked on user input only — reconstruction of an
  // existing connection's preserved key is not routed through here.
  assertConfigKeyNotReserved(data.auth);

  // Preserve a stored OpenAPI spec across metadata/auth-only edits. When an
  // update omits EVERY spec source (no url, inline json, or vendored/source),
  // re-seed from the existing connection so the spec + its `ctx.api` operations
  // survive — the generated artifacts are still rebuilt below so slug/auth/
  // baseUrl changes propagate. Without this, an omitted source defaults to an
  // empty inline `{}` and wipes the connection's operations (e.g. a name/auth
  // edit of a vendored or inline connection).
  if (
    data.kind === "openapi" &&
    existingConnection?.openapiSpecJson &&
    data.openapiSpecJson == null &&
    data.openapiSpecUrl == null &&
    data.openapiSpecSource == null
  ) {
    openapiSpecJson = existingConnection.openapiSpecJson;
    openapiSpecSourceKind = existingConnection.openapiSpecSourceKind;
    openapiSpecSource = existingConnection.openapiSpecSource;
    openapiSpecEtag = existingConnection.openapiSpecEtag;
    openapiSpecFetchedAt = existingConnection.openapiSpecFetchedAt;
  }
  // Explicit legacy attach: caller passes `credentialBindingId` (a standalone
  // binding, e.g. raw-fetch egress) with no `auth`.
  const explicitLegacyBinding = data.auth === undefined && data.credentialBindingId !== undefined;
  const authIntent: ConnectionAuthInput =
    data.kind === "mcp" || explicitLegacyBinding
      ? { type: "none" }
      : (data.auth ?? reconstructAuthFromConnection(existingConnection));
  let derived: DerivedConnectionBinding | null = null;
  // An explicitly-attached standalone binding still feeds the generated
  // credential descriptor (raw fetch() / advanced path).
  const explicitBinding =
    explicitLegacyBinding && data.credentialBindingId
      ? getCredentialBindingById(data.credentialBindingId)
      : null;
  const explicitBindingCredential: CredentialDescriptorInput = explicitBinding
    ? {
        configKey: explicitBinding.configKey,
        headerTemplate: explicitBinding.headerTemplate,
        queryTemplate: explicitBinding.queryTemplate,
      }
    : null;

  if (data.kind === "openapi") {
    if (openapiSpecSourceKind === "vendored") {
      if (!openapiSpecSource) throw new Error("Vendored OpenAPI connections require a spec slug.");
      const vendored = readVendoredOpenapiSpec(openapiSpecSource);
      openapiSpecJson = vendored.specJson;
      openapiSpec = JSON.parse(vendored.specJson) as unknown;
      vendoredBaseUrl = vendored.entry.baseUrl;
    }
    if (!openapiSpecJson && data.openapiSpecUrl) {
      const fetched = await fetchOpenapiSpec(data.openapiSpecUrl);
      if (fetched.status === "not_modified") {
        throw new Error("OpenAPI spec URL returned 304 without an existing cached spec.");
      }
      openapiSpec = fetched.spec;
      openapiSpecJson = fetched.specJson;
      openapiSpecSourceKind = "url";
      openapiSpecSource = data.openapiSpecUrl;
      openapiSpecEtag = fetched.etag;
      openapiSpecFetchedAt = fetched.fetchedAt;
    }
    try {
      // Inline specs may be pasted as YAML too — parse with the same
      // JSON-then-YAML fallback as fetched specs and store canonical JSON.
      let spec = openapiSpec;
      if (!spec) {
        spec = parseOpenapiSpecBody(openapiSpecJson ?? "{}");
        openapiSpecJson = JSON.stringify(spec);
      }
      const specBaseUrl = extractSpecBaseUrl(
        spec,
        openapiSpecSourceKind === "url" ? (openapiSpecSource ?? undefined) : undefined,
      );
      if (data.baseUrl) {
        effectiveBaseUrl = data.baseUrl;
        baseUrlSource = "user";
      } else if (vendoredBaseUrl) {
        // Curated manifest baseUrl wins over the vendored spec's own servers.
        effectiveBaseUrl = vendoredBaseUrl;
        baseUrlSource = "spec";
      } else if (specBaseUrl) {
        effectiveBaseUrl = specBaseUrl;
        baseUrlSource = "spec";
      } else if (existingConnection?.baseUrl) {
        effectiveBaseUrl = existingConnection.baseUrl;
        baseUrlSource = existingConnection.baseUrlSource;
      } else {
        throw new Error(
          "baseUrl is required for OpenAPI connections when the spec has no server URL",
        );
      }
      new URL(effectiveBaseUrl);
      derived = deriveConnectionBinding(authIntent, {
        slug: normalizedSlug,
        baseUrl: effectiveBaseUrl,
        scope,
        scopeId,
      });
      const artifacts = buildGeneratedArtifacts({
        slug: data.slug,
        baseUrl: effectiveBaseUrl,
        credential: derived?.credential ?? explicitBindingCredential,
        openapiSpec: spec,
      });
      generatedTypes = artifacts.generatedTypes;
      generatedRuntimeJson = artifacts.generatedRuntimeJson;
      generatedAt = now;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message ===
          "baseUrl is required for OpenAPI connections when the spec has no server URL"
      ) {
        throw err;
      }
      generationError = err instanceof Error ? err.message : String(err);
    }
  }

  if (data.kind === "mcp") {
    try {
      if (!data.mcpServerId) throw new Error("mcpServerId is required for MCP connections");
      // Resolve MCP auth config in the scope the connection will RUN under:
      // an agent-scoped connection may rely on that agent's scoped secrets,
      // which the (lead) caller's own context cannot see.
      const discoveryContext =
        scope === "agent" && scopeId
          ? { agentId: scopeId }
          : scope === "repo" && scopeId
            ? { agentId: data.agentId, repoId: scopeId }
            : { agentId: data.agentId };
      const tools = await listMcpServerTools(data.mcpServerId, discoveryContext);
      const artifacts = buildMcpGeneratedArtifacts({
        slug: data.slug,
        connectionId,
        tools,
      });
      generatedTypes = artifacts.generatedTypes;
      generatedRuntimeJson = artifacts.generatedRuntimeJson;
      generatedAt = now;
    } catch (err) {
      generationError = err instanceof Error ? err.message : String(err);
    }
  }

  if (data.kind === "graphql") {
    if (!data.baseUrl) throw new Error("baseUrl is required for GraphQL connections");
    if (!data.allowedHosts?.length) {
      throw new Error("allowedHosts is required for GraphQL connections");
    }
    new URL(data.baseUrl);
    effectiveBaseUrl = data.baseUrl;
    baseUrlSource = "user";
    allowedHosts = data.allowedHosts;
    derived = deriveConnectionBinding(authIntent, {
      slug: normalizedSlug,
      baseUrl: data.baseUrl,
      scope,
      scopeId,
    });
    const artifacts = buildGraphqlGeneratedArtifacts({
      slug: data.slug,
      baseUrl: data.baseUrl,
      credential: derived?.credential ?? explicitBindingCredential,
    });
    generatedTypes = artifacts.generatedTypes;
    generatedRuntimeJson = artifacts.generatedRuntimeJson;
    generatedAt = now;
  }

  if (data.kind !== "graphql") {
    allowedHosts =
      data.allowedHosts ?? (effectiveBaseUrl ? [new URL(effectiveBaseUrl).hostname] : []);
  }

  // A previously-derived inline secret (`connection.<oldSlug>.secret`) is
  // orphaned when this upsert moves the connection's binding off that key —
  // switching auth to oauth / explicit configKey / none, or attaching a
  // standalone binding. Compare the old derived key against the key the binding
  // will reference AFTER this upsert (NOT merely against a fresh secretWrite): a
  // metadata-only rename reconstructs the old derived key as an explicit
  // configKey and keeps referencing it, so it must NOT be deleted.
  const oldDerivedSecretKey = derivedInlineSecretKey(existingConnection);
  const newReferencedConfigKey = derived?.configKey ?? explicitBinding?.configKey ?? null;
  let supersededSecretDeleted = false;

  // Connection row and its auto-managed binding form a reference cycle
  // (connection.credential_binding_id ↔ binding.managed_by_connection_id).
  // Defer FK enforcement to commit so a fresh connection + its binding can be
  // written in a single atomic pass regardless of insert order.
  const writeConnectionAndBinding = getDb().transaction((): ConnectionRow => {
    getDb().run("PRAGMA defer_foreign_keys = ON");

    if (derived?.secretWrite) {
      upsertSwarmConfig({ ...derived.secretWrite, isSecret: true });
    }

    // Drop a superseded derived inline secret (see oldDerivedSecretKey above).
    // Skip when the connection's binding still references that same key (same
    // slug + still inline, or a metadata-only rename that kept it) — it is not
    // orphaned. The old row lives under the EXISTING connection's scope.
    if (oldDerivedSecretKey && oldDerivedSecretKey !== newReferencedConfigKey) {
      deleteManagedConnectionSecret({
        scope: existingConnection?.scope ?? scope,
        scopeId: existingConnection?.scopeId ?? scopeId,
        key: oldDerivedSecretKey,
      });
      supersededSecretDeleted = true;
    }

    let credentialBindingId: string | null;
    let authCols: AuthColumns;
    if (explicitLegacyBinding) {
      deleteManagedBindingForConnection(connectionId);
      credentialBindingId = data.credentialBindingId ?? null;
      authCols = NONE_AUTH_COLUMNS;
    } else if (derived) {
      const existingManaged = findManagedBindingByConnectionId(connectionId);
      const binding = upsertCredentialBinding({
        id: existingManaged?.id,
        configKey: derived.configKey,
        allowedHosts: derived.allowedHosts,
        headerTemplate: derived.headerTemplate,
        queryTemplate: derived.queryTemplate,
        scope,
        scopeId,
        active: true,
        authKind: derived.authKind,
        oauthAuthorizationId: derived.oauthAuthorizationId,
        managedByConnectionId: connectionId,
        source: "connection",
        userId: data.userId,
      });
      credentialBindingId = binding.id;
      authCols = derived.authColumns;
    } else {
      // auth `none`: drop any managed binding; clear the connection link when it
      // pointed at that managed binding, otherwise preserve an explicit one.
      const existingManaged = findManagedBindingByConnectionId(connectionId);
      if (existingManaged) deleteManagedBindingForConnection(connectionId);
      credentialBindingId =
        existingConnection &&
        existingManaged &&
        existingConnection.credentialBindingId === existingManaged.id
          ? null
          : (existingConnection?.credentialBindingId ?? null);
      authCols = NONE_AUTH_COLUMNS;
    }

    const params = [
      normalizedSlug,
      data.displayName ?? null,
      data.kind,
      scope,
      scopeId,
      effectiveBaseUrl,
      baseUrlSource,
      JSON.stringify(allowedHosts),
      credentialBindingId,
      authCols.authType,
      authCols.authConfigKey,
      authCols.authAuthorizationId,
      authCols.authParamName,
      authCols.authTemplateOverride,
      authCols.authHostsOverrideJson,
      openapiSpecSourceKind,
      openapiSpecSource,
      openapiSpecJson,
      openapiSpecEtag,
      openapiSpecFetchedAt,
      data.mcpServerId ?? null,
      generatedTypes,
      generatedRuntimeJson,
      generatedAt,
      generationError,
      data.enabled === false ? 0 : 1,
    ] as const;

    if (existing) {
      const row = getDb()
        .prepare<ConnectionRow, [...typeof params, string, string | null, number, string]>(
          `UPDATE script_connections SET
            slug = ?, display_name = ?, kind = ?, scope = ?, scope_id = ?, base_url = ?,
            base_url_source = ?, allowed_hosts_json = ?, credential_binding_id = ?,
            auth_type = ?, auth_config_key = ?, auth_authorization_id = ?, auth_param_name = ?,
            auth_template_override = ?, auth_hosts_override_json = ?, openapi_spec_source_kind = ?,
            openapi_spec_source = ?, openapi_spec_json = ?, openapi_spec_etag = ?,
            openapi_spec_fetched_at = ?, mcp_server_id = ?, generated_types = ?,
            generated_runtime_json = ?, generated_at = ?, generation_error = ?, enabled = ?,
            updated_at = ?, updated_by = ?, version = ?
           WHERE id = ? RETURNING *`,
        )
        .get(...params, now, data.userId ?? null, existing.version + 1, existing.id);
      if (!row) throw new Error("Failed to update script connection");
      return row;
    }

    const row = getDb()
      .prepare<
        ConnectionRow,
        [string, ...typeof params, string, string, string | null, string | null]
      >(
        `INSERT INTO script_connections
         (id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
          credential_binding_id, auth_type, auth_config_key, auth_authorization_id, auth_param_name,
          auth_template_override, auth_hosts_override_json, openapi_spec_source_kind,
          openapi_spec_source, openapi_spec_json, openapi_spec_etag, openapi_spec_fetched_at,
          mcp_server_id, generated_types, generated_runtime_json, generated_at, generation_error,
          enabled, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(connectionId, ...params, now, now, data.userId ?? null, data.userId ?? null);
    if (!row) throw new Error("Failed to create script connection");
    return row;
  });

  const row = writeConnectionAndBinding();
  if (derived?.secretWrite || supersededSecretDeleted) refreshSecretScrubberCache();
  return connectionFromRow(row);
}

export async function refreshScriptConnection(
  id: string,
  userId?: string | null,
  callerAgentId?: string,
): Promise<ScriptConnectionRecord | null> {
  const row = getDb()
    .prepare<ConnectionRow, [string]>("SELECT * FROM script_connections WHERE id = ?")
    .get(id);
  if (!row) return null;
  const connection = connectionFromRow(row);

  // MCP refresh = re-run tool discovery (servers add/remove tools over time).
  // Route through the upsert path so discovery scoping, versioning, and
  // generation-error handling stay identical to registration.
  if (connection.kind === "mcp") {
    if (!connection.mcpServerId) {
      throw new Error("MCP connection has no mcpServerId to refresh from.");
    }
    return upsertScriptConnection({
      id: connection.id,
      slug: connection.slug,
      displayName: connection.displayName,
      kind: "mcp",
      scope: connection.scope,
      scopeId: connection.scopeId,
      allowedHosts: connection.allowedHosts,
      mcpServerId: connection.mcpServerId,
      enabled: connection.enabled,
      agentId: callerAgentId,
      userId,
    });
  }

  if (connection.kind !== "openapi") {
    throw new Error("Only OpenAPI and MCP script connections can be refreshed.");
  }
  if (!connection.openapiSpecSource) {
    throw new Error("OpenAPI script connection has no source to refresh from.");
  }
  if (connection.openapiSpecSourceKind === "vendored") {
    // Same provenance rules as URL refresh: only user-set baseUrls are pinned,
    // and a default (spec-derived) allowlist re-derives if the manifest moves.
    const vendoredOldHostname = connection.baseUrl ? new URL(connection.baseUrl).hostname : null;
    const vendoredHostsWereDefault =
      connection.baseUrlSource === "spec" &&
      vendoredOldHostname !== null &&
      connection.allowedHosts.length === 1 &&
      connection.allowedHosts[0] === vendoredOldHostname;
    return upsertScriptConnection({
      id: connection.id,
      slug: connection.slug,
      displayName: connection.displayName,
      kind: "openapi",
      scope: connection.scope,
      scopeId: connection.scopeId,
      baseUrl: connection.baseUrlSource === "user" ? connection.baseUrl : undefined,
      allowedHosts: vendoredHostsWereDefault ? undefined : connection.allowedHosts,
      openapiSpecSourceKind: "vendored",
      openapiSpecSource: connection.openapiSpecSource,
      enabled: connection.enabled,
      userId,
    });
  }
  if (connection.openapiSpecSourceKind !== "url") {
    throw new Error("Only URL and vendored OpenAPI script connections can be refreshed.");
  }

  const fetched = await fetchOpenapiSpec(connection.openapiSpecSource, {
    etag: connection.openapiSpecEtag,
  });
  if (fetched.status === "not_modified") {
    const refreshed = getDb()
      .prepare<ConnectionRow, [string, string]>(
        `UPDATE script_connections
         SET openapi_spec_fetched_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(fetched.fetchedAt, id);
    return refreshed ? connectionFromRow(refreshed) : null;
  }

  const oldDerivedHostname = connection.baseUrl ? new URL(connection.baseUrl).hostname : null;
  const allowedHostsWereSpecDefault =
    connection.baseUrlSource === "spec" &&
    oldDerivedHostname !== null &&
    connection.allowedHosts.length === 1 &&
    connection.allowedHosts[0] === oldDerivedHostname;

  return upsertScriptConnection({
    id: connection.id,
    slug: connection.slug,
    displayName: connection.displayName,
    kind: "openapi",
    scope: connection.scope,
    scopeId: connection.scopeId,
    baseUrl: connection.baseUrlSource === "user" ? connection.baseUrl : undefined,
    allowedHosts: allowedHostsWereSpecDefault ? undefined : connection.allowedHosts,
    openapiSpecSourceKind: "url",
    openapiSpecSource: connection.openapiSpecSource,
    openapiSpecJson: fetched.specJson,
    openapiSpecEtag: fetched.etag,
    openapiSpecFetchedAt: fetched.fetchedAt,
    mcpServerId: connection.mcpServerId,
    enabled: connection.enabled,
    userId,
  });
}

export function setScriptConnectionEnabled(
  id: string,
  enabled: boolean,
  userId?: string | null,
): ScriptConnectionRecord | null {
  const row = getDb()
    .prepare<ConnectionRow, [number, string, string | null, string]>(
      `UPDATE script_connections
       SET enabled = ?, updated_at = ?, updated_by = ?, version = version + 1
       WHERE id = ? RETURNING *`,
    )
    .get(enabled ? 1 : 0, new Date().toISOString(), userId ?? null, id);
  return row ? connectionFromRow(row) : null;
}

export function getScriptApiConnectionDescriptors(
  context: { agentId?: string; repoId?: string } = {},
): ScriptApiConnectionDescriptor[] {
  return listScriptConnections(context)
    .filter((connection) => connection.kind === "openapi" || connection.kind === "graphql")
    .map((connection) => {
      if (!connection.generatedRuntimeJson) return null;
      try {
        return JSON.parse(connection.generatedRuntimeJson) as ScriptApiConnectionDescriptor;
      } catch {
        return null;
      }
    })
    .filter((descriptor): descriptor is ScriptApiConnectionDescriptor => Boolean(descriptor));
}

export function getScriptMcpConnectionDescriptors(
  context: { agentId?: string; repoId?: string } = {},
): ScriptMcpConnectionDescriptor[] {
  return listScriptConnections({ ...context, kind: "mcp" })
    .map((connection) => {
      if (!connection.generatedRuntimeJson) return null;
      try {
        return JSON.parse(connection.generatedRuntimeJson) as ScriptMcpConnectionDescriptor;
      } catch {
        return null;
      }
    })
    .filter((descriptor): descriptor is ScriptMcpConnectionDescriptor => Boolean(descriptor));
}

export function getScriptApiTypes(context: { agentId?: string; repoId?: string } = {}): string {
  const connections = listScriptConnections(context).filter(
    (connection) => connection.kind === "openapi" || connection.kind === "graphql",
  );
  const blocks = connections
    .filter((connection) => connection.generatedTypes)
    .map((connection) => connection.generatedTypes as string);
  if (blocks.length === 0) return "export interface ScriptApiRegistry {}\n";
  const members = connections
    .filter((connection) => connection.generatedTypes)
    .map((connection) => `  ${connection.slug}: ${pascal(connection.slug)}Api;`);
  return `${blocks.join("\n\n")}\n\nexport interface ScriptApiRegistry {\n${members.join("\n")}\n}\n`;
}

export function getScriptMcpTypes(context: { agentId?: string; repoId?: string } = {}): string {
  const connections = listScriptConnections({ ...context, kind: "mcp" });
  const blocks = connections
    .filter((connection) => connection.generatedTypes)
    .map((connection) => connection.generatedTypes as string);
  if (blocks.length === 0) return "export interface ScriptMcpRegistry {}\n";
  const members = connections
    .filter((connection) => connection.generatedTypes)
    .map((connection) => `  ${connection.slug}: ${pascal(connection.slug)}Mcp;`);
  return `${blocks.join("\n\n")}\n\nexport interface ScriptMcpRegistry {\n${members.join("\n")}\n}\n`;
}
