import type { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod";
import {
  type AppDefinition,
  AppNameSchema,
  type AppQueryDef,
  type AppValidationIssue,
  applyAppDefinitionPatch,
  ColumnKindSchema,
  isIso8601Date,
  type ModelDef,
  parseAppDefinition,
  SORTABLE_SYSTEM_DATE_COLUMNS,
  SYSTEM_COLUMN_KINDS,
} from "../apps/definition";
import {
  type AppRow,
  AppRowAppNotFoundError,
  AppRowValidationError,
  createAppRow,
  createAppRows,
  deleteAppRow,
  getAppRow,
  listAppRows,
  patchAppRow,
  purgeAppRows,
} from "../apps/row-store";
import {
  type AppMigrationReport,
  AppMigrationReportSchema,
  AppMigrationSchema,
  AppSchemaMigrationError,
  AppSnapshotFailure,
  ForceElementBreakSchema,
  migrateAppSchema,
  withAppDefinitionLock,
} from "../apps/schema-migrate";
import {
  appDefinitionNeedsRepair,
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
} from "../apps/store";
import { collectAppSyncStatus, runAppSync } from "../apps/sync";
import {
  getAppUserConfigValues,
  isReservedUserConfigKey,
  mergeUserConfigValues,
  upsertAppUserConfigValues,
  userConfigValueIssues,
} from "../apps/user-config";
import {
  AppRollbackAppNotFoundError,
  AppRollbackDefinitionError,
  AppRollbackVersionNotFoundError,
  decodeAppVersion,
  rollbackApp,
  snapshotApp,
} from "../apps/version";
import { normalizeAssetKey } from "../assets/key";
import { getAgentById, getAppVersion, getAppVersions, getLeadAgent } from "../be/db";
import { getScriptById } from "../be/scripts/db";
import { getSavedScriptOwnerAgentId, runSavedScriptAsAgent } from "../be/scripts/run-saved";
import { resolveTemplate } from "../prompts/resolver";
import type { RbacPrincipal, RbacResource } from "../rbac";
import { can } from "../rbac";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { AgentTaskStatusSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubObject } from "../utils/secret-scrubber";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError } from "./utils";

const MAX_APP_BODY_BYTES = 5 * 1024 * 1024;
const MAX_APP_ROW_BODY_BYTES = 1 * 1024 * 1024;
const MAX_APP_BULK_ROWS_BODY_BYTES = 10 * 1024 * 1024;
const MAX_USER_CONFIG_BODY_BYTES = 64 * 1024;
const MAX_USER_CONFIG_VALUES_BYTES = 16 * 1024;
const DECIMAL_NUMBER_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

const appParamsSchema = z.object({ id: z.string().min(1) });
const appVersionParamsSchema = z.object({
  id: z.string().min(1),
  version: z.coerce.number().int().positive(),
});
const modelParamsSchema = z.object({ id: z.string().min(1), model: AppNameSchema });
const rowParamsSchema = z.object({
  id: z.string().min(1),
  model: AppNameSchema,
  rowId: z.string().min(1),
});
const valuesSchema = z.record(z.string(), z.unknown());

const AppValidationIssueSchema = z.object({ path: z.string(), message: z.string() });

/**
 * Any JSON value. Used for the genuinely free-form-but-ALWAYS-PRESENT payloads
 * below. `z.unknown()` would be wrong for those: it accepts `undefined`, so the
 * generator drops the property from the spec's `required` list even though
 * every write path emits it (same reasoning as `argsJsonSchemaValueSchema` in
 * src/http/scripts.ts).
 */
const JsonValueSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Mirrors `AppRecord` (src/apps/store.ts). `definition` is free-form JSON: it's
 * either a validated `AppDefinition & { schemaVersion }` or — when
 * `definitionError` is set — the raw, possibly malformed, stored value (which
 * `decodeApp` leaves as the un-parsed JSON *string* when the column itself is
 * corrupt).
 */
const AppRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  definition: JsonValueSchema,
  definitionError: z.array(AppValidationIssueSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Mirrors what `listApps()` (src/apps/store.ts) actually builds. Its declared
 * return type is `Omit<AppRecord, "definition">`, but the row mapper also never
 * emits `definitionError` — so this is deliberately not derived from
 * `AppRecordSchema`.
 */
const AppSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Mirrors `AppVersion` (src/be/db.ts). `snapshot` is a free-form JSON blob —
 * normally an `AppSnapshot`, but `rollbackSnapshot()` proves historical rows can
 * hold anything. Unlike `AppRecord.definition` it stays `z.unknown()` rather
 * than `JsonValueSchema`: `AppVersion.snapshot` is declared `unknown` in db.ts,
 * so narrowing it would need an unsafe cast at both call sites. The cost is
 * that the generated spec lists `snapshot` as optional even though
 * `rowToAppVersion` always emits it.
 */
const AppVersionSchema = z.object({
  id: z.string(),
  appId: z.string(),
  version: z.number(),
  snapshot: z.unknown(),
  changedByAgentId: z.string().optional(),
  createdAt: z.string(),
});

/** Mirrors `AppRow` (src/apps/row-store.ts): fixed system columns plus arbitrary model-defined columns. */
const AppRowSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});

/** Mirrors `SyncPassResult` (src/apps/sync.ts): one (model x source) sync pass outcome. */
const SyncPassResultSchema = z.object({
  model: z.string(),
  source: z.string(),
  connector: z.enum(["script", "swarm-tasks"]),
  pulled: z.number(),
  created: z.number(),
  updated: z.number(),
  refreshed: z.number(),
  unchanged: z.number(),
  markedStale: z.number(),
  staleSweepSkipped: z.boolean().optional(),
  warnings: z.array(z.string()),
  durationMs: z.number(),
  invokedBy: z.string().optional(),
  error: z.string().optional(),
  skipped: z.literal(true).optional(),
  alreadyRunning: z.literal(true).optional(),
});

/** Mirrors `AppSyncStatus` (src/apps/sync.ts): per-(model:source) pass freshness. */
const AppSyncStatusSchema = z.object({
  lastStartedAt: z.string(),
  lastFinishedAt: z.string(),
  ok: z.boolean(),
  created: z.number(),
  updated: z.number(),
  refreshed: z.number(),
  markedStale: z.number(),
  error: z.string().optional(),
});

