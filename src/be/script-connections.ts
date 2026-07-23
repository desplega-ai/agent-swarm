import { getDb, getSwarmConfigs } from "@/be/db";
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
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  type CredentialBinding,
  normalizeCredentialBindingsDocument,
} from "@/scripts-runtime/credential-broker";
import { listMcpServerTools } from "./mcp-proxy";

export type ScriptConnectionScope = "global" | "agent" | "repo";
export type ScriptConnectionKind = "raw" | "openapi" | "mcp" | "graphql";
export type ScriptConnectionBaseUrlSource = "user" | "spec";

export type ScriptConnectionBaseUrlMismatch = {
  specUrl: string;
  effectiveUrl: string;
};

export type ScriptCredentialBindingRecord = CredentialBinding & {
  id: string;
  source: "default" | "user" | "migration";
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
  openapiSpecSourceKind: "url" | "inline" | "agent_fs" | null;
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
  oauth_provider: string | null;
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
    oauthProvider: row.oauth_provider ?? undefined,
    source: row.source as ScriptCredentialBindingRecord["source"],
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
}): ScriptCredentialBindingRecord[] {
  const rows = getDb()
    .prepare<BindingRow, []>("SELECT * FROM script_credential_bindings ORDER BY config_key ASC")
    .all();
  return rows
    .map(bindingFromRow)
    .filter((binding) => context?.includeInactive || binding.active !== false)
    .filter((binding) => !context || applies(binding.scope, binding.scopeId ?? null, context));
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
}): ScriptCredentialBindingRecord | null {
  const row = getDb()
    .prepare<BindingRow, [string, string, string, string, string]>(
      `SELECT * FROM script_credential_bindings
       WHERE config_key = ?
         AND scope = ?
         AND COALESCE(scope_id, '') = ?
         AND COALESCE(header_template, '') = ?
         AND COALESCE(query_template, '') = ?`,
    )
    .get(
      data.configKey,
      data.scope,
      data.scopeId ?? "",
      data.headerTemplate ?? "",
      data.queryTemplate ?? "",
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
  oauthProvider?: string | null;
  source?: "default" | "user" | "migration";
  userId?: string | null;
}): ScriptCredentialBindingRecord {
  const now = new Date().toISOString();
  const id = data.id ?? crypto.randomUUID();
  const scope = data.scope ?? "global";
  const scopeId = scope === "global" ? null : (data.scopeId ?? null);
  const active = data.active === false ? 0 : 1;
  const authKind = data.authKind ?? "config";
  if (authKind === "oauth" && !data.oauthProvider) {
    throw new Error("oauthProvider is required for oauth credential bindings");
  }
  const oauthProvider = data.oauthProvider ?? null;
  const source = data.source ?? "user";
  const existing =
    (data.id ? getCredentialBindingById(data.id) : null) ??
    findCredentialBindingByIdentity({
      configKey: data.configKey,
      scope,
      scopeId,
      headerTemplate: data.headerTemplate,
      queryTemplate: data.queryTemplate,
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
          string,
          string,
        ]
      >(
        `UPDATE script_credential_bindings
         SET config_key = ?, allowed_hosts_json = ?, header_template = ?, query_template = ?,
             scope = ?, scope_id = ?, active = ?, auth_kind = ?, oauth_provider = ?,
             source = ?, updated_by = ?, updated_at = ?
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
        oauthProvider,
        source,
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
        string,
        string,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO script_credential_bindings
       (id, config_key, allowed_hosts_json, header_template, query_template, scope, scope_id,
        active, auth_kind, oauth_provider, source, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      oauthProvider,
      source,
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

export function importLegacyCredentialBindings(userId?: string | null): number {
  let imported = 0;
  for (const config of getSwarmConfigs({ key: CREDENTIAL_BINDINGS_CONFIG_KEY })) {
    let bindings: CredentialBinding[];
    try {
      bindings = normalizeCredentialBindingsDocument(JSON.parse(config.value));
    } catch {
      continue;
    }
    for (const binding of bindings) {
      const scope = binding.scope ?? (config.scope as ScriptConnectionScope);
      upsertCredentialBinding({
        configKey: binding.configKey,
        allowedHosts: binding.allowedHosts,
        headerTemplate: binding.headerTemplate,
        queryTemplate: binding.queryTemplate,
        scope,
        scopeId: binding.scopeId ?? config.scopeId ?? null,
        active: binding.active !== false,
        source: "migration",
        userId,
      });
      imported += 1;
    }
  }
  return imported;
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

function schemaToTs(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "JsonValue";
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") return "JsonValue";
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ") || "JsonValue";
  const type = s.type;
  if (type === "string") return "string";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return `${schemaToTs(s.items)}[]`;
  if (type === "object" || s.properties) {
    const required = new Set(
      Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : [],
    );
    const props =
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {};
    const entries = Object.entries(props);
    if (entries.length === 0) return "{ [key: string]: JsonValue }";
    return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${schemaToTs(value)}`).join("; ")} }`;
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

function jsonSchema(schema: unknown): ScriptApiJsonSchema {
  if (typeof schema === "boolean") return schema;
  const value = toJsonValue(schema);
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
      const parameters = [
        ...inheritedParams,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ]
        .filter((param): param is Record<string, unknown> =>
          Boolean(
            param &&
              typeof param === "object" &&
              typeof (param as Record<string, unknown>).name === "string",
          ),
        )
        .map((param) => ({
          name: String(param.name),
          in: (["path", "query", "header"].includes(String(param.in))
            ? String(param.in)
            : "query") as "path" | "query" | "header",
          required: param.required === true,
          type: schemaToTs(param.schema),
          schema: jsonSchema(param.schema),
        }));
      const requestBody =
        operation.requestBody && typeof operation.requestBody === "object"
          ? (operation.requestBody as Record<string, unknown>)
          : null;
      const jsonContent =
        requestBody && typeof requestBody.content === "object"
          ? (requestBody.content as Record<string, { schema?: unknown }>)["application/json"]
          : undefined;
      const requestBodySchema = jsonContent?.schema ? jsonSchema(jsonContent.schema) : undefined;
      const bodyType = jsonContent?.schema ? schemaToTs(jsonContent.schema) : "JsonValue";
      const responses =
        operation.responses && typeof operation.responses === "object"
          ? (operation.responses as Record<string, unknown>)
          : {};
      const successStatus =
        Object.keys(responses).find((status) => /^2\d\d$/.test(status)) ?? "default";
      const response = responses[successStatus];
      const responseContent =
        response &&
        typeof response === "object" &&
        typeof (response as { content?: unknown }).content === "object"
          ? (response as { content: Record<string, { schema?: unknown }> }).content[
              "application/json"
            ]
          : undefined;
      const responseType = responseContent?.schema
        ? schemaToTs(responseContent.schema)
        : "JsonValue";
      const responseSchema = responseContent?.schema ? jsonSchema(responseContent.schema) : {};
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
      const hasBody = methodAllowsBody && Boolean(jsonContent?.schema || requestBody);
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

export function buildGeneratedArtifacts(input: {
  slug: string;
  baseUrl: string;
  credentialBinding: ScriptCredentialBindingRecord | null;
  openapiSpec: unknown;
}): { generatedTypes: string; generatedRuntimeJson: string } {
  const slug = normalizeSlug(input.slug);
  const { operations, types } = extractOperations(input.openapiSpec, slug);
  const credential = credentialDescriptor(input.credentialBinding);
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

function credentialDescriptor(binding: ScriptCredentialBindingRecord | null) {
  return binding
    ? {
        configKey: binding.configKey,
        headerTemplate: binding.headerTemplate,
        queryTemplate: binding.queryTemplate,
      }
    : null;
}

export function buildGraphqlGeneratedArtifacts(input: {
  slug: string;
  baseUrl: string;
  credentialBinding: ScriptCredentialBindingRecord | null;
}): { generatedTypes: string; generatedRuntimeJson: string } {
  const slug = normalizeSlug(input.slug);
  const descriptor: ScriptApiConnectionDescriptor = {
    slug,
    kind: "graphql",
    baseUrl: input.baseUrl,
    credential: credentialDescriptor(input.credentialBinding),
  };
  const generatedTypes = [
    `export interface ${pascal(slug)}Api {`,
    "  graphql<T = JsonValue>(query: string, variables?: Record<string, JsonValue>): Promise<T>;",
    "}",
  ].join("\n");
  return { generatedTypes, generatedRuntimeJson: JSON.stringify(descriptor) };
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
  const type = schemaToTs(schema);
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
    inputSchema: jsonSchema(tool.inputSchema ?? {}),
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
  openapiSpecSourceKind?: "url" | "inline" | "agent_fs" | null;
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

  if (data.kind === "openapi") {
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
      const binding = data.credentialBindingId
        ? getCredentialBindingById(data.credentialBindingId)
        : null;
      const artifacts = buildGeneratedArtifacts({
        slug: data.slug,
        baseUrl: effectiveBaseUrl,
        credentialBinding: binding,
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
    const binding = data.credentialBindingId
      ? getCredentialBindingById(data.credentialBindingId)
      : null;
    const artifacts = buildGraphqlGeneratedArtifacts({
      slug: data.slug,
      baseUrl: data.baseUrl,
      credentialBinding: binding,
    });
    generatedTypes = artifacts.generatedTypes;
    generatedRuntimeJson = artifacts.generatedRuntimeJson;
    generatedAt = now;
  }

  if (data.kind !== "graphql") {
    allowedHosts =
      data.allowedHosts ?? (effectiveBaseUrl ? [new URL(effectiveBaseUrl).hostname] : []);
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
    data.credentialBindingId ?? null,
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
          base_url_source = ?, allowed_hosts_json = ?, credential_binding_id = ?, openapi_spec_source_kind = ?,
          openapi_spec_source = ?, openapi_spec_json = ?, openapi_spec_etag = ?,
          openapi_spec_fetched_at = ?, mcp_server_id = ?, generated_types = ?,
          generated_runtime_json = ?, generated_at = ?, generation_error = ?, enabled = ?,
          updated_at = ?, updated_by = ?, version = ?
         WHERE id = ? RETURNING *`,
      )
      .get(...params, now, data.userId ?? null, existing.version + 1, existing.id);
    if (!row) throw new Error("Failed to update script connection");
    return connectionFromRow(row);
  }

  const row = getDb()
    .prepare<
      ConnectionRow,
      [string, ...typeof params, string, string, string | null, string | null]
    >(
      `INSERT INTO script_connections
       (id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
        credential_binding_id, openapi_spec_source_kind, openapi_spec_source, openapi_spec_json,
        openapi_spec_etag, openapi_spec_fetched_at, mcp_server_id, generated_types,
        generated_runtime_json, generated_at, generation_error, enabled, created_at, updated_at,
        created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, ...params, now, now, data.userId ?? null, data.userId ?? null);
  if (!row) throw new Error("Failed to create script connection");
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
      credentialBindingId: connection.credentialBindingId,
      mcpServerId: connection.mcpServerId,
      enabled: connection.enabled,
      agentId: callerAgentId,
      userId,
    });
  }

  if (connection.kind !== "openapi") {
    throw new Error("Only OpenAPI and MCP script connections can be refreshed.");
  }
  if (connection.openapiSpecSourceKind !== "url" || !connection.openapiSpecSource) {
    throw new Error("Only OpenAPI script connections registered by URL can be refreshed.");
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
    credentialBindingId: connection.credentialBindingId,
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
