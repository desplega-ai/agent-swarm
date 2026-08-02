import type { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod";
import {
  type AppDefinition,
  AppNameSchema,
  type AppQueryDef,
  type AppValidationIssue,
  applyAppDefinitionPatch,
  isIso8601Date,
  type ModelDef,
  parseAppDefinition,
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
import { createApp, deleteApp, getApp, listApps, updateApp } from "../apps/store";
import { runAppSync, SyncSelectionError } from "../apps/sync";
import { getAgentById, getLeadAgent } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import { getScriptById } from "../be/scripts/db";
import { resolveTemplate } from "../prompts/resolver";
import type { RbacPrincipal } from "../rbac";
import { can } from "../rbac";
import { runScript } from "../scripts-runtime/loader";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubObject } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError } from "./utils";

const MAX_APP_BODY_BYTES = 5 * 1024 * 1024;
const MAX_APP_ROW_BODY_BYTES = 1 * 1024 * 1024;
const MAX_APP_BULK_ROWS_BODY_BYTES = 10 * 1024 * 1024;
const DECIMAL_NUMBER_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

const appParamsSchema = z.object({ id: z.string().min(1) });
const modelParamsSchema = z.object({ id: z.string().min(1), model: AppNameSchema });
const rowParamsSchema = z.object({
  id: z.string().min(1),
  model: AppNameSchema,
  rowId: z.string().min(1),
});
const valuesSchema = z.record(z.string(), z.unknown());

const listAppsRoute = route({
  method: "get",
  path: "/api/apps",
  pattern: ["api", "apps"],
  summary: "List apps",
  tags: ["Apps"],
  responses: { 200: { description: "App summaries without definitions" } },
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
  }),
  responses: {
    201: { description: "Created app" },
    400: { description: "Invalid app definition" },
    403: { description: "Permission denied" },
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
    200: { description: "App including its definition" },
    404: { description: "App not found" },
  },
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
  }),
  responses: {
    200: { description: "Updated app" },
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
    "Applies an RFC 7396 merge patch to the definition, with app actions, page elements, model columns, and model sources treated as atomic entries.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    definition: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: { description: "Patched app" },
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
    200: { description: "App deleted" },
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
    201: { description: "Created row" },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App or model not found" },
  },
  rbac: { permission: "app.manage" },
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
    200: { description: "Created rows" },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App or model not found" },
  },
  rbac: { permission: "app.manage" },
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
    200: { description: "Filtered app model rows" },
    400: { description: "Invalid filter or sort" },
    404: { description: "App or model not found" },
  },
});

const getRowRoute = route({
  method: "get",
  path: "/api/apps/{id}/models/{model}/rows/{rowId}",
  pattern: ["api", "apps", null, "models", null, "rows", null],
  summary: "Get an app model row",
  tags: ["Apps"],
  params: rowParamsSchema,
  responses: {
    200: { description: "App model row" },
    404: { description: "App, model, or row not found" },
  },
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
    200: { description: "Updated row" },
    400: { description: "Invalid row values" },
    403: { description: "Permission denied" },
    404: { description: "App, model, or row not found" },
  },
  rbac: { permission: "app.manage" },
});

const deleteRowRoute = route({
  method: "delete",
  path: "/api/apps/{id}/models/{model}/rows/{rowId}",
  pattern: ["api", "apps", null, "models", null, "rows", null],
  summary: "Delete an app model row",
  tags: ["Apps"],
  params: rowParamsSchema,
  responses: {
    200: { description: "Row deleted" },
    403: { description: "Permission denied" },
    404: { description: "App, model, or row not found" },
  },
  rbac: { permission: "app.manage" },
});

const runNamedQueryRoute = route({
  method: "get",
  path: "/api/apps/{id}/queries/{name}",
  pattern: ["api", "apps", null, "queries", null],
  summary: "Run a named app query",
  tags: ["Apps"],
  params: z.object({ id: z.string().min(1), name: AppNameSchema }),
  responses: {
    200: { description: "Named query rows" },
    404: { description: "App or query not found" },
  },
});

const syncAppRoute = route({
  method: "post",
  path: "/api/apps/{id}/sync",
  pattern: ["api", "apps", null, "sync"],
  summary: "Synchronize app source projections",
  description: "Runs all matching model and source sync passes sequentially.",
  tags: ["Apps"],
  params: appParamsSchema,
  body: z.object({ model: AppNameSchema.optional(), source: AppNameSchema.optional() }),
  responses: {
    200: { description: "Sync pass results" },
    400: { description: "Unknown model, source, or empty sync selection" },
    403: { description: "Permission denied" },
    404: { description: "App not found" },
  },
  rbac: { permission: "app.manage" },
});