/** Mirrors `UserConfigValues` (src/apps/user-config.ts). */
const UserConfigValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/**
 * Wire mirror of one `userConfig` field declaration (`UserConfigFieldSchema`,
 * src/apps/definition.ts). The definition module's own `UserConfigSchema` is
 * deliberately NOT reused here: its `required: z.never().optional()` guard has
 * no OpenAPI representation and makes the spec generator throw
 * (`Unknown zod object type … {type: "never"}`), which breaks both
 * `bun run docs:openapi` and `GET /openapi.json`. `required` is unobservable
 * on the wire anyway — the key can only ever be absent.
 */
const AppUserConfigFieldSchema = z.object({
  kind: ColumnKindSchema,
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  enum: z.array(z.string()).optional(),
  label: z.string().optional(),
});

/** Mirrors an app definition's `userConfig` declaration map. */
const AppUserConfigSchema = z.record(AppNameSchema, AppUserConfigFieldSchema);

const appWriteResponseSchema = z.object({
  app: AppRecordSchema,
  migration: AppMigrationReportSchema,
});
const userConfigBodySchema = z.object({ values: z.record(z.string(), z.unknown()) }).strict();

const getUserConfigRoute = route({
  method: "get",
  path: "/api/apps/{id}/user-config",
  pattern: ["api", "apps", null, "user-config"],
  summary: "Get app user configuration",
  description:
    "Returns the current definition schema and this principal's tolerantly merged values.",
  tags: ["Apps"],
  params: appParamsSchema,
  responses: {
    200: {
      description: "Merged user configuration",
      schema: z.object({ values: UserConfigValuesSchema, schema: AppUserConfigSchema }),
    },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
    409: { description: "App definition needs repair" },
  },
  rbac: { permission: "app.use" },
});

const putUserConfigRoute = route({
  method: "put",
  path: "/api/apps/{id}/user-config",
  pattern: ["api", "apps", null, "user-config"],
  summary: "Set app user configuration",
  description:
    "Stores validated per-user values outside the versioned app definition. The reserved `$theme` key (a preset-theme slug) is accepted on every app, even one that declares no userConfig schema.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: userConfigBodySchema,
  responses: {
    200: {
      description: "Stored user configuration",
      schema: z.object({ values: UserConfigValuesSchema, schema: AppUserConfigSchema }),
    },
    400: { description: "Invalid user configuration" },
    403: { description: "Permission denied" },
    413: { description: "Request exceeds 64 KB or serialized values exceed 16 KB" },
    404: { description: "App not found" },
    409: { description: "App definition needs repair" },
  },
  rbac: { permission: "app.use" },
});

const listAppsRoute = route({
  method: "get",
  path: "/api/apps",
  pattern: ["api", "apps"],
  summary: "List apps",
  tags: ["Apps"],
  responses: {
    200: {
      description: "App summaries without definitions",
      schema: z.object({ apps: z.array(AppSummarySchema) }),
    },
  },
  // App summaries remain list-level until a future policy can filter them per app.
  rbac: { ungated: "app summaries are list-level; per-app filtering is future work" },
});

const createAppRoute = route({
  method: "post",
  path: "/api/apps",
  pattern: ["api", "apps"],
  summary: "Create an app",
  tags: ["Apps"],
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    definition: z.unknown(),
    forceElementBreak: ForceElementBreakSchema.optional(),
  }),
  responses: {
    201: { description: "Created app", schema: z.object({ app: AppRecordSchema }) },
    400: { description: "Invalid app definition" },
    403: { description: "Permission denied" },
  },
  rbac: { permission: "app.manage" },
});

const listAppVersionsRoute = route({
  method: "get",
  path: "/api/apps/{id}/versions",
  pattern: ["api", "apps", null, "versions"],
  summary: "List app definition versions",
  tags: ["Apps"],
  params: appParamsSchema,
  responses: {
    200: {
      description: "App definition versions",
      schema: z.object({ versions: z.array(AppVersionSchema) }),
    },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.manage" },
});

const getAppVersionRoute = route({
  method: "get",
  path: "/api/apps/{id}/versions/{version}",
  pattern: ["api", "apps", null, "versions", null],
  summary: "Get an app definition version",
  tags: ["Apps"],
  params: appVersionParamsSchema,
  responses: {
    200: { description: "App definition version", schema: z.object({ version: AppVersionSchema }) },
    404: { description: "App or version not found" },
  },
  rbac: { permission: "app.manage" },
});

const rollbackAppRoute = route({
  method: "post",
  path: "/api/apps/{id}/rollback",
  pattern: ["api", "apps", null, "rollback"],
  summary: "Rollback an app definition",
  description:
    "Restores a snapshot through the ordinary schema migration engine. Lossy restores require migration directives.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({
    version: z.number().int().positive(),
    migration: AppMigrationSchema.optional(),
    forceElementBreak: ForceElementBreakSchema.optional(),
  }),
  responses: {
    200: { description: "Rolled back app", schema: appWriteResponseSchema },
    400: { description: "Invalid rollback definition or schema migration" },
    403: { description: "Permission denied" },
    404: { description: "App or app version not found" },
  },
  rbac: { permission: "app.manage" },
});

const getAppRoute = route({
  method: "get",
  path: "/api/apps/{id}",
  pattern: ["api", "apps", null],
  summary: "Get an app",
  tags: ["Apps"],
  params: appParamsSchema,
  responses: {
    200: {
      description: "App including its definition",
      schema: z.object({
        app: AppRecordSchema,
        // Present only once at least one declared source has completed a pass.
        syncStatus: z.record(z.string(), AppSyncStatusSchema).optional(),
      }),
    },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.use" },
});

const updateAppRoute = route({
  method: "put",
  path: "/api/apps/{id}",
  pattern: ["api", "apps", null],
  summary: "Update an app",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    definition: z.unknown().optional(),
    migration: AppMigrationSchema.optional(),
    forceElementBreak: ForceElementBreakSchema.optional(),
  }),
  responses: {
    200: { description: "Updated app", schema: appWriteResponseSchema },
    400: { description: "Invalid app definition" },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.manage" },
});

