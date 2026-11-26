import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: scripts (`scripts`, `script_versions`, `script_embeddings`,
 * `script_apis`, `script_runs` (single-column reads), `script_run_sources`,
 * `script_connections`, `script_credential_bindings`). Rows come back in the
 * SQLite value shape on every engine (flags 0/1, JSON as text, timestamps as
 * the text the column stores, embeddings as bytes).
 */

export type ScriptRow = {
  id: string;
  key: string;
  name: string;
  scope: "global" | "agent";
  scopeId: string | null;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  contentHash: string;
  version: number;
  isScratch: number;
  typeChecked: number;
  fsMode: "none" | "workspace-rw";
  executor: "native" | "quickjs" | null;
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScriptVersionRow = {
  id: string;
  scriptId: string;
  version: number;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  contentHash: string;
  changedByAgentId: string | null;
  changedAt: string;
  changeReason: string | null;
};

/** A script row joined with its stored embedding (NULL columns when not joined). */
export type ScriptEmbeddingCandidateRow = ScriptRow & {
  scriptId: string | null;
  embedding: Uint8Array | null;
  embeddingModel: string | null;
  embeddedText: string | null;
  embeddedAt: string | null;
};

export type NewScript = {
  id: string;
  key: string;
  name: string;
  scope: string;
  scopeId: string | null;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  contentHash: string;
  isScratch: boolean;
  typeChecked: boolean;
  fsMode: string;
  executor: string | null;
  agentId: string | null;
  actor: string | null;
  now: string;
};

export type NewScriptVersion = {
  id: string;
  scriptId: string;
  version: number;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  contentHash: string;
  changedByAgentId: string | null;
  changedAt: string;
  changeReason: string | null;
};

/** Columns a same-content update sets. */
export type ScriptMetadataUpdate = {
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  isScratch: boolean;
  typeChecked: boolean;
  fsMode: string;
  executor: string | null;
  actor: string | null;
  agentId: string | null;
  now: string;
};

/** Columns a new-content update sets. */
export type ScriptContentUpdate = ScriptMetadataUpdate & {
  source: string;
  contentHash: string;
  version: number;
};

/** `scopeId`: undefined = any, null = IS NULL, string = equal. */
export type ScriptListFilter = {
  scope?: string;
  scopeId?: string | null;
  includeScratch: boolean;
};

/** The non-scratch scripts a search or lexical fallback may return. */
export type ScriptSearchScope =
  | { kind: "global" }
  | { kind: "agent"; scopeId: string }
  | { kind: "agentOrGlobal"; scopeId: string };

export type ScriptEmbeddingUpsert = {
  scriptId: string;
  embedding: Uint8Array;
  embeddingModel: string;
  embeddedText: string;
  embeddedAt: string;
};

export type ScriptApiRow = {
  id: string;
  scriptId: string;
  agentId: string;
  authMode: "none" | "bearer";
  bearerTokenEncrypted: string | null;
  enabled: number;
  label: string | null;
  callCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  created_by: string | null;
  updated_by: string | null;
};

export type NewScriptApi = {
  id: string;
  scriptId: string;
  agentId: string;
  authMode: string;
  bearerTokenEncrypted: string | null;
  label: string | null;
  actor: string | null;
  now: string;
};

/** `undefined` leaves a column unchanged. */
export type ScriptApiColumnUpdate = {
  enabled?: boolean;
  label?: string | null;
  updatedBy?: string | null;
};

export type ScriptCredentialBindingRow = {
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

/** Every writable column of a credential binding. */
export type ScriptCredentialBindingWrite = {
  configKey: string;
  allowedHostsJson: string;
  headerTemplate: string | null;
  queryTemplate: string | null;
  scope: string;
  scopeId: string | null;
  active: boolean;
  authKind: string;
  oauthAuthorizationId: string | null;
  source: string;
  managedByConnectionId: string | null;
  actor: string | null;
  now: string;
};

/** Identity lookup: NULL and '' compare equal on every optional column. */
export type ScriptCredentialBindingIdentity = {
  configKey: string;
  scope: string;
  scopeId: string | null;
  headerTemplate: string | null;
  queryTemplate: string | null;
  managedByConnectionId: string | null;
};

export type ScriptConnectionRow = {
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

/**
 * The columns a script run and a reachability check read. It leaves out the
 * stored OpenAPI spec and the generated types, the largest columns of a row.
 */
export type ScriptConnectionCatalogRow = Pick<
  ScriptConnectionRow,
  "slug" | "kind" | "scope" | "scope_id" | "enabled" | "generated_runtime_json"
>;

/** Every content column of a connection (insert and full update). */
export type ScriptConnectionWrite = {
  slug: string;
  displayName: string | null;
  kind: string;
  scope: string;
  scopeId: string | null;
  baseUrl: string | null;
  baseUrlSource: string;
  allowedHostsJson: string;
  credentialBindingId: string | null;
  authType: string;
  authConfigKey: string | null;
  authAuthorizationId: string | null;
  authParamName: string | null;
  authTemplateOverride: string | null;
  authHostsOverrideJson: string | null;
  openapiSpecSourceKind: string | null;
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
  actor: string | null;
  now: string;
};

/** One `script_runs` row; reads add the stored `script_run_sources` text as `storedSource`. */
export type ScriptRunRow = {
  objectScriptId: string | null;
  objectId: string | null;
  objectMethod: string | null;
  id: string;
  agentId: string;
  scriptName: string | null;
  source: string;
  storedSource?: string | null;
  args: string;
  kind: string;
  status: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  error: string | null;
  last_heartbeat_at: string | null;
  idempotencyKey: string | null;
  requestedByUserId: string | null;
  sourceTaskId: string | null;
  created_by: string | null;
  updated_by: string | null;
};

/** The list columns of a run (no source, args or output). */
export type ScriptRunListRow = Pick<
  ScriptRunRow,
  | "id"
  | "agentId"
  | "scriptName"
  | "kind"
  | "status"
  | "pid"
  | "startedAt"
  | "finishedAt"
  | "error"
  | "last_heartbeat_at"
  | "idempotencyKey"
  | "requestedByUserId"
  | "objectScriptId"
  | "objectId"
  | "objectMethod"
>;

/** Equality filters shared by the run list and count. */
export type ScriptRunListFilter = {
  status?: string;
  agentId?: string;
  scriptName?: string;
  objectScriptId?: string;
  objectId?: string;
};

export type NewScriptRunRow = {
  id: string;
  agentId: string;
  scriptName: string | null;
  sourceHash: string;
  args: string;
  idempotencyKey: string | null;
  requestedByUserId: string | null;
  sourceTaskId: string | null;
  created_by: string | null;
  updated_by: string | null;
  startedAt: string;
  parentScriptRunId: string | null;
};

/** Bounds of a run tree read: rows in all, root included, and levels below the root. */
export type ScriptRunTreeBounds = { maxRows: number; maxDepth: number };

/** Root first, then the descendants by start time. */
function sortTree(rows: ScriptRunTreeRow[]): ScriptRunTreeRow[] {
  const [root, ...rest] = rows;
  rest.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return root ? [root, ...rest] : rows;
}

/** One run of a run tree (`listScriptRunTree`). */
export type ScriptRunTreeRow = {
  id: string;
  scriptName: string | null;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type NewInlineScriptRunRow = {
  id: string;
  agentId: string;
  scriptName: string | null;
  sourceHash: string;
  args: string;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: string;
  /** Null for a run recorded as `running` before it executes (an app action's root). */
  finishedAt: string | null;
  requestedByUserId: string | null;
  created_by: string | null;
  updated_by: string | null;
  apiEndpointId: string | null;
  sourceStepId: string | null;
  parentScriptRunId: string | null;
  objectScriptId: string | null;
  objectId: string | null;
  objectMethod: string | null;
};

/** Columns a run update may set; an `undefined` value leaves the column alone. */
export type ScriptRunColumnUpdate = {
  status?: string;
  pid?: number | null;
  finishedAt?: string | null;
  output?: string | null;
  error?: string | null;
  last_heartbeat_at?: string | null;
  updated_by?: string | null;
};

/** One `script_run_journal` row. */
export type ScriptRunJournalRow = {
  id: string;
  runId: string;
  stepKey: string;
  stepType: string;
  config: string;
  status: string;
  result: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  created_by: string | null;
  updated_by: string | null;
};

export type NewScriptRunJournalStep = Pick<
  ScriptRunJournalRow,
  "id" | "runId" | "stepKey" | "stepType" | "config" | "status" | "result" | "error" | "durationMs"
>;

export interface ScriptsRepository {
  // ---- scripts ----
  /** With "ignore", a conflict on the script name and scope returns null. */
  insertScript(script: NewScript, onNameConflict?: "ignore"): Promise<ScriptRow | null>;
  updateScriptMetadata(id: string, update: ScriptMetadataUpdate): Promise<ScriptRow | null>;
  updateScriptContent(id: string, update: ScriptContentUpdate): Promise<ScriptRow | null>;
  /** The script with this name and scope; a null `scopeId` matches NULL. */
  findScriptByName(name: string, scope: string, scopeId: string | null): Promise<ScriptRow | null>;
  findScriptById(id: string): Promise<ScriptRow | null>;
  /** `(name, contentHash)` of the named global scripts. Unordered (callers build a map). */
  listGlobalScriptContentHashes(
    names: readonly string[],
  ): Promise<{ name: string; contentHash: string }[]>;
  /** Ordered by scope, scopeId (NULL first), name: unique by the name/scope index. */
  listScripts(filter: ScriptListFilter): Promise<ScriptRow[]>;
  deleteScript(id: string): Promise<number>;
  /** Sets `updatedAt` on an agent-scoped `scratch-*` scratch script. Returns the change count. */
  touchScratchScript(id: string, at: string): Promise<number>;
  /** Like `touchScratchScript`, only while `updatedAt` still equals `expectedUpdatedAt`. */
  restoreScratchScriptUpdatedAt(
    id: string,
    priorUpdatedAt: string,
    expectedUpdatedAt: string,
  ): Promise<number>;
  /** Agent-scoped `scratch-*` scratch scripts last used before `cutoff`, ordered by id. */
  listExpiredScratchScripts(
    cutoff: string,
  ): Promise<{ id: string; name: string; scopeId: string | null }[]>;
  /** Deletes the listed scripts that are still expired scratch scripts. Returns the deleted ids. */
  deleteExpiredScratchScripts(ids: readonly string[], cutoff: string): Promise<string[]>;
  /** Rewrites `argsJsonSchema` only while source and schema are unchanged. Returns the change count. */
  replaceArgsJsonSchema(
    id: string,
    contentHash: string,
    previous: string,
    next: string,
  ): Promise<number>;
  /** Distinct script ids bound to a script API endpoint. Unordered (callers build a set). */
  listScriptApiScriptIds(): Promise<string[]>;

  // ---- script_versions ----
  insertScriptVersion(version: NewScriptVersion): Promise<void>;
  findScriptVersion(scriptId: string, version: number): Promise<ScriptVersionRow | null>;
  /** The newest version with this content hash. */
  findLatestScriptVersionByHash(
    scriptId: string,
    contentHash: string,
  ): Promise<ScriptVersionRow | null>;
  /** Newest version first (version is unique per script). */
  listScriptVersions(scriptId: string): Promise<ScriptVersionRow[]>;

  // ---- script_embeddings ----
  /** Insert, or replace the stored vector of the script. */
  upsertScriptEmbedding(embedding: ScriptEmbeddingUpsert): Promise<void>;
  /**
   * Non-scratch scripts in `scope` that have an embedding, joined with it.
   * Ordered by the script's createdAt, then insertion order (the SQLite plan's
   * order before the order was written down).
   */
  listEmbeddedScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Non-scratch scripts in `scope`, embedding columns NULL. Same order as `listEmbeddedScripts`. */
  listSearchableScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Every non-scratch script, embedding columns NULL. Ordered by updatedAt, then createdAt, then insertion order. */
  listScriptsForReembed(): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Non-scratch scripts with no embedding. Same order as `listEmbeddedScripts`. */
  listScriptsMissingEmbedding(): Promise<ScriptRow[]>;
  /** Non-scratch scripts whose embedding is not `bytes` long. Same order as `listEmbeddedScripts`. */
  listScriptsWithEmbeddingSizeNot(bytes: number): Promise<ScriptRow[]>;
  countEmbeddingsWithSizeNot(bytes: number): Promise<number>;
  /** Non-scratch scripts whose id sorts after `afterId`, by id, at most `limit` (the re-embed cursor). */
  listNonScratchScriptsAfter(afterId: string, limit: number): Promise<ScriptRow[]>;
  deleteScriptEmbedding(scriptId: string): Promise<void>;

  // ---- script_apis ----
  insertScriptApi(api: NewScriptApi): Promise<ScriptApiRow | null>;
  /** Every stored encrypted token. Unordered (callers register each). */
  listScriptApiSecrets(): Promise<{ id: string; bearerTokenEncrypted: string }[]>;
  /** Newest first; ties keep insertion order. */
  listScriptApisForScript(scriptId: string): Promise<ScriptApiRow[]>;
  findScriptApiById(id: string): Promise<ScriptApiRow | null>;
  /** Sets the given columns; with none given, reads the row. */
  updateScriptApi(id: string, update: ScriptApiColumnUpdate): Promise<ScriptApiRow | null>;
  setScriptApiToken(
    id: string,
    bearerTokenEncrypted: string,
    updatedBy: string | null,
  ): Promise<ScriptApiRow | null>;
  deleteScriptApi(id: string): Promise<number>;
  recordScriptApiUsage(id: string, at: string): Promise<void>;

  // ---- script_runs, script_run_sources ----
  getScriptRunArgs(id: string): Promise<{ args: string } | null>;
  /** Null when the run has no row. */
  getScriptRunFollowUpGuard(id: string): Promise<{ followUpGuard: string | null } | null>;
  setScriptRunFollowUpGuard(id: string, decision: string): Promise<void>;
  /** Stores the source under its hash; an existing hash keeps its row. */
  storeScriptRunSource(hash: string, source: string): Promise<void>;

  // ---- script_credential_bindings ----
  /** Ordered by config_key, then insertion order. */
  listCredentialBindings(): Promise<ScriptCredentialBindingRow[]>;
  findCredentialBindingById(id: string): Promise<ScriptCredentialBindingRow | null>;
  findManagedCredentialBinding(connectionId: string): Promise<ScriptCredentialBindingRow | null>;
  findCredentialBindingByIdentity(
    identity: ScriptCredentialBindingIdentity,
  ): Promise<ScriptCredentialBindingRow | null>;
  insertCredentialBinding(
    id: string,
    binding: ScriptCredentialBindingWrite,
  ): Promise<ScriptCredentialBindingRow | null>;
  updateCredentialBinding(
    id: string,
    binding: ScriptCredentialBindingWrite,
  ): Promise<ScriptCredentialBindingRow | null>;
  disableCredentialBinding(
    id: string,
    actor: string | null,
    now: string,
  ): Promise<ScriptCredentialBindingRow | null>;
  deleteManagedCredentialBindings(connectionId: string): Promise<void>;

  // ---- script_connections ----
  /** Ordered by slug, scope, scope_id (unique by the slug/scope index). */
  listConnections(): Promise<ScriptConnectionRow[]>;
  /** {@link listConnections} with the catalog columns only, in the same order. */
  listConnectionCatalog(): Promise<ScriptConnectionCatalogRow[]>;
  findConnectionById(id: string): Promise<ScriptConnectionRow | null>;
  /** NULL and '' scope ids compare equal. */
  findConnectionBySlug(
    slug: string,
    scope: string,
    scopeId: string | null,
  ): Promise<ScriptConnectionRow | null>;
  insertConnection(
    id: string,
    connection: ScriptConnectionWrite,
  ): Promise<ScriptConnectionRow | null>;
  /** Full update guarded by `expectedVersion`; bumps the version. Null on a version mismatch. */
  updateConnection(
    id: string,
    connection: ScriptConnectionWrite,
    expectedVersion: number,
  ): Promise<ScriptConnectionRow | null>;
  setConnectionSpecFetchedAt(id: string, fetchedAt: string): Promise<ScriptConnectionRow | null>;
  /** Sets enabled and bumps the version. */
  setConnectionEnabled(
    id: string,
    enabled: boolean,
    actor: string | null,
    now: string,
  ): Promise<ScriptConnectionRow | null>;
  deleteConnection(id: string): Promise<void>;
  /**
   * Defers foreign-key checks to the end of the current transaction (the
   * connection and its managed binding reference each other).
   */
  deferForeignKeys(): Promise<void>;
  // ---- script_runs ----
  /** The run with its stored source. */
  findScriptRun(id: string): Promise<ScriptRunRow | null>;
  findScriptRunByIdempotencyKey(idempotencyKey: string): Promise<ScriptRunRow | null>;
  insertScriptRun(row: NewScriptRunRow): Promise<ScriptRunRow | null>;
  insertInlineScriptRun(row: NewInlineScriptRunRow): Promise<ScriptRunRow | null>;
  /**
   * The run and every descendant over `parentScriptRunId`, at most `limit`
   * rows, root first. Empty when the root does not exist.
   */
  listScriptRunTree(
    rootId: string,
    bounds: ScriptRunTreeBounds,
  ): Promise<{ rows: ScriptRunTreeRow[]; truncated: boolean }>;
  /** Newest `startedAt` first, then insertion order (newest first). */
  listScriptRuns(
    f: ScriptRunListFilter,
    limit: number,
    offset: number,
  ): Promise<ScriptRunListRow[]>;
  countScriptRuns(f: ScriptRunListFilter): Promise<number>;
  countActiveScriptRuns(): Promise<number>;
  /**
   * Sets the given columns. `guard` re-checks the status: `not-terminal` or
   * `running`. Returns the change count (0 when nothing to set).
   */
  updateScriptRun(
    id: string,
    update: ScriptRunColumnUpdate,
    guard?: "not-terminal" | "running",
  ): Promise<number>;
  /** Running and paused supervised (non-inline) runs with their stored source, in insertion order. */
  listActiveScriptRuns(): Promise<ScriptRunRow[]>;

  // ---- script_run_journal ----
  findScriptRunJournalStep(runId: string, stepKey: string): Promise<ScriptRunJournalRow | null>;
  /** Inserts the step unless (runId, stepKey) exists; `completedAt` takes the database clock. */
  insertScriptRunJournalStep(row: NewScriptRunJournalStep): Promise<void>;
  /** By `startedAt`, then insertion order. */
  listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalRow[]>;
  /** Steps of the run, optionally of one step type. */
  countScriptRunJournalSteps(runId: string, stepType?: string): Promise<number>;
}

function searchScope(scope: ScriptSearchScope, alias: SqlQuery): SqlQuery {
  switch (scope.kind) {
    case "global":
      return sql`${alias}scope = 'global' AND ${alias}"scopeId" IS NULL`;
    case "agent":
      return sql`${alias}scope = 'agent' AND ${alias}"scopeId" = ${scope.scopeId}`;
    case "agentOrGlobal":
      return sql`((${alias}scope = 'agent' AND ${alias}"scopeId" = ${scope.scopeId}) OR (${alias}scope = 'global' AND ${alias}"scopeId" IS NULL))`;
  }
}

/** The predicate of an agent-scoped `scratch-*` scratch script (GLOB 'scratch-*' as a prefix test). */
const SCRATCH = sql`scope = 'agent' AND "isScratch" = ${true} AND substr(name, 1, 8) = 'scratch-'`;

export abstract class BaseScriptsRepository implements ScriptsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  protected searchScopeSql(scope: ScriptSearchScope, alias: "s." | ""): SqlQuery {
    return searchScope(scope, alias === "" ? sql`` : sql`s.`);
  }

  // ---- scripts ----

  insertScript(s: NewScript, onNameConflict?: "ignore"): Promise<ScriptRow | null> {
    const conflictClause =
      onNameConflict === "ignore"
        ? sql`ON CONFLICT (name, scope, COALESCE("scopeId", '')) DO NOTHING`
        : EMPTY;
    return this.db.get<ScriptRow>(sql`
      INSERT INTO scripts (
        id, "key", name, scope, "scopeId", source, description, intent, "signatureJson",
        "argsJsonSchema", "contentHash", "isScratch", "typeChecked", "fsMode", executor,
        "createdByAgentId", "createdAt", "updatedAt", created_by, updated_by, "updatedByAgentId"
      ) VALUES (
        ${s.id}, ${s.key}, ${s.name}, ${s.scope}, ${s.scopeId}, ${s.source}, ${s.description},
        ${s.intent}, ${s.signatureJson}, ${s.argsJsonSchema}, ${s.contentHash}, ${s.isScratch},
        ${s.typeChecked}, ${s.fsMode}, ${s.executor}, ${s.agentId}, ${s.now}, ${s.now},
        ${s.actor}, ${s.actor}, ${s.agentId}
      )
      ${conflictClause}
      RETURNING *`);
  }

  updateScriptMetadata(id: string, u: ScriptMetadataUpdate): Promise<ScriptRow | null> {
    return this.db.get<ScriptRow>(sql`
      UPDATE scripts SET
        description = ${u.description}, intent = ${u.intent}, "signatureJson" = ${u.signatureJson},
        "argsJsonSchema" = ${u.argsJsonSchema}, "isScratch" = ${u.isScratch},
        "typeChecked" = ${u.typeChecked}, "fsMode" = ${u.fsMode}, executor = ${u.executor},
        "updatedAt" = ${u.now}, updated_by = ${u.actor}, "updatedByAgentId" = ${u.agentId}
      WHERE id = ${id}
      RETURNING *`);
  }

  updateScriptContent(id: string, u: ScriptContentUpdate): Promise<ScriptRow | null> {
    return this.db.get<ScriptRow>(sql`
      UPDATE scripts SET
        source = ${u.source}, description = ${u.description}, intent = ${u.intent},
        "signatureJson" = ${u.signatureJson}, "argsJsonSchema" = ${u.argsJsonSchema},
        "contentHash" = ${u.contentHash}, version = ${u.version}, "isScratch" = ${u.isScratch},
        "typeChecked" = ${u.typeChecked}, "fsMode" = ${u.fsMode}, executor = ${u.executor},
        "updatedAt" = ${u.now}, updated_by = ${u.actor}, "updatedByAgentId" = ${u.agentId}
      WHERE id = ${id}
      RETURNING *`);
  }

  findScriptByName(name: string, scope: string, scopeId: string | null): Promise<ScriptRow | null> {
    return this.db.get<ScriptRow>(
      scopeId === null
        ? sql`SELECT * FROM scripts WHERE name = ${name} AND scope = ${scope} AND "scopeId" IS NULL`
        : sql`SELECT * FROM scripts WHERE name = ${name} AND scope = ${scope} AND "scopeId" = ${scopeId}`,
    );
  }

  findScriptById(id: string): Promise<ScriptRow | null> {
    return this.db.get<ScriptRow>(sql`SELECT * FROM scripts WHERE id = ${id}`);
  }

  async listGlobalScriptContentHashes(
    names: readonly string[],
  ): Promise<{ name: string; contentHash: string }[]> {
    if (names.length === 0) return [];
    return this.db.query<{ name: string; contentHash: string }>(sql`
      SELECT name, "contentHash" FROM scripts
      WHERE scope = 'global' AND "scopeId" IS NULL AND name IN (${sqlList(names)})`);
  }

  listScripts(filter: ScriptListFilter): Promise<ScriptRow[]> {
    const conditions: SqlQuery[] = [];
    if (filter.scope !== undefined) conditions.push(sql`scope = ${filter.scope}`);
    if (filter.scopeId === null) conditions.push(sql`"scopeId" IS NULL`);
    else if (filter.scopeId !== undefined) conditions.push(sql`"scopeId" = ${filter.scopeId}`);
    if (!filter.includeScratch) conditions.push(sql`"isScratch" = ${false}`);
    return this.db.query<ScriptRow>(sql`
      SELECT * FROM scripts${sqlWhere(conditions)}
      ORDER BY scope ASC, "scopeId" ASC NULLS FIRST, name ASC`);
  }

  async deleteScript(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM scripts WHERE id = ${id}`)).changes;
  }

  async touchScratchScript(id: string, at: string): Promise<number> {
    return (
      await this.db.run(sql`UPDATE scripts SET "updatedAt" = ${at} WHERE id = ${id} AND ${SCRATCH}`)
    ).changes;
  }

  async restoreScratchScriptUpdatedAt(
    id: string,
    priorUpdatedAt: string,
    expectedUpdatedAt: string,
  ): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE scripts SET "updatedAt" = ${priorUpdatedAt}
        WHERE id = ${id} AND ${SCRATCH} AND "updatedAt" = ${expectedUpdatedAt}`)
    ).changes;
  }

  listExpiredScratchScripts(
    cutoff: string,
  ): Promise<{ id: string; name: string; scopeId: string | null }[]> {
    return this.db.query<{ id: string; name: string; scopeId: string | null }>(sql`
      SELECT id, name, "scopeId" FROM scripts
      WHERE ${SCRATCH} AND "updatedAt" < ${cutoff}
      ORDER BY id`);
  }

  async deleteExpiredScratchScripts(ids: readonly string[], cutoff: string): Promise<string[]> {
    if (ids.length === 0) return [];
    // RETURNING counts scripts only; SQLite's change count includes cascaded rows.
    const rows = await this.db.query<{ id: string }>(sql`
      DELETE FROM scripts
      WHERE id IN (${sqlList(ids)}) AND ${SCRATCH} AND "updatedAt" < ${cutoff}
      RETURNING id`);
    return rows.map((row) => row.id);
  }

  async replaceArgsJsonSchema(
    id: string,
    contentHash: string,
    previous: string,
    next: string,
  ): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE scripts SET "argsJsonSchema" = ${next}
        WHERE id = ${id} AND "contentHash" = ${contentHash} AND "argsJsonSchema" = ${previous}`)
    ).changes;
  }

  async listScriptApiScriptIds(): Promise<string[]> {
    const rows = await this.db.query<{ scriptId: string }>(
      sql`SELECT DISTINCT "scriptId" FROM script_apis`,
    );
    return rows.map((row) => row.scriptId);
  }

  // ---- script_versions ----

  async insertScriptVersion(v: NewScriptVersion): Promise<void> {
    await this.db.run(sql`
      INSERT INTO script_versions (
        id, "scriptId", version, source, description, intent, "signatureJson",
        "contentHash", "changedByAgentId", "changedAt", "changeReason"
      ) VALUES (
        ${v.id}, ${v.scriptId}, ${v.version}, ${v.source}, ${v.description}, ${v.intent},
        ${jsonText(v.signatureJson)}, ${v.contentHash}, ${v.changedByAgentId}, ${v.changedAt}, ${v.changeReason}
      )`);
  }

  findScriptVersion(scriptId: string, version: number): Promise<ScriptVersionRow | null> {
    return this.db.get<ScriptVersionRow>(
      sql`SELECT * FROM script_versions WHERE "scriptId" = ${scriptId} AND version = ${version}`,
    );
  }

  findLatestScriptVersionByHash(
    scriptId: string,
    contentHash: string,
  ): Promise<ScriptVersionRow | null> {
    return this.db.get<ScriptVersionRow>(sql`
      SELECT * FROM script_versions WHERE "scriptId" = ${scriptId} AND "contentHash" = ${contentHash}
      ORDER BY version DESC LIMIT 1`);
  }

  listScriptVersions(scriptId: string): Promise<ScriptVersionRow[]> {
    return this.db.query<ScriptVersionRow>(
      sql`SELECT * FROM script_versions WHERE "scriptId" = ${scriptId} ORDER BY version DESC`,
    );
  }

  // ---- script_embeddings ----

  async upsertScriptEmbedding(e: ScriptEmbeddingUpsert): Promise<void> {
    await this.db.run(sql`
      INSERT INTO script_embeddings (
        "scriptId", embedding, "embeddingModel", "embeddedText", "embeddedAt"
      ) VALUES (${e.scriptId}, ${e.embedding}, ${e.embeddingModel}, ${e.embeddedText}, ${e.embeddedAt})
      ON CONFLICT ("scriptId") DO UPDATE SET
        embedding = excluded.embedding,
        "embeddingModel" = excluded."embeddingModel",
        "embeddedText" = excluded."embeddedText",
        "embeddedAt" = excluded."embeddedAt"`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listEmbeddedScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listSearchableScripts(scope: ScriptSearchScope): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listScriptsForReembed(): Promise<ScriptEmbeddingCandidateRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listScriptsMissingEmbedding(): Promise<ScriptRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listScriptsWithEmbeddingSizeNot(bytes: number): Promise<ScriptRow[]>;

  async countEmbeddingsWithSizeNot(bytes: number): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM script_embeddings WHERE length(embedding) != ${bytes}`,
    );
    return Number(row?.count ?? 0);
  }

  listNonScratchScriptsAfter(afterId: string, limit: number): Promise<ScriptRow[]> {
    return this.db.query<ScriptRow>(sql`
      SELECT * FROM scripts WHERE "isScratch" = ${false} AND id > ${afterId}
      ORDER BY id ASC LIMIT ${limit}`);
  }

  async deleteScriptEmbedding(scriptId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM script_embeddings WHERE "scriptId" = ${scriptId}`);
  }

  // ---- script_apis ----

  insertScriptApi(a: NewScriptApi): Promise<ScriptApiRow | null> {
    return this.db.get<ScriptApiRow>(sql`
      INSERT INTO script_apis (
        id, "scriptId", "agentId", "authMode", "bearerTokenEncrypted", enabled, label,
        "callCount", "lastUsedAt", "createdAt", created_by, updated_by
      ) VALUES (
        ${a.id}, ${a.scriptId}, ${a.agentId}, ${a.authMode}, ${a.bearerTokenEncrypted}, ${true},
        ${a.label}, 0, NULL, ${a.now}, ${a.actor}, ${a.actor}
      )
      RETURNING *`);
  }

  listScriptApiSecrets(): Promise<{ id: string; bearerTokenEncrypted: string }[]> {
    return this.db.query<{ id: string; bearerTokenEncrypted: string }>(sql`
      SELECT id, "bearerTokenEncrypted" FROM script_apis WHERE "bearerTokenEncrypted" IS NOT NULL`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listScriptApisForScript(scriptId: string): Promise<ScriptApiRow[]>;

  findScriptApiById(id: string): Promise<ScriptApiRow | null> {
    return this.db.get<ScriptApiRow>(sql`SELECT * FROM script_apis WHERE id = ${id}`);
  }

  updateScriptApi(id: string, u: ScriptApiColumnUpdate): Promise<ScriptApiRow | null> {
    const sets: SqlQuery[] = [];
    if (u.enabled !== undefined) sets.push(sql`enabled = ${u.enabled}`);
    if (u.label !== undefined) sets.push(sql`label = ${u.label}`);
    if (u.updatedBy !== undefined) sets.push(sql`updated_by = ${u.updatedBy}`);
    if (sets.length === 0) return this.findScriptApiById(id);
    return this.db.get<ScriptApiRow>(
      sql`UPDATE script_apis SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  setScriptApiToken(
    id: string,
    bearerTokenEncrypted: string,
    updatedBy: string | null,
  ): Promise<ScriptApiRow | null> {
    return this.db.get<ScriptApiRow>(sql`
      UPDATE script_apis SET "bearerTokenEncrypted" = ${bearerTokenEncrypted}, updated_by = ${updatedBy}
      WHERE id = ${id} RETURNING *`);
  }

  async deleteScriptApi(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM script_apis WHERE id = ${id}`)).changes;
  }

  async recordScriptApiUsage(id: string, at: string): Promise<void> {
    await this.db.run(sql`
      UPDATE script_apis SET "callCount" = "callCount" + 1, "lastUsedAt" = ${at} WHERE id = ${id}`);
  }

  // ---- script_runs, script_run_sources ----

  getScriptRunArgs(id: string): Promise<{ args: string } | null> {
    return this.db.get<{ args: string }>(sql`SELECT args FROM script_runs WHERE id = ${id}`);
  }

  getScriptRunFollowUpGuard(id: string): Promise<{ followUpGuard: string | null } | null> {
    return this.db.get<{ followUpGuard: string | null }>(
      sql`SELECT "followUpGuard" FROM script_runs WHERE id = ${id}`,
    );
  }

  async setScriptRunFollowUpGuard(id: string, decision: string): Promise<void> {
    await this.db.run(sql`UPDATE script_runs SET "followUpGuard" = ${decision} WHERE id = ${id}`);
  }

  async storeScriptRunSource(hash: string, source: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO script_run_sources (hash, source) VALUES (${hash}, ${source})
      ON CONFLICT (hash) DO NOTHING`);
  }

  // ---- script_credential_bindings ----

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listCredentialBindings(): Promise<ScriptCredentialBindingRow[]>;

  findCredentialBindingById(id: string): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(
      sql`SELECT * FROM script_credential_bindings WHERE id = ${id}`,
    );
  }

  findManagedCredentialBinding(connectionId: string): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(
      sql`SELECT * FROM script_credential_bindings WHERE managed_by_connection_id = ${connectionId}`,
    );
  }

  findCredentialBindingByIdentity(
    i: ScriptCredentialBindingIdentity,
  ): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(sql`
      SELECT * FROM script_credential_bindings
      WHERE config_key = ${i.configKey}
        AND scope = ${i.scope}
        AND COALESCE(scope_id, '') = ${i.scopeId ?? ""}
        AND COALESCE(header_template, '') = ${i.headerTemplate ?? ""}
        AND COALESCE(query_template, '') = ${i.queryTemplate ?? ""}
        AND COALESCE(managed_by_connection_id, '') = ${i.managedByConnectionId ?? ""}`);
  }

  insertCredentialBinding(
    id: string,
    b: ScriptCredentialBindingWrite,
  ): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(sql`
      INSERT INTO script_credential_bindings (
        id, config_key, allowed_hosts_json, header_template, query_template, scope, scope_id,
        active, auth_kind, oauth_authorization_id, source, managed_by_connection_id,
        created_at, updated_at, created_by, updated_by
      ) VALUES (
        ${id}, ${b.configKey}, ${jsonText(b.allowedHostsJson)}, ${b.headerTemplate}, ${b.queryTemplate},
        ${b.scope}, ${b.scopeId}, ${b.active}, ${b.authKind}, ${b.oauthAuthorizationId}, ${b.source},
        ${b.managedByConnectionId}, ${b.now}, ${b.now}, ${b.actor}, ${b.actor}
      ) RETURNING *`);
  }

  updateCredentialBinding(
    id: string,
    b: ScriptCredentialBindingWrite,
  ): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(sql`
      UPDATE script_credential_bindings SET
        config_key = ${b.configKey}, allowed_hosts_json = ${jsonText(b.allowedHostsJson)},
        header_template = ${b.headerTemplate}, query_template = ${b.queryTemplate},
        scope = ${b.scope}, scope_id = ${b.scopeId}, active = ${b.active}, auth_kind = ${b.authKind},
        oauth_authorization_id = ${b.oauthAuthorizationId}, source = ${b.source},
        managed_by_connection_id = ${b.managedByConnectionId}, updated_by = ${b.actor},
        updated_at = ${b.now}
      WHERE id = ${id} RETURNING *`);
  }

  disableCredentialBinding(
    id: string,
    actor: string | null,
    now: string,
  ): Promise<ScriptCredentialBindingRow | null> {
    return this.db.get<ScriptCredentialBindingRow>(sql`
      UPDATE script_credential_bindings SET active = ${false}, updated_at = ${now}, updated_by = ${actor}
      WHERE id = ${id} RETURNING *`);
  }

  async deleteManagedCredentialBindings(connectionId: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM script_credential_bindings WHERE managed_by_connection_id = ${connectionId}`,
    );
  }

  // ---- script_connections ----

  listConnections(): Promise<ScriptConnectionRow[]> {
    return this.db.query<ScriptConnectionRow>(
      sql`SELECT * FROM script_connections ORDER BY slug ASC, scope ASC, COALESCE(scope_id, '') ASC`,
    );
  }

  listConnectionCatalog(): Promise<ScriptConnectionCatalogRow[]> {
    return this.db.query<ScriptConnectionCatalogRow>(
      sql`SELECT slug, kind, scope, scope_id, enabled, generated_runtime_json FROM script_connections ORDER BY slug ASC, scope ASC, COALESCE(scope_id, '') ASC`,
    );
  }

  findConnectionById(id: string): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`SELECT * FROM script_connections WHERE id = ${id}`);
  }

  findConnectionBySlug(
    slug: string,
    scope: string,
    scopeId: string | null,
  ): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`
      SELECT * FROM script_connections
      WHERE slug = ${slug} AND scope = ${scope} AND COALESCE(scope_id, '') = COALESCE(${scopeId}, '')`);
  }

  insertConnection(id: string, c: ScriptConnectionWrite): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`
      INSERT INTO script_connections (
        id, slug, display_name, kind, scope, scope_id, base_url, base_url_source, allowed_hosts_json,
        credential_binding_id, auth_type, auth_config_key, auth_authorization_id, auth_param_name,
        auth_template_override, auth_hosts_override_json, openapi_spec_source_kind,
        openapi_spec_source, openapi_spec_json, openapi_spec_etag, openapi_spec_fetched_at,
        mcp_server_id, generated_types, generated_runtime_json, generated_at, generation_error,
        enabled, created_at, updated_at, created_by, updated_by
      ) VALUES (
        ${id}, ${c.slug}, ${c.displayName}, ${c.kind}, ${c.scope}, ${c.scopeId}, ${c.baseUrl},
        ${c.baseUrlSource}, ${jsonText(c.allowedHostsJson)}, ${c.credentialBindingId}, ${c.authType},
        ${c.authConfigKey}, ${c.authAuthorizationId}, ${c.authParamName}, ${c.authTemplateOverride},
        ${jsonText(c.authHostsOverrideJson)}, ${c.openapiSpecSourceKind}, ${c.openapiSpecSource},
        ${c.openapiSpecJson}, ${c.openapiSpecEtag}, ${c.openapiSpecFetchedAt}, ${c.mcpServerId},
        ${c.generatedTypes}, ${jsonText(c.generatedRuntimeJson)}, ${c.generatedAt}, ${c.generationError},
        ${c.enabled}, ${c.now}, ${c.now}, ${c.actor}, ${c.actor}
      ) RETURNING *`);
  }

  updateConnection(
    id: string,
    c: ScriptConnectionWrite,
    expectedVersion: number,
  ): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`
      UPDATE script_connections SET
        slug = ${c.slug}, display_name = ${c.displayName}, kind = ${c.kind}, scope = ${c.scope},
        scope_id = ${c.scopeId}, base_url = ${c.baseUrl}, base_url_source = ${c.baseUrlSource},
        allowed_hosts_json = ${jsonText(c.allowedHostsJson)}, credential_binding_id = ${c.credentialBindingId},
        auth_type = ${c.authType}, auth_config_key = ${c.authConfigKey},
        auth_authorization_id = ${c.authAuthorizationId}, auth_param_name = ${c.authParamName},
        auth_template_override = ${c.authTemplateOverride},
        auth_hosts_override_json = ${jsonText(c.authHostsOverrideJson)},
        openapi_spec_source_kind = ${c.openapiSpecSourceKind},
        openapi_spec_source = ${c.openapiSpecSource}, openapi_spec_json = ${c.openapiSpecJson},
        openapi_spec_etag = ${c.openapiSpecEtag}, openapi_spec_fetched_at = ${c.openapiSpecFetchedAt},
        mcp_server_id = ${c.mcpServerId}, generated_types = ${c.generatedTypes},
        generated_runtime_json = ${jsonText(c.generatedRuntimeJson)}, generated_at = ${c.generatedAt},
        generation_error = ${c.generationError}, enabled = ${c.enabled},
        updated_at = ${c.now}, updated_by = ${c.actor}, version = ${expectedVersion + 1}
      WHERE id = ${id} AND version = ${expectedVersion} RETURNING *`);
  }

  setConnectionSpecFetchedAt(id: string, fetchedAt: string): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`
      UPDATE script_connections SET openapi_spec_fetched_at = ${fetchedAt} WHERE id = ${id} RETURNING *`);
  }

  setConnectionEnabled(
    id: string,
    enabled: boolean,
    actor: string | null,
    now: string,
  ): Promise<ScriptConnectionRow | null> {
    return this.db.get<ScriptConnectionRow>(sql`
      UPDATE script_connections
      SET enabled = ${enabled}, updated_at = ${now}, updated_by = ${actor}, version = version + 1
      WHERE id = ${id} RETURNING *`);
  }

  async deleteConnection(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM script_connections WHERE id = ${id}`);
  }

  /** Engine-specific statement (SQLite `PRAGMA defer_foreign_keys`). */
  abstract deferForeignKeys(): Promise<void>;

  // ---- script_runs ----

  /** Runs with their stored source: legacy inline text stays readable during the backfill. */
  protected readonly scriptRunSelect = sql`SELECT r.*, s.source AS "storedSource" FROM script_runs r
    LEFT JOIN script_run_sources s ON s.hash = r."sourceHash"`;

  findScriptRun(id: string): Promise<ScriptRunRow | null> {
    return this.db.get<ScriptRunRow>(sql`${this.scriptRunSelect} WHERE r.id = ${id}`);
  }

  findScriptRunByIdempotencyKey(idempotencyKey: string): Promise<ScriptRunRow | null> {
    return this.db.get<ScriptRunRow>(
      sql`${this.scriptRunSelect} WHERE r."idempotencyKey" = ${idempotencyKey}`,
    );
  }

  insertScriptRun(r: NewScriptRunRow): Promise<ScriptRunRow | null> {
    return this.db.get<ScriptRunRow>(sql`
      INSERT INTO script_runs
        (id, "agentId", "scriptName", source, "sourceHash", args, "idempotencyKey",
         "requestedByUserId", "sourceTaskId", created_by, updated_by, "startedAt",
         "parentScriptRunId")
      VALUES (${r.id}, ${r.agentId}, ${r.scriptName}, '', ${r.sourceHash}, ${r.args},
        ${r.idempotencyKey}, ${r.requestedByUserId}, ${r.sourceTaskId}, ${r.created_by},
        ${r.updated_by}, ${r.startedAt}, ${r.parentScriptRunId})
      RETURNING *`);
  }

  async listScriptRunTree(
    rootId: string,
    bounds: ScriptRunTreeBounds,
  ): Promise<{ rows: ScriptRunTreeRow[]; truncated: boolean }> {
    // One LIMITed query per level instead of a recursive CTE: Postgres rejects
    // LIMIT in a recursive term, and an outer LIMIT after ORDER BY still walks
    // the whole tree. Here each read stops at the rows still allowed: the
    // ORDER BY matches idx_script_runs_parent_started, so neither engine sorts
    // a wide level before the LIMIT (test: script-run-tree-plan on both engines).
    const cols = sql`id, "scriptName", status, error, "startedAt", "finishedAt"`;
    const root = await this.db.get<ScriptRunTreeRow>(
      sql`SELECT ${cols} FROM script_runs WHERE id = ${rootId}`,
    );
    if (!root) return { rows: [], truncated: false };
    const rows = [root];
    const seen = new Set([root.id]);
    let frontier = [root.id];
    for (let depth = 1; frontier.length > 0; depth++) {
      const room = bounds.maxRows - rows.length;
      // At a bound, one probe row tells whether the tree goes on (`truncated`).
      const atBound = room <= 0 || depth > bounds.maxDepth;
      const level = await this.db.query<ScriptRunTreeRow>(sql`
        SELECT ${cols} FROM script_runs
        WHERE "parentScriptRunId" IN (${sqlList(frontier)})
        ORDER BY "parentScriptRunId", "startedAt", id
        LIMIT ${atBound ? 1 : room + 1}`);
      // A revisited id is a parent cycle: drop it so the walk still ends.
      const fresh = level.filter((r) => !seen.has(r.id));
      if (atBound) return { rows: sortTree(rows), truncated: fresh.length > 0 };
      // shortcut: a cycle row can fill the probe slot and read as truncated; cycles need a hand-edited parent.
      const truncated = level.length > room;
      const kept = fresh.slice(0, room);
      for (const r of kept) seen.add(r.id);
      rows.push(...kept);
      if (truncated) return { rows: sortTree(rows), truncated: true };
      frontier = kept.map((r) => r.id);
    }
    return { rows: sortTree(rows), truncated: false };
  }

  insertInlineScriptRun(r: NewInlineScriptRunRow): Promise<ScriptRunRow | null> {
    return this.db.get<ScriptRunRow>(sql`
      INSERT INTO script_runs
        (id, "agentId", "scriptName", source, "sourceHash", args, kind, status, output, error,
         "startedAt", "finishedAt", "requestedByUserId", created_by, updated_by, "apiEndpointId",
         "sourceStepId", "parentScriptRunId", "objectScriptId", "objectId", "objectMethod")
      VALUES (${r.id}, ${r.agentId}, ${r.scriptName}, '', ${r.sourceHash}, ${r.args}, 'inline',
        ${r.status}, ${r.output}, ${r.error}, ${r.startedAt}, ${r.finishedAt}, ${r.requestedByUserId},
        ${r.created_by}, ${r.updated_by}, ${r.apiEndpointId}, ${r.sourceStepId},
        ${r.parentScriptRunId}, ${r.objectScriptId}, ${r.objectId}, ${r.objectMethod})
      RETURNING *`);
  }

  protected scriptRunWhere(f: ScriptRunListFilter): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (f.status) conditions.push(sql`status = ${f.status}`);
    if (f.agentId) conditions.push(sql`"agentId" = ${f.agentId}`);
    if (f.scriptName) conditions.push(sql`"scriptName" = ${f.scriptName}`);
    if (f.objectScriptId) conditions.push(sql`"objectScriptId" = ${f.objectScriptId}`);
    if (f.objectId) conditions.push(sql`"objectId" = ${f.objectId}`);
    return sqlWhere(conditions);
  }

  abstract listScriptRuns(
    f: ScriptRunListFilter,
    limit: number,
    offset: number,
  ): Promise<ScriptRunListRow[]>;

  async countScriptRuns(f: ScriptRunListFilter): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM script_runs${this.scriptRunWhere(f)}`,
    );
    return row?.count ?? 0;
  }

  async countActiveScriptRuns(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      // Inline rows run in-process, never under the supervisor or its cap.
      sql`SELECT COUNT(*) AS count FROM script_runs WHERE status IN ('running', 'paused') AND kind <> 'inline'`,
    );
    return row?.count ?? 0;
  }

  async updateScriptRun(
    id: string,
    u: ScriptRunColumnUpdate,
    guard?: "not-terminal" | "running",
  ): Promise<number> {
    const sets: SqlQuery[] = [];
    if (u.status !== undefined) sets.push(sql`status = ${u.status}`);
    if (u.pid !== undefined) sets.push(sql`pid = ${u.pid}`);
    if (u.finishedAt !== undefined) sets.push(sql`"finishedAt" = ${u.finishedAt}`);
    if (u.output !== undefined) sets.push(sql`output = ${u.output}`);
    if (u.error !== undefined) sets.push(sql`error = ${u.error}`);
    if (u.last_heartbeat_at !== undefined)
      sets.push(sql`last_heartbeat_at = ${u.last_heartbeat_at}`);
    if (u.updated_by !== undefined) sets.push(sql`updated_by = ${u.updated_by}`);
    if (sets.length === 0) return 0;
    const guardSql =
      guard === "not-terminal"
        ? sql` AND status NOT IN ('completed', 'failed', 'cancelled', 'aborted_limit')`
        : guard === "running"
          ? sql` AND status = 'running'`
          : EMPTY;
    const result = await this.db.run(
      sql`UPDATE script_runs SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id}${guardSql}`,
    );
    return result.changes;
  }

  abstract listActiveScriptRuns(): Promise<ScriptRunRow[]>;

  // ---- script_run_journal ----

  findScriptRunJournalStep(runId: string, stepKey: string): Promise<ScriptRunJournalRow | null> {
    return this.db.get<ScriptRunJournalRow>(sql`
      SELECT * FROM script_run_journal WHERE "runId" = ${runId} AND "stepKey" = ${stepKey}`);
  }

  abstract insertScriptRunJournalStep(row: NewScriptRunJournalStep): Promise<void>;

  abstract listScriptRunJournalSteps(runId: string): Promise<ScriptRunJournalRow[]>;

  async countScriptRunJournalSteps(runId: string, stepType?: string): Promise<number> {
    const byType = stepType === undefined ? EMPTY : sql` AND "stepType" = ${stepType}`;
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM script_run_journal WHERE "runId" = ${runId}${byType}`);
    return row?.count ?? 0;
  }
}