const runActionRoute = route({
  method: "post",
  path: "/api/apps/{id}/actions/{name}",
  pattern: ["api", "apps", null, "actions", null],
  summary: "Run a custom app action",
  description:
    "Runs the sync pass or saved script, or creates the agent task named by the app definition.",
  tags: ["Apps"],
  params: z.object({ id: z.string().min(1), name: AppNameSchema }),
  body: z.object({ input: z.record(z.string(), z.unknown()).optional() }),
  responses: {
    200: { description: "Action invoked" },
    400: { description: "Invalid action input or stale script reference" },
    403: { description: "Permission denied" },
    404: { description: "App or action not found" },
  },
  rbac: { permission: "app.manage" },
});

function authorizeAppWrite(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
): boolean {
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else {
    const agent = myAgentId ? getAgentById(myAgentId) : null;
    principal = { kind: "agent", agentId: myAgentId ?? "", isLead: agent?.isLead ?? false };
  }
  const decision = can({
    principal,
    verb: "app.manage",
    resource: { kind: "none" },
    source: "http",
  });
  if (decision.allow) return true;
  jsonError(res, decision.reason, 403);
  return false;
}

function invalidDefinition(res: ServerResponse, issues: AppValidationIssue[]): void {
  json(res, { error: "invalid app definition", issues }, 400);
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

interface RowFilter {
  column: string;
  value: unknown;
}

function filtersFromQuery(
  queryParams: URLSearchParams,
  model: ModelDef,
): { filters: RowFilter[]; issues: AppValidationIssue[] } {
  const filters: RowFilter[] = [];
  const issues: AppValidationIssue[] = [];
  for (const [key, raw] of queryParams.entries()) {
    if (!key.startsWith("filter.")) continue;
    const columnName = key.slice("filter.".length);
    if (!Object.hasOwn(model.columns, columnName)) {
      issues.push({ path: key, message: `unknown column "${columnName}"` });
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

export function applyQuery(rows: AppRow[], query: AppQueryDef, model: ModelDef): AppRow[] {
  let selected = rows.filter((row) =>
    Object.entries(query.filter ?? {}).every(([column, value]) => rowValue(row, column) === value),
  );
  const sort = query.sort;
  if (sort) {
    selected = [...selected].sort((a, b) => {
      const result = compareValues(
        rowValue(a, sort.column),
        rowValue(b, sort.column),
        sort.dir,
        sort.column === "createdAt" ||
          sort.column === "updatedAt" ||
          sort.column === "syncedAt" ||
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
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const definition = parseAppDefinition(parsed.body.definition);
    if (!definition.success) {
      invalidDefinition(res, definition.issues);
      return true;
    }
    json(
      res,
      {
        app: createApp({
          name: parsed.body.name,
          description: parsed.body.description,
          definition: definition.definition,
        }),
      },
      201,
    );
    return true;
  }

  if (listAppsRoute.match(req.method, pathSegments)) {
    json(res, { apps: listApps() });
    return true;
  }

  if (bulkCreateRowsRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BULK_ROWS_BODY_BYTES) === BODY_TOO_LARGE)
      return true;
    const parsed = await bulkCreateRowsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const rows = await createAppRows(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.body.rows.map((row) => row.values),
      );
      json(res, { rows });
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (createRowRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await createRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const row = await createAppRow(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.body.values,
      );
      json(res, { row }, 201);
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (listRowsRoute.match(req.method, pathSegments)) {
    const parsed = await listRowsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
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
        (column !== "createdAt" &&
          column !== "updatedAt" &&
          column !== "syncedAt" &&
          !Object.hasOwn(resolved.model.columns, column))
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
          column === "createdAt" ||
            column === "updatedAt" ||
            column === "syncedAt" ||
            (Object.hasOwn(resolved.model.columns, column) &&
              resolved.model.columns[column]!.kind === "date"),
        );
        return result;
      });
    }
    const total = rows.length;
    json(res, { rows: rows.slice(0, parsed.query.limit ?? 200), total });
    return true;
  }

  if (getRowRoute.match(req.method, pathSegments)) {
    const parsed = await getRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!resolveModel(parsed.params.id, parsed.params.model, res)) return true;
    const row = getAppRow(parsed.params.id, parsed.params.model, parsed.params.rowId);
    if (!row) {
      jsonError(res, "row not found", 404);
      return true;
    }
    json(res, { row });
    return true;
  }

  if (patchRowRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await patchRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const resolved = resolveModel(parsed.params.id, parsed.params.model, res);
    if (!resolved) return true;
    try {
      const row = await patchAppRow(
        parsed.params.id,
        parsed.params.model,
        resolved.model,
        parsed.params.rowId,
        parsed.body.values,
      );
      if (!row) {
        jsonError(res, "row not found", 404);
        return true;
      }
      json(res, { row });
    } catch (error) {
      if (!invalidRows(res, error)) throw error;
    }
    return true;
  }

  if (deleteRowRoute.match(req.method, pathSegments)) {
    const parsed = await deleteRowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
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
    json(res, { ok: true });
    return true;
  }

  if (runNamedQueryRoute.match(req.method, pathSegments)) {
    const parsed = await runNamedQueryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const app = getApp(parsed.params.id);
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
    json(res, { rows: applyQuery(listAppRows(app.id, query.model), query, model) });
    return true;
  }

  if (syncAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await syncAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    try {
      json(res, await runAppSync(app, parsed.body));
    } catch (error) {
      if (!(error instanceof SyncSelectionError)) throw error;
      json(res, { error: error.message, issues: error.issues }, 400);
    }
    return true;
  }

  if (runActionRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_ROW_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await runActionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;

    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    const actions = app.definition.actions;
    if (!actions || !Object.hasOwn(actions, parsed.params.name)) {
      jsonError(res, "app action not found", 404);
      return true;
    }

    const action = actions[parsed.params.name]!;
    const input = parsed.body.input ?? {};
    if (action.kind === "sync") {
      const startedAt = Date.now();
      try {
        const sync = await runAppSync(app, { model: action.model, source: action.source });
        const error = sync.ok
          ? undefined
          : sync.passes
              .filter((pass) => pass.error !== undefined)
              .map((pass) => `${pass.model}.${pass.source}: ${pass.error}`)
              .join("; ");
        json(res, {
          ok: sync.ok,
          result: { passes: sync.passes },
          ...(error ? { error } : {}),
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        if (!(error instanceof SyncSelectionError)) throw error;
        json(res, { error: "invalid app action", issues: error.issues }, 400);
      }
      return true;
    }
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

      // Spike tradeoff: app managers currently run saved scripts with the owner's bindings; revisit
      // with invoker-rights checks or invoker-brokered credentials before productization.
      const runAsAgentId = script.scopeId ?? script.createdByAgentId;
      if (!runAsAgentId) {
        jsonError(res, "agentId is required: this script has no owning agent to run as", 400);
        return true;
      }

      const credentials = await buildScriptCredentialBindingsWithFailures({
        agentId: runAsAgentId,
      });
      const output = await runScript({
        source: script.source,
        args: { ...action.args, ...input, app: { id: app.id } },
        fsMode: script.fsMode,
        agentId: runAsAgentId,
        egressSecrets: credentials.egressSecrets,
        failedBindings: credentials.failedBindings,
        apiConnections: getScriptApiConnectionDescriptors({ agentId: runAsAgentId }),
        mcpConnections: getScriptMcpConnectionDescriptors({ agentId: runAsAgentId }),
      });
      const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
      const error = ok
        ? undefined
        : output.runtimeError
          ? `${output.runtimeError.name}: ${output.runtimeError.message}`
          : (output.error ?? `Script exited with code ${output.exitCode}`);
      json(
        res,
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
    });
    json(res, { ok: true, taskId: task.id, status: task.status });
    return true;
  }

  if (patchAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await patchAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;

    const existing = getApp(parsed.params.id);
    if (!existing) {
      jsonError(res, "app not found", 404);
      return true;
    }
    const patch = applyAppDefinitionPatch(existing.definition, parsed.body.definition ?? {});
    if (!patch.success) {
      invalidDefinition(res, patch.issues);
      return true;
    }
    const definition = parseAppDefinition(patch.definition);
    if (!definition.success) {
      invalidDefinition(res, definition.issues);
      return true;
    }
    // Spike limitation: schema updates do not migrate rows or rebuild KV indexes.
    const app = updateApp(parsed.params.id, {
      name: parsed.body.name,
      description: parsed.body.description,
      definition: definition.definition,
    });
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    json(res, { app });
    return true;
  }

  if (updateAppRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_APP_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await updateAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    if (!getApp(parsed.params.id)) {
      jsonError(res, "app not found", 404);
      return true;
    }
    let definition: AppDefinition | undefined;
    if (parsed.body.definition !== undefined) {
      const parsedDefinition = parseAppDefinition(parsed.body.definition);
      if (!parsedDefinition.success) {
        invalidDefinition(res, parsedDefinition.issues);
        return true;
      }
      definition = parsedDefinition.definition;
    }
    // Spike limitation: schema updates do not migrate rows or rebuild KV indexes.
    const app = updateApp(parsed.params.id, {
      name: parsed.body.name,
      description: parsed.body.description,
      definition,
    });
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    json(res, { app });
    return true;
  }

  if (deleteAppRoute.match(req.method, pathSegments)) {
    const parsed = await deleteAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!authorizeAppWrite(req, res, myAgentId)) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    let deleted = false;
    await purgeAppRows(app.id, Object.keys(app.definition.models), () => {
      deleted = deleteApp(app.id);
    });
    if (!deleted) {
      jsonError(res, "app not found", 404);
      return true;
    }
    json(res, { ok: true });
    return true;
  }

  if (getAppRoute.match(req.method, pathSegments)) {
    const parsed = await getAppRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const app = getApp(parsed.params.id);
    if (!app) {
      jsonError(res, "app not found", 404);
      return true;
    }
    json(res, { app });
    return true;
  }

  return false;
}