const patchAppRoute = route({
  method: "patch",
  path: "/api/apps/{id}",
  pattern: ["api", "apps", null],
  summary: "Patch an app",
  description:
    "Applies an RFC 7396 merge patch to the definition, with reusable elements, app actions, page elements, and model columns treated as atomic entries.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
    migration: AppMigrationSchema.optional(),
    forceElementBreak: ForceElementBreakSchema.optional(),
  }),
  responses: {
    200: { description: "Patched app", schema: appWriteResponseSchema },
    400: { description: "Invalid app definition" },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.manage" },
});

const deleteAppRoute = route({
  method: "delete",
  path: "/api/apps/{id}",
  pattern: ["api", "apps", null],
  summary: "Delete an app and all of its rows",
  tags: ["Apps"],
  params: appParamsSchema,
  responses: {
    200: { description: "App deleted", schema: z.object({ ok: z.literal(true) }) },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.manage" },
});

const createRowRoute = route({
  method: "post",
  path: "/api/apps/{id}/models/{model}/rows",
  pattern: ["api", "apps", null, "models", null, "rows"],
  summary: "Create an app model row",
  tags: ["Apps"],
  params: modelParamsSchema,
  body: z.object({ values: valuesSchema }),
  responses: {
    201: { description: "Created row", schema: z.object({ row: AppRowSchema }) },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App or model not found" },
  },
  rbac: { permission: "app.use" },
});

const bulkCreateRowsRoute = route({
  method: "post",
  path: "/api/apps/{id}/models/{model}/rows/bulk",
  pattern: ["api", "apps", null, "models", null, "rows", "bulk"],
  summary: "Bulk-create app model rows",
  tags: ["Apps"],
  params: modelParamsSchema,
  body: z.object({ rows: z.array(z.object({ values: valuesSchema })).max(500) }),
  responses: {
    200: { description: "Created rows", schema: z.object({ rows: z.array(AppRowSchema) }) },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App or model not found" },
  },
  rbac: { permission: "app.use" },
});

const listRowsRoute = route({
  method: "get",
  path: "/api/apps/{id}/models/{model}/rows",
  pattern: ["api", "apps", null, "models", null, "rows"],
  summary: "List app model rows",
  tags: ["Apps"],
  params: modelParamsSchema,
  query: z.looseObject({
    sort: z.string().optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
  }),
  responses: {
    200: {
      description: "Filtered app model rows",
      schema: z.object({ rows: z.array(AppRowSchema), total: z.number() }),
    },
    400: { description: "Invalid filter or sort" },
    403: { description: "Permission denied" },
    404: { description: "App or model not found" },
  },
  rbac: { permission: "app.use" },
});

const getRowRoute = route({
  method: "get",
  path: "/api/apps/{id}/models/{model}/rows/{rowId}",
  pattern: ["api", "apps", null, "models", null, "rows", null],
  summary: "Get an app model row",
  tags: ["Apps"],
  params: rowParamsSchema,
  responses: {
    200: { description: "App model row", schema: z.object({ row: AppRowSchema }) },
    403: { description: "Permission denied" },
    404: { description: "App, model, or row not found" },
  },
  rbac: { permission: "app.use" },
});

const patchRowRoute = route({
  method: "patch",
  path: "/api/apps/{id}/models/{model}/rows/{rowId}",
  pattern: ["api", "apps", null, "models", null, "rows", null],
  summary: "Patch an app model row",
  tags: ["Apps"],
  params: rowParamsSchema,
  body: z.object({ values: valuesSchema }),
  responses: {
    200: { description: "Updated row", schema: z.object({ row: AppRowSchema }) },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App, model, or row not found" },
  },
  rbac: { permission: "app.use" },
});

const deleteRowRoute = route({
  method: "delete",
  path: "/api/apps/{id}/models/{model}/rows/{rowId}",
  pattern: ["api", "apps", null, "models", null, "rows", null],
  summary: "Delete an app model row",
  tags: ["Apps"],
  params: rowParamsSchema,
  responses: {
    200: { description: "Row deleted", schema: z.object({ ok: z.literal(true) }) },
    403: { description: "Permission denied" },
    404: { description: "App, model, or row not found" },
  },
  rbac: { permission: "app.use" },
});

const runNamedQueryRoute = route({
  method: "get",
  path: "/api/apps/{id}/queries/{name}",
  pattern: ["api", "apps", null, "queries", null],
  summary: "Run a named app query",
  tags: ["Apps"],
  params: z.object({ id: z.string().min(1), name: AppNameSchema }),
  responses: {
    200: { description: "Named query rows", schema: z.object({ rows: z.array(AppRowSchema) }) },
    400: { description: "Missing or invalid named query parameters" },
    403: { description: "Permission denied" },
    409: { description: "App definition needs repair" },
    404: { description: "App or query not found" },
  },
  rbac: { permission: "app.use" },
});

/**
 * `runActionRoute`'s 200 shape branches on the action kind: script actions
 * echo the script's exit result, task actions echo the created task's id and
 * status.
 */
const runActionScriptResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown(),
  stdout: z.string(),
  error: z.string().optional(),
  durationMs: z.number(),
});
const runActionTaskResultSchema = z.object({
  ok: z.literal(true),
  taskId: z.string(),
  status: AgentTaskStatusSchema,
});
/**
 * Sync actions deliberately reuse the SCRIPT-action shape minus `stdout`/
 * `taskId` (see the handler comment): `result` carries the pass list instead
 * of a script's return value.
 */
const runActionSyncResultSchema = z.object({
  ok: z.boolean(),
  result: z.object({ passes: z.array(SyncPassResultSchema) }),
  error: z.string().optional(),
  durationMs: z.number(),
});
const runActionResultSchema = z.union([
  runActionScriptResultSchema,
  runActionTaskResultSchema,
  runActionSyncResultSchema,
]);

const runActionRoute = route({
  method: "post",
  path: "/api/apps/{id}/actions/{name}",
  pattern: ["api", "apps", null, "actions", null],
  summary: "Run a custom app action",
  description: "Runs the saved script, or creates the agent task, named by the app definition.",
  tags: ["Apps"],
  params: z.object({ id: z.string().min(1), name: AppNameSchema }),
  body: z.object({ input: z.record(z.string(), z.unknown()).optional() }),
  responses: {
    200: { description: "Action invoked", schema: runActionResultSchema },
    400: { description: "Invalid action input or stale script reference" },
    403: { description: "Permission denied" },
    409: { description: "App definition needs repair" },
    404: { description: "App or action not found" },
  },
  rbac: { permission: "app.use" },
});

const syncAppRoute = route({
  method: "post",
  path: "/api/apps/{id}/sync",
  pattern: ["api", "apps", null, "sync"],
  summary: "Sync an app's declared sources",
  description:
    "Runs every (model x source) pair the body selects. Each pass pulls outside the row mutation lock and reconciles inside it.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({ model: AppNameSchema.optional(), source: AppNameSchema.optional() }),
  responses: {
    200: {
      description: "Sync passes",
      schema: z.object({ ok: z.boolean(), passes: z.array(SyncPassResultSchema) }),
    },
    400: { description: "Unknown model or source, or no model declares a source" },
    403: { description: "Permission denied" },
    409: { description: "App definition needs repair" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.use" },
});

/**
 * RBAC-gate an app operation and resolve the acting principal's stable actor id
 * (`user:<id>`, `agent:<id>`, or `operator`) for row provenance. Returns null
 * (after writing the 403) when the write is denied.
 */
function authorizeApp(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  verb: "app.manage" | "app.use",
  resource: RbacResource,
): string | null {
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
  let actor: string;
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
    actor = "operator";
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
    actor = `user:${auth.userId}`;
  } else {
    const agent = myAgentId ? getAgentById(myAgentId) : null;
    principal = { kind: "agent", agentId: myAgentId ?? "", isLead: agent?.isLead ?? false };
    actor = myAgentId ? `agent:${myAgentId}` : "agent";
  }
  const decision = can({
    principal,
    verb,
    resource,
    source: "http",
  });
  if (decision.allow) return actor;
  jsonError(res, decision.reason, 403);
  return null;
}

function authorizeAppManage(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  appId?: string,
): string | null {
  return authorizeApp(
    req,
    res,
    myAgentId,
    "app.manage",
    appId ? { kind: "app", appId } : { kind: "none" },
  );
}

function authorizeAppUse(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  appId: string,
): string | null {
  return authorizeApp(req, res, myAgentId, "app.use", { kind: "app", appId });
}

function invalidDefinition(res: ServerResponse, issues: AppValidationIssue[]): void {
  json(res, { error: "invalid app definition", issues }, 400);
}

function definitionNeedsRepair(res: ServerResponse, app: ReturnType<typeof getApp>): boolean {
  if (!app || !appDefinitionNeedsRepair(app)) return false;
  json(res, { error: "definition needs repair", issues: app.definitionError }, 409);
  return true;
}

/**
 * One `error` string for a sync result, or undefined when every pass succeeded.
 * Each failed pair is named so a multi-pair sync says which one broke; the pass
 * list in `result.passes` carries the rest.
 */
function syncPassError(sync: Awaited<ReturnType<typeof runAppSync>>): string | undefined {
  const failed = sync.passes.filter((pass) => pass.error !== undefined);
  if (failed.length === 0) return undefined;
  return failed.map((pass) => `${pass.model}.${pass.source}: ${pass.error}`).join("; ");
}

function snapshotFailure(res: ServerResponse): void {
  jsonError(res, "failed to snapshot app", 500);
}

function invalidMigration(res: ServerResponse, error: AppSchemaMigrationError): void {
  json(res, { error: error.message, issues: error.issues }, 400);
}

function invalidRows(res: ServerResponse, error: unknown): boolean {
  if (error instanceof AppRowAppNotFoundError) {
    jsonError(res, "app not found", 404);
    return true;
  }
  if (!(error instanceof AppRowValidationError)) return false;
  json(res, { error: error.message, issues: error.issues }, 400);
  return true;
}

function resolveModel(
  appId: string,
  modelName: string,
  res: ServerResponse,
): { app: NonNullable<ReturnType<typeof getApp>>; model: ModelDef } | null {
  const app = getApp(appId);
  if (definitionNeedsRepair(res, app)) return null;
  if (!app || !Object.hasOwn(app.definition.models, modelName)) {
    jsonError(res, "app or model not found", 404);
    return null;
  }
  return { app, model: app.definition.models[modelName]! };
}

function parseFilterValue(raw: string, column: ModelDef["columns"][string]): unknown {
  if (column.kind === "number") {
    if (!DECIMAL_NUMBER_PATTERN.test(raw)) throw new Error("must be a decimal number");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("must be a finite decimal number");
    return value;
  }
  if (column.kind === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("must be true or false");
  }
  if (column.kind === "date" && !isIso8601Date(raw)) {
    throw new Error("must be an ISO-8601 date string");
  }
  if (column.kind === "enum" && !column.enum?.includes(raw)) {
    throw new Error(`must be one of: ${column.enum?.join(", ") ?? ""}`);
  }
  return raw;
}

type AppQueryParamValue = string | number | boolean;
export type AppQueryParams = Record<string, AppQueryParamValue>;

export class AppQueryParamsError extends Error {
  constructor(
    readonly issues: AppValidationIssue[],
    readonly missingNames: string[] = [],
  ) {
    super(
      missingNames.length > 0
        ? `missing query parameter(s): ${missingNames.join(", ")}`
        : "invalid query parameters",
    );
    this.name = "AppQueryParamsError";
  }
}

function isQueryParamRef(value: unknown): value is { $param: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $param?: unknown }).$param === "string"
  );
}

function coerceQueryParamValue(
  raw: AppQueryParamValue,
  column: ModelDef["columns"][string],
): unknown {
  if (column.kind === "number" && typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error("must be a finite decimal number");
    return raw;
  }
  if (column.kind === "boolean" && typeof raw === "boolean") return raw;
  return parseFilterValue(String(raw), column);
}

function resolveQueryFilters(
  query: AppQueryDef,
  model: ModelDef,
  params: AppQueryParams,
  queryName: string,
): Array<[string, unknown]> {
  const filters = Object.entries(query.filter ?? {});
  const declaredNames = new Set(
    filters.flatMap(([, value]) => (isQueryParamRef(value) ? [value.$param] : [])),
  );
  const missingNames = [
    ...new Set([...declaredNames].filter((name) => !Object.hasOwn(params, name))),
  ].sort();
  const unknownNames = Object.keys(params)
    .filter((name) => !declaredNames.has(name))
    .sort();
  if (missingNames.length > 0 || unknownNames.length > 0) {
    throw new AppQueryParamsError(
      [
        ...missingNames.map((name) => ({
          path: `param.${name}`,
          message: "is required by a named query filter",
        })),
        ...unknownNames.map((name) => ({
          path: `param.${name}`,
          message: `not a declared $param of query "${queryName}"`,
        })),
      ],
      missingNames,
    );
  }

  const issues: AppValidationIssue[] = [];
  const resolved = filters.map(([columnName, value]): [string, unknown] => {
    if (!isQueryParamRef(value)) return [columnName, value];
    try {
      return [
        columnName,
        coerceQueryParamValue(params[value.$param]!, filterColumn(model, columnName)),
      ];
    } catch (error) {
      issues.push({
        path: `param.${value.$param}`,
        message: error instanceof Error ? error.message : String(error),
      });
      return [columnName, undefined];
    }
  });
  if (issues.length > 0) throw new AppQueryParamsError(issues);
  return resolved;
}

/**
 * The column definition a query filter targets: a declared model column, or a
 * synthetic def for the reserved system fields (`id`, `createdAt`, …) every
 * row carries — parse-time validation admits both.
 */
function filterColumn(model: ModelDef, columnName: string): ModelDef["columns"][string] {
  if (Object.hasOwn(model.columns, columnName)) return model.columns[columnName]!;
  return { kind: SYSTEM_COLUMN_KINDS[columnName] ?? "string" };
}

function appQueryParamsFromRequest(queryParams: URLSearchParams): AppQueryParams {
  const params: AppQueryParams = {};
  for (const [key, value] of queryParams.entries()) {
    if (key.startsWith("param.") && key.length > "param.".length) {
      params[key.slice("param.".length)] = value;
    }
  }
  return params;
}

interface RowFilter {
  column: string;
  value: unknown;
}

/**
 * Ad-hoc REST `filter.<col>` stays model-columns-only on purpose: system fields
 * (including the sync envelope) are filterable through named queries, which
 * validate kinds at definition-write time. Widening this loosely-typed
 * query-string path would give two filter vocabularies with different rules.
 */
function filtersFromQuery(
  queryParams: URLSearchParams,
  model: ModelDef,
): { filters: RowFilter[]; issues: AppValidationIssue[] } {
  const filters: RowFilter[] = [];
  const issues: AppValidationIssue[] = [];
  for (const [key, raw] of queryParams.entries()) {
    if (!key.startsWith("filter.")) continue;
    const columnName = key.slice("filter.".length);
    if (!Object.hasOwn(model.columns, columnName) || model.columns[columnName]!.hidden === true) {
      issues.push({ path: key, message: `unknown or hidden column "${columnName}"` });
      continue;
    }
    const column = model.columns[columnName]!;
    try {
      filters.push({ column: columnName, value: parseFilterValue(raw, column) });
    } catch (error) {
      issues.push({ path: key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { filters, issues };
}

function compareValues(
  left: unknown,
  right: unknown,
  direction: "asc" | "desc",
  dateValues = false,
): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return 1;
  if (right === undefined || right === null) return -1;
  let result: number;
  if (dateValues && typeof left === "string" && typeof right === "string") {
    result = Date.parse(left) - Date.parse(right);
  } else if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else if (typeof left === "boolean" && typeof right === "boolean") {
    result = Number(left) - Number(right);
  } else {
    result = String(left).localeCompare(String(right));
  }
  return direction === "asc" ? result : -result;
}

function rowValue(row: AppRow, column: string): unknown {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

export function applyQuery(
  rows: AppRow[],
  query: AppQueryDef,
  model: ModelDef,
  params: AppQueryParams = {},
  queryName = "<unnamed>",
): AppRow[] {
  const filters = resolveQueryFilters(query, model, params, queryName);
  let selected = rows.filter((row) =>
    filters.every(([column, value]) => rowValue(row, column) === value),
  );
  const sort = query.sort;
  if (sort) {
    selected = [...selected].sort((a, b) => {
      const result = compareValues(
        rowValue(a, sort.column),
        rowValue(b, sort.column),
        sort.dir,
        SORTABLE_SYSTEM_DATE_COLUMNS.has(sort.column) ||
          (Object.hasOwn(model.columns, sort.column) &&
            model.columns[sort.column]!.kind === "date"),
      );
      return result;
    });
  }
  return selected.slice(0, query.limit ?? 200);
}

export async function handleApps(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (createAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await createAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    // App creation has no app resource to scope yet.
    if (!authorizeAppManage(req, res, myAgentId)) return true;
    if (parsed.body.forceElementBreak) {
      jsonError(
        res,
        "forceElementBreak requires an existing app; new apps have no consumers to break",
        400,
      );
      return true;
    }
    const definition = parseAppDefinition(parsed.body.definition, {
      resolveApp: getApp,
      writerAgentId: myAgentId ?? null,
      writerIsUser: getRequestAuth(req)?.kind === "user",
    });
    if (!definition.success) {
      invalidDefinition(res, definition.issues);
      return true;
    }
    createAppRoute.respond(res, 201, {
      app: createApp({
        name: parsed.body.name,
        description: parsed.body.description,
        definition: definition.definition,
      }),
    });
    return true;
  }

  if (listAppsRoute.match(req.method, pathSegments)) {
    listAppsRoute.respond(res, 200, { apps: listApps() });
    return true;
  }

  if (listAppVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listAppVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;
    if (!getApp(parsed.params.id)) {
      jsonError(res, "app not found", 404);
      return true;
    }
    listAppVersionsRoute.respond(res, 200, {
      versions: getAppVersions(parsed.params.id).map(decodeAppVersion),
    });
    return true;
  }

  if (getAppVersionRoute.match(req.method, pathSegments)) {
    const parsed = await getAppVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;
    if (!getApp(parsed.params.id)) {
      jsonError(res, "app not found", 404);
      return true;
    }
    const version = getAppVersion(parsed.params.id, parsed.params.version);
    if (!version) {
      jsonError(res, "app version not found", 404);
      return true;
    }
    getAppVersionRoute.respond(res, 200, { version: decodeAppVersion(version) });
    return true;
  }

  if (rollbackAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await rollbackAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;
    try {
      const rolledBack = await rollbackApp({
        appId: parsed.params.id,
        version: parsed.body.version,
        migration: parsed.body.migration,
        forceElementBreak: parsed.body.forceElementBreak,
        changedByAgentId: myAgentId,
        writerAgentId: myAgentId ?? null,
        writerIsUser: getRequestAuth(req)?.kind === "user",
      });
      rollbackAppRoute.respond(res, 200, { app: rolledBack.app, migration: rolledBack.migration });
    } catch (error) {
      if (error instanceof AppRollbackAppNotFoundError) {
        jsonError(res, "app not found", 404);
      } else if (error instanceof AppRollbackVersionNotFoundError) {
        jsonError(res, "app version not found", 404);
      } else if (error instanceof AppRollbackDefinitionError) {
        json(res, { error: error.message, issues: error.issues }, 400);
      } else if (error instanceof AppSchemaMigrationError) {
        invalidMigration(res, error);
      } else if (error instanceof AppSnapshotFailure) {
        snapshotFailure(res);
      } else {
        throw error;
      }
    }
    return true;
  }

  if (bulkCreateRowsRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BULK_ROWS_BODY_BYTES) === BODY_TOO_LARGE)
      return true;
    const parsed = await bulkCreateRowsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = authorizeAppUse(req, res, myAgentId, parsed.params.id);
    if (!actor) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const rows = await createAppRows(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.body.rows.map((row) => row.values),
        { actor },
      );
      bulkCreateRowsRoute.respond(res, 200, { rows });
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (createRowRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await createRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = authorizeAppUse(req, res, myAgentId, parsed.params.id);
    if (!actor) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const row = await createAppRow(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.body.values,
        { actor },
      );
      createRowRoute.respond(res, 201, { row });
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (listRowsRoute.match(req.method, pathSegments)) {
    const parsed = await listRowsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    const { filters, issues } = filtersFromQuery(queryParams, resolved.model);
    if (issues.length > 0) {
      json(res, { error: "invalid row query", issues }, 400);
      return true;
    }
    const rows = listAppRows(parsed.params.id, parsed.params.model).filter((row) =>
      filters.every((filter) => rowValue(row, filter.column) === filter.value),
    );
    const sortRaw = parsed.query.sort;
    if (sortRaw) {
      const [column, dir, extra] = sortRaw.split(":");
      if (
        extra !== undefined ||
        !column ||
        (dir !== "asc" && dir !== "desc") ||
        (!SORTABLE_SYSTEM_DATE_COLUMNS.has(column) &&
          (!Object.hasOwn(resolved.model.columns, column) ||
            resolved.model.columns[column]!.hidden === true))
      ) {
        json(
          res,
          {
            error: "invalid sort",
            issues: [{ path: "sort", message: "must be <column>:<asc|desc> for a known column" }],
          },
          400,
        );
        return true;
      }
      rows.sort((a, b) => {
        const result = compareValues(
          rowValue(a, column),
          rowValue(b, column),
          dir,
          SORTABLE_SYSTEM_DATE_COLUMNS.has(column) ||
            (Object.hasOwn(resolved.model.columns, column) &&
              resolved.model.columns[column]!.kind === "date"),
        );
        return result;
      });
    }
    const total = rows.length;
    listRowsRoute.respond(res, 200, { rows: rows.slice(0, parsed.query.limit ?? 200), total });
    return true;
  }

  if (getRowRoute.match(req.method, pathSegments)) {
    const parsed = await getRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    if (!resolveModel(parsed.params.id, parsed.params.model, res)) return true;
    const row = getAppRow(parsed.params.id, parsed.params.model, parsed.params.rowId);
    if (!row) {
      jsonError(res, "row not found", 404);
      return true;
    }
    getRowRoute.respond(res, 200, { row });
    return true;
  }

  if (patchRowRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await patchRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = authorizeAppUse(req, res, myAgentId, parsed.params.id);
    if (!actor) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const row = await patchAppRow(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.params.rowId,
        parsed.body.values,
        { actor },
      );
      if (!row) {
        jsonError(res, "row not found", 404);
        return true;
      }
      patchRowRoute.respond(res, 200, { row });
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (deleteRowRoute.match(req.method, pathSegments)) {
    const parsed = await deleteRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    if (
      !(await deleteAppRow(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.params.rowId,
      ))
    ) {
      jsonError(res, "row not found", 404);
      return true;
    }
    deleteRowRoute.respond(res, 200, { ok: true });
    return true;
  }

  if (runNamedQueryRoute.match(req.method, pathSegments)) {
    const parsed = await runNamedQueryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const app = getApp(parsed.params.id);
    if (definitionNeedsRepair(res, app)) return true;
    const queries = app?.definition.queries;
    if (!app || !queries || !Object.hasOwn(queries, parsed.params.name)) {
      jsonError(res, "app or query not found", 404);
      return true;
    }
    const query = queries[parsed.params.name]!;
    if (!Object.hasOwn(app.definition.models, query.model)) {
      jsonError(res, "model not found", 404);
      return true;
    }
    const model = app.definition.models[query.model]!;
    try {
      runNamedQueryRoute.respond(res, 200, {
        rows: applyQuery(
          listAppRows(app.id, query.model),
          query,
          model,
          appQueryParamsFromRequest(queryParams),
          parsed.params.name,
        ),
      });
    } catch (error) {
      if (!(error instanceof AppQueryParamsError)) throw error;
      json(
        res,
        { error: error.message, issues: error.issues, missingParams: error.missingNames },
        400,
      );
    }
    return true;
  }

  if (runActionRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await runActionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = authorizeAppUse(req, res, myAgentId, parsed.params.id);
    if (!actor) return true;

    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    if (definitionNeedsRepair(res, app)) return true;
    const actions = app.definition.actions;
    if (!actions || !Object.hasOwn(actions, parsed.params.name)) {
      jsonError(res, "app action not found", 404);
      return true;
    }

    const action = actions[parsed.params.name]!;
    const input = parsed.body.input ?? {};
    if (action.kind === "script") {
      const script = getScriptById(action.scriptId);
      if (!script) {
        json(
          res,
          {
            error: "invalid app action",
            issues: [
              {
                path: `actions.${parsed.params.name}.scriptId`,
                message: `script "${action.scriptId}" no longer exists`,
              },
            ],
          },
          400,
        );
        return true;
      }

      // Script actions run with the OWNER's bindings by design: wiring a script
      // into an app is the owner's delegation. parseAppDefinition enforces at
      // write time that an agent may only wire scripts it owns (or global ones),
      // so a foreign script id cannot be smuggled in here. Invoker-brokered
      // credentials remain a possible future tightening.
      const runAsAgentId = getSavedScriptOwnerAgentId(script);
      if (!runAsAgentId) {
        jsonError(res, "agentId is required: this script has no owning agent to run as", 400);
        return true;
      }

      const output = await runSavedScriptAsAgent({
        script,
        input: { ...action.args, ...input, app: { id: app.id } },
        agentId: runAsAgentId,
      });
      const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
      const error = ok
        ? undefined
        : output.runtimeError
          ? `${output.runtimeError.name}: ${output.runtimeError.message}`
          : (output.error ?? `Script exited with code ${output.exitCode}`);
      runActionRoute.respond(
        res,
        200,
        scrubObject({
          ok,
          result: output.result,
          stdout: output.stdout,
          ...(error === undefined ? {} : { error }),
          durationMs: output.durationMs,
        }),
      );
      return true;
    }

    if (action.kind === "sync") {
      const startedAt = Date.now();
      const sync = await runAppSync({
        appId: app.id,
        ...(action.model === undefined ? {} : { model: action.model }),
        ...(action.source === undefined ? {} : { source: action.source }),
        invokedBy: actor,
      });
      const durationMs = Date.now() - startedAt;
      if (sync.issues && sync.issues.length > 0) {
        json(res, { error: "invalid sync action", issues: sync.issues }, 400);
        return true;
      }
      // Deliberately the SCRIPT-action response shape, minus `taskId`:
      // app-surface.tsx branches on `taskId` first, so omitting it gives the
      // dashboard running -> ok/error + refetchAll() with zero UI changes.
      const error = syncPassError(sync);
      runActionRoute.respond(
        res,
        200,
        scrubObject({
          ok: sync.ok,
          result: { passes: sync.passes },
          ...(error === undefined ? {} : { error }),
          durationMs,
        }),
      );
      return true;
    }

    const lead = action.agentId ? null : getLeadAgent();
    const taskPrompt = resolveTemplate("task.app.action", {
      prompt: action.prompt,
      app_id: app.id,
      action_name: parsed.params.name,
      input_json: JSON.stringify(input),
    });
    const task = createTaskWithSiblingAwareness(taskPrompt.text, {
      source: "api",
      agentId: action.agentId ?? lead?.id,
      // App-spawned tasks group under the app's asset namespace so a
      // swarm-tasks source can pull them back via config.assetKey.
      key: normalizeAssetKey(`shared/app:${app.id}/action:${parsed.params.name}/`),
      ...(actor.startsWith("user:") ? { requestedByUserId: actor.slice("user:".length) } : {}),
    });
    runActionRoute.respond(res, 200, { ok: true, taskId: task.id, status: task.status });
    return true;
  }

  if (syncAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await syncAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = authorizeAppUse(req, res, myAgentId, parsed.params.id);
    if (!actor) return true;

    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    if (definitionNeedsRepair(res, app)) return true;

    const sync = await runAppSync({
      appId: app.id,
      ...(parsed.body.model === undefined ? {} : { model: parsed.body.model }),
      ...(parsed.body.source === undefined ? {} : { source: parsed.body.source }),
      invokedBy: actor,
    });
    if (sync.issues && sync.issues.length > 0) {
      json(res, { error: "nothing to sync", issues: sync.issues }, 400);
      return true;
    }
    syncAppRoute.respond(res, 200, scrubObject({ ok: sync.ok, passes: sync.passes }));
    return true;
  }

  if (patchAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await patchAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;

    if (!getApp(parsed.params.id)) {
      jsonError(res, "app not found", 404);
      return true;
    }
    let app: ReturnType<typeof updateApp> = null;
    let migration!: AppMigrationReport;
    let responseHandled = false;
    try {
      await withAppDefinitionLock(parsed.params.id, async () => {
        const existing = getApp(parsed.params.id);
        if (!existing) {
          jsonError(res, "app not found", 404);
          responseHandled = true;
          return;
        }
        if (definitionNeedsRepair(res, existing)) {
          responseHandled = true;
          return;
        }
        const patch = applyAppDefinitionPatch(existing.definition, parsed.body.definition ?? {});
        if (!patch.success) {
          invalidDefinition(res, patch.issues);
          responseHandled = true;
          return;
        }
        const definition = parseAppDefinition(patch.definition, {
          currentAppId: parsed.params.id,
          resolveApp: getApp,
          writerAgentId: myAgentId ?? null,
          writerIsUser: getRequestAuth(req)?.kind === "user",
          existingDefinition: existing.definition,
        });
        if (!definition.success) {
          invalidDefinition(res, definition.issues);
          responseHandled = true;
          return;
        }
        const migrated = await migrateAppSchema({
          appId: parsed.params.id,
          previousDefinition: existing.definition,
          previousRawDefinition: existing.definition,
          nextDefinition: definition.definition,
          migration: parsed.body.migration,
          forceElementBreak: parsed.body.forceElementBreak,
          snapshot: () => {
            try {
              snapshotApp(parsed.params.id, myAgentId);
            } catch {
              throw new AppSnapshotFailure();
            }
          },
          writeDefinition: () =>
            updateApp(parsed.params.id, {
              name: parsed.body.name,
              description: parsed.body.description,
              definition: definition.definition,
            }),
        });
        app = migrated.result;
        migration = migrated.migration;
      });
    } catch (error) {
      if (error instanceof AppSchemaMigrationError) {
        invalidMigration(res, error);
        return true;
      }
      if (error instanceof AppSnapshotFailure) {
        snapshotFailure(res);
        return true;
      }
      throw error;
    }
    if (responseHandled) return true;
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    patchAppRoute.respond(res, 200, { app, migration });
    return true;
  }

  if (updateAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await updateAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;
    if (!getApp(parsed.params.id)) {
      jsonError(res, "app not found", 404);
      return true;
    }
    let app: ReturnType<typeof updateApp> = null;
    let migration!: AppMigrationReport;
    let responseHandled = false;
    try {
      await withAppDefinitionLock(parsed.params.id, async () => {
        const existing = getApp(parsed.params.id);
        if (!existing) {
          jsonError(res, "app not found", 404);
          responseHandled = true;
          return;
        }
        let definition: AppDefinition | undefined;
        if (parsed.body.definition !== undefined) {
          const parsedDefinition = parseAppDefinition(parsed.body.definition, {
            currentAppId: parsed.params.id,
            resolveApp: getApp,
            writerAgentId: myAgentId ?? null,
            writerIsUser: getRequestAuth(req)?.kind === "user",
            existingDefinition: existing.definition,
          });
          if (!parsedDefinition.success) {
            invalidDefinition(res, parsedDefinition.issues);
            responseHandled = true;
            return;
          }
          definition = parsedDefinition.definition;
        } else if (definitionNeedsRepair(res, existing)) {
          responseHandled = true;
          return;
        }
        const nextDefinition = definition ?? existing.definition;
        const migrated = await migrateAppSchema({
          appId: parsed.params.id,
          previousDefinition: appDefinitionNeedsRepair(existing) ? undefined : existing.definition,
          previousRawDefinition: existing.definition,
          nextDefinition,
          migration: parsed.body.migration,
          forceElementBreak: parsed.body.forceElementBreak,
          snapshot: () => {
            try {
              snapshotApp(parsed.params.id, myAgentId);
            } catch {
              throw new AppSnapshotFailure();
            }
          },
          writeDefinition: () =>
            updateApp(parsed.params.id, {
              name: parsed.body.name,
              description: parsed.body.description,
              definition,
            }),
        });
        app = migrated.result;
        migration = migrated.migration;
      });
    } catch (error) {
      if (error instanceof AppSchemaMigrationError) {
        invalidMigration(res, error);
        return true;
      }
      if (error instanceof AppSnapshotFailure) {
        snapshotFailure(res);
        return true;
      }
      throw error;
    }
    if (responseHandled) return true;
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    updateAppRoute.respond(res, 200, { app, migration });
    return true;
  }

  if (deleteAppRoute.match(req.method, pathSegments)) {
    const parsed = await deleteAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppManage(req, res, myAgentId, parsed.params.id)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    let deleted = false;
    // Intentional float-model asymmetry: DELETE bypasses the ElementRef compatibility
    // gate; consumers of the removed app degrade to the Phase 6 error card.
    // A broken definition (definitionError) must not block deletion — DELETE is the
    // recovery path. The model list only picks purge lock names; the purge itself
    // sweeps the whole app namespace, so an empty list is safe.
    const purgeModels = app.definitionError ? [] : Object.keys(app.definition.models);
    await purgeAppRows(app.id, purgeModels, () => {
      deleted = deleteApp(app.id);
    });
    if (!deleted) {
      jsonError(res, "app not found", 404);
      return true;
    }
    deleteAppRoute.respond(res, 200, { ok: true });
    return true;
  }

  if (getAppRoute.match(req.method, pathSegments)) {
    const parsed = await getAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    // Per-source freshness for the runtime payload — present only once a
    // declared source has completed at least one pass.
    const syncStatus = collectAppSyncStatus(app.id);
    getAppRoute.respond(res, 200, {
      app,
      ...(Object.keys(syncStatus).length > 0 ? { syncStatus } : {}),
    });
    return true;
  }

  if (getUserConfigRoute.match(req.method, pathSegments)) {
    const parsed = await getUserConfigRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    if (definitionNeedsRepair(res, app)) return true;
    const schema = app.definition.userConfig ?? {};
    const owner = resolveHttpFavoriteOwner(req, myAgentId);
    const stored = owner ? getAppUserConfigValues(app.id, owner.scope) : {};
    getUserConfigRoute.respond(res, 200, { values: mergeUserConfigValues(schema, stored), schema });
    return true;
  }

  if (putUserConfigRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_USER_CONFIG_BODY_BYTES) === BODY_TOO_LARGE)
      return true;
    const parsed = await putUserConfigRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppUse(req, res, myAgentId, parsed.params.id)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    if (definitionNeedsRepair(res, app)) return true;
    // Reserved system keys (`$theme`) are writable on EVERY app — the drawer
    // offers a theme override whether or not the author declared settings.
    // Author-namespace keys still require a declared schema, and a write that
    // carries nothing reserved keeps the historical 400.
    const schema = app.definition.userConfig ?? {};
    const valueKeys = Object.keys(parsed.body.values);
    if (
      !app.definition.userConfig &&
      (valueKeys.some((key) => !isReservedUserConfigKey(key)) ||
        !valueKeys.some(isReservedUserConfigKey))
    ) {
      jsonError(res, "app does not define userConfig", 400);
      return true;
    }
    const owner = resolveHttpFavoriteOwner(req, myAgentId);
    if (!owner) {
      jsonError(res, "userConfig is per-user; agents have no user scope", 403);
      return true;
    }
    const serialized = JSON.stringify(parsed.body.values);
    if (new TextEncoder().encode(serialized).byteLength > MAX_USER_CONFIG_VALUES_BYTES) {
      jsonError(res, "userConfig values exceed the 16 KB serialized limit", 413);
      return true;
    }
    const issues = userConfigValueIssues(schema, parsed.body.values);
    if (issues.length > 0) {
      json(res, { error: "invalid userConfig values", issues }, 400);
      return true;
    }
    upsertAppUserConfigValues(app.id, owner.scope, parsed.body.values);
    putUserConfigRoute.respond(res, 200, {
      values: mergeUserConfigValues(schema, parsed.body.values),
      schema,
    });
    return true;
  }

  return false;
}
