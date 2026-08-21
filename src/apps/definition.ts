import * as z from "zod";
import { listScriptConnections } from "../be/script-connections";
import { getScriptById } from "../be/scripts/db";
import { getSavedScriptOwnerAgentId } from "../be/scripts/run-saved";
import catalog from "./catalog.generated.json";
import {
  crossPageDefinitionIssues,
  type ElementReferenceContext,
  elementDefinitionIssues,
  validatePage,
} from "./page-validator";
import { resolveSyncRunAs } from "./sync-run-as";

export const AppNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, {
  message: "must start with a lowercase letter and contain only letters, numbers, or underscores",
});

export const ColumnKindSchema = z.enum(["string", "number", "boolean", "date", "enum"]);

const ISO_8601_PREFIX = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;

export function isIso8601Date(value: string): boolean {
  return ISO_8601_PREFIX.test(value) && !Number.isNaN(Date.parse(value));
}

export const SourceTransformSchema = z.enum(["slug", "lower", "upper", "cents", "date-parse"]);

/** Column kind each transform may target — the sync engine projects into it. */
const TRANSFORM_COLUMN_KIND: Record<z.infer<typeof SourceTransformSchema>, ColumnKind> = {
  slug: "string",
  lower: "string",
  upper: "string",
  cents: "number",
  "date-parse": "date",
};

const ColumnSourceBindingSchema = z
  .object({
    of: AppNameSchema,
    field: z.string().min(1),
    transform: SourceTransformSchema.optional(),
  })
  .strict();

const ColumnDefSchema = z
  .object({
    kind: ColumnKindSchema,
    required: z.boolean().optional(),
    enum: z.array(z.string()).optional(),
    index: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    hidden: z.boolean().optional(),
    source: ColumnSourceBindingSchema.optional(),
  })
  .superRefine((column, ctx) => {
    if (column.kind === "enum") {
      if (!column.enum || column.enum.length === 0) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values are required" });
      } else if (column.enum.some((value) => value.length === 0)) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values must be non-empty" });
      } else if (new Set(column.enum).size !== column.enum.length) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values must be unique" });
      }
    } else if (column.enum !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["enum"],
        message: "enum values are only allowed for enum columns",
      });
    }

    if (column.default === undefined) return;
    const valid =
      (column.kind === "string" && typeof column.default === "string") ||
      (column.kind === "number" &&
        typeof column.default === "number" &&
        Number.isFinite(column.default)) ||
      (column.kind === "boolean" && typeof column.default === "boolean") ||
      (column.kind === "date" &&
        typeof column.default === "string" &&
        isIso8601Date(column.default)) ||
      (column.kind === "enum" &&
        typeof column.default === "string" &&
        Boolean(column.enum?.includes(column.default)));
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default must be a valid ${column.kind} value`,
      });
    }
  });

const UserConfigFieldSchema = z
  .object({
    kind: ColumnKindSchema,
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z.array(z.string()).optional(),
    label: z.string().optional(),
    required: z.never().optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.kind === "enum") {
      if (!field.enum || field.enum.length === 0) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values are required" });
      } else if (field.enum.some((value) => value.length === 0)) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values must be non-empty" });
      } else if (new Set(field.enum).size !== field.enum.length) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values must be unique" });
      }
    } else if (field.enum !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["enum"],
        message: "enum values are only allowed for enum fields",
      });
    }

    if (field.default === undefined) return;
    const valid =
      (field.kind === "string" && typeof field.default === "string") ||
      (field.kind === "number" &&
        typeof field.default === "number" &&
        Number.isFinite(field.default)) ||
      (field.kind === "boolean" && typeof field.default === "boolean") ||
      (field.kind === "date" &&
        typeof field.default === "string" &&
        isIso8601Date(field.default)) ||
      (field.kind === "enum" &&
        typeof field.default === "string" &&
        Boolean(field.enum?.includes(field.default)));
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default must be a valid ${field.kind} value`,
      });
    }
  });

export const UserConfigSchema = z.record(AppNameSchema, UserConfigFieldSchema);

/**
 * An inbound projection of an external system into a model. Script sources are
 * the extensible default; `swarm-tasks` is the one native connector. The union
 * is discriminated so a merge patch can never splice two connector shapes.
 */
const SourceDefSchema = z.discriminatedUnion("connector", [
  // Strict: a typo'd key (e.g. `connnection`) silently stripped here would
  // surface only as an uncredentialed pull at sync time.
  z
    .object({
      connector: z.literal("script"),
      scriptId: z.string().uuid(),
      joinKey: AppNameSchema,
      args: z.record(z.string(), z.unknown()).optional(),
      connection: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      connector: z.literal("swarm-tasks"),
      joinKey: AppNameSchema,
      config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .strict(),
]);

const ModelDefSchema = z
  .object({
    columns: z.record(AppNameSchema, ColumnDefSchema),
    sources: z.record(AppNameSchema, SourceDefSchema).optional(),
  })
  .superRefine((model, ctx) => {
    const count = Object.keys(model.columns).length;
    if (count < 1 || count > 40) {
      ctx.addIssue({ code: "custom", path: ["columns"], message: "must define 1 to 40 columns" });
    }
    for (const name of Object.keys(model.columns)) {
      if (Object.hasOwn(SYSTEM_COLUMN_KINDS, name)) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", name],
          message: "reserved column name",
        });
      }
    }
    if (Object.keys(model.sources ?? {}).length > 4) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "must define at most 4 sources" });
    }
  });

const AppQueryParamRefSchema = z
  .object({
    $param: AppNameSchema,
  })
  .strict();

/**
 * Column kinds of the reserved system fields every stored row carries — query
 * filters may target these alongside declared model columns (a detail query's
 * only universal row identity is `id`).
 */
export const SYSTEM_COLUMN_KINDS: Record<string, "string" | "date" | "boolean"> = {
  id: "string",
  createdAt: "date",
  updatedAt: "date",
  createdBy: "string",
  updatedBy: "string",
  // Sync provenance, present only on source-owned rows.
  source: "string",
  syncedAt: "date",
  stale: "boolean",
};

/**
 * System row fields a sort may target alongside declared model columns. All are
 * ISO-8601 dates, so membership also selects date-aware comparison.
 */
export const SORTABLE_SYSTEM_DATE_COLUMNS = new Set(["createdAt", "updatedAt", "syncedAt"]);

const AppQueryDefSchema = z.object({
  model: AppNameSchema,
  filter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), AppQueryParamRefSchema]))
    .optional(),
  sort: z
    .object({
      column: z.string(),
      dir: z.enum(["asc", "desc"]),
    })
    .optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const AppActionDefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("script"),
    scriptId: z.string().uuid(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("task"),
    prompt: z.string().min(1),
    // Agent ids come verbatim from X-Agent-ID at registration and may be
    // non-UUID (custom stable ids), so no format pin here.
    agentId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("sync"),
    // Omitting both fans out to every (model x source) pair the app declares.
    model: AppNameSchema.optional(),
    source: AppNameSchema.optional(),
  }),
]);

const AppPageParamSchema = z
  .object({
    kind: z.enum(["string", "number", "boolean"]).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const RESERVED_PAGE_PARAM_NAMES = new Set(["mode", "apiUrl", "apiKey", "email", "name"]);

const AppPageSchema = z
  .object({
    root: z.string(),
    elements: z.record(z.string(), z.unknown()),
    title: z.string().optional(),
    params: z.record(AppNameSchema, AppPageParamSchema).optional(),
  })
  .strict();

const ElementPropDefSchema = z
  .object({
    kind: ColumnKindSchema,
    required: z.boolean().optional(),
    enum: z.array(z.string()).min(1).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((prop, ctx) => {
    if (prop.kind === "enum") {
      if (!prop.enum) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values are required" });
      }
    } else if (prop.enum !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["enum"],
        message: "enum values are only allowed for enum props",
      });
    }

    if (prop.default === undefined) return;
    const valid =
      (prop.kind === "string" && typeof prop.default === "string") ||
      (prop.kind === "number" &&
        typeof prop.default === "number" &&
        Number.isFinite(prop.default)) ||
      (prop.kind === "boolean" && typeof prop.default === "boolean") ||
      (prop.kind === "date" && typeof prop.default === "string" && isIso8601Date(prop.default)) ||
      (prop.kind === "enum" &&
        typeof prop.default === "string" &&
        Boolean(prop.enum?.includes(prop.default)));
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: `default must be a valid ${prop.kind} value`,
      });
    }
  });

const AppElementSchema = z
  .object({
    mode: z.enum(["pure", "bound"]),
    export: z.boolean().optional(),
    props: z.record(AppNameSchema, ElementPropDefSchema).optional(),
    root: z.string(),
    elements: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((element, ctx) => {
    if (Object.keys(element.elements).length > 150) {
      ctx.addIssue({
        code: "custom",
        path: ["elements"],
        message: "must contain at most 150 nodes",
      });
    }
  });

export const AppElementsSchema = z.record(AppNameSchema, AppElementSchema);

/**
 * Preset theme id applied to the app's rendered surface. The catalog of
 * presets lives in the dashboard (`apps/ui/src/lib/themes.ts`) — the server
 * validates shape only, and the renderer resolves unknown ids to its default
 * theme, so definitions stay portable across dashboard versions whose preset
 * catalogs differ. Viewers can override it per-user via the reserved
 * `$theme` user-config key (see `user-config.ts`).
 */
export const AppThemeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, {
  message: "must be a lowercase slug (letters, digits, dashes)",
});

export const AppDefinitionSchema = z
  .object({
    models: z.record(AppNameSchema, ModelDefSchema),
    queries: z.record(AppNameSchema, AppQueryDefSchema).optional(),
    actions: z.record(AppNameSchema, AppActionDefSchema).optional(),
    elements: AppElementsSchema.optional(),
    userConfig: UserConfigSchema.optional(),
    pages: z.record(AppNameSchema, AppPageSchema),
    defaultPage: AppNameSchema,
    theme: AppThemeIdSchema.optional(),
  })
  .superRefine((definition, ctx) => {
    if (!Object.hasOwn(definition.pages, definition.defaultPage)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultPage"],
        message: `unknown page "${definition.defaultPage}"`,
      });
    }

    for (const [pageName, page] of Object.entries(definition.pages)) {
      for (const paramName of Object.keys(page.params ?? {})) {
        if (RESERVED_PAGE_PARAM_NAMES.has(paramName)) {
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageName, "params", paramName],
            message: "reserved param name",
          });
        }
      }
    }

    const modelCount = Object.keys(definition.models).length;
    if (modelCount > 10) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "must define at most 10 models" });
    }

    const actionCount = Object.keys(definition.actions ?? {}).length;
    if (actionCount > 20) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: "must define at most 20 actions",
      });
    }

    const userConfigCount = Object.keys(definition.userConfig ?? {}).length;
    if (userConfigCount > 20) {
      ctx.addIssue({
        code: "custom",
        path: ["userConfig"],
        message: "must define at most 20 fields",
      });
    }

    const elementCount = Object.keys(definition.elements ?? {}).length;
    if (elementCount > 20) {
      ctx.addIssue({
        code: "custom",
        path: ["elements"],
        message: "must define at most 20 reusable elements",
      });
    }

    for (const [queryName, query] of Object.entries(definition.queries ?? {})) {
      if (!Object.hasOwn(definition.models, query.model)) {
        ctx.addIssue({
          code: "custom",
          path: ["queries", queryName, "model"],
          message: `unknown model "${query.model}"`,
        });
        continue;
      }
      const model = definition.models[query.model]!;
      for (const [column, value] of Object.entries(query.filter ?? {})) {
        const columnDefinition = Object.hasOwn(model.columns, column)
          ? model.columns[column]!
          : Object.hasOwn(SYSTEM_COLUMN_KINDS, column)
            ? { kind: SYSTEM_COLUMN_KINDS[column]! }
            : undefined;
        if (
          !columnDefinition ||
          ("hidden" in columnDefinition && columnDefinition.hidden === true)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["queries", queryName, "filter", column],
            message: `unknown or hidden column "${column}"`,
          });
          continue;
        }
        if (typeof value === "object") continue;
        const valid =
          (columnDefinition.kind === "string" && typeof value === "string") ||
          (columnDefinition.kind === "number" &&
            typeof value === "number" &&
            Number.isFinite(value)) ||
          (columnDefinition.kind === "boolean" && typeof value === "boolean") ||
          (columnDefinition.kind === "date" && typeof value === "string" && isIso8601Date(value)) ||
          (columnDefinition.kind === "enum" &&
            typeof value === "string" &&
            Boolean(columnDefinition.enum?.includes(value)));
        if (!valid) {
          ctx.addIssue({
            code: "custom",
            path: ["queries", queryName, "filter", column],
            message: `filter must be a valid ${columnDefinition.kind} value`,
          });
        }
      }
      const sortColumn = query.sort?.column;
      if (
        sortColumn &&
        !SORTABLE_SYSTEM_DATE_COLUMNS.has(sortColumn) &&
        (!Object.hasOwn(model.columns, sortColumn) || model.columns[sortColumn]!.hidden === true)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["queries", queryName, "sort", "column"],
          message: `unknown or hidden column "${sortColumn}"`,
        });
      }
    }
  });

export type ColumnKind = z.infer<typeof ColumnKindSchema>;
export type ColumnDef = z.infer<typeof ColumnDefSchema>;
export type ColumnSourceBinding = z.infer<typeof ColumnSourceBindingSchema>;
export type SourceTransform = z.infer<typeof SourceTransformSchema>;
export type SourceDef = z.infer<typeof SourceDefSchema>;
export type UserConfigField = z.infer<typeof UserConfigFieldSchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
export type AppQueryDef = z.infer<typeof AppQueryDefSchema>;
export type AppActionDef = z.infer<typeof AppActionDefSchema>;
export type AppPageParam = z.infer<typeof AppPageParamSchema>;
export type AppPage = z.infer<typeof AppPageSchema>;
export type AppElementPropDef = z.infer<typeof ElementPropDefSchema>;
export type AppElement = z.infer<typeof AppElementSchema>;
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;

export interface AppValidationIssue {
  path: string;
  message: string;
}

const APP_DEFINITION_TOP_LEVEL_KEYS = new Set([
  "models",
  "queries",
  "actions",
  "elements",
  "userConfig",
  "pages",
  "defaultPage",
  "schemaVersion",
  "theme",
]);

const TOP_LEVEL_KEY_SUGGESTIONS: Record<string, string> = {
  element: "elements",
  userconfig: "userConfig",
  themes: "theme",
  appearance: "theme",
  styling: "theme",
};

export type AppDefinitionPatchResult =
  | { success: true; definition: unknown }
  | { success: false; issues: AppValidationIssue[] };

function flattenIssue(issue: z.core.$ZodIssue, prefix: PropertyKey[] = []): AppValidationIssue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === "invalid_key" && issue.issues.length > 0) {
    return issue.issues.flatMap((nestedIssue) => flattenIssue(nestedIssue, path));
  }
  return [{ path: path.join("."), message: issue.message }];
}

export function appDefinitionIssues(error: z.ZodError): AppValidationIssue[] {
  return error.issues.flatMap((issue) => flattenIssue(issue));
}

export type AppDefinitionParseContext = ElementReferenceContext & {
  /**
   * Agent performing this definition write, when the writer is an agent.
   * Script actions run with the script OWNER's bindings at invoke time, so an
   * agent may only wire its own agent-scoped scripts (or global ones) into an
   * app. Omit / null for trusted writers (operator, snapshot restore).
   */
  writerAgentId?: string | null;
  /**
   * True when the writer is an authenticated web USER. Users own no scripts,
   * so every fresh agent-scoped reference is foreign for them — without this
   * flag a user write (which carries no agent id) would skip the ownership
   * gate exactly like the trusted operator.
   */
  writerIsUser?: boolean;
  /**
   * The app's current stored definition, for grandfathering: a script already
   * wired into the app stays referenceable AT ITS EXISTING PATH so an agent can
   * keep editing an app that legitimately carries another owner's script. The
   * bare id is never grandfathered — a stored foreign action must not seed a
   * new foreign source (or vice versa) with fresh args or a connection.
   */
  existingDefinition?: unknown;
};

/**
 * Defensively collect every script reference a possibly-broken definition
 * carries — script actions and model sources alike — keyed by script id with
 * the definition paths that name it. Tolerant by design: it walks raw JSON, so
 * an app whose definition no longer parses still reports its references.
 *
 * Two callers: grandfathering on write (an agent editing an app that
 * legitimately carries another owner's script must not be locked out) and the
 * script-delete guard in the scripts API.
 */
export function collectScriptReferences(definition: unknown): Map<string, string[]> {
  const references = new Map<string, string[]>();
  const add = (scriptId: unknown, path: string): void => {
    if (typeof scriptId !== "string" || scriptId.length === 0) return;
    const paths = references.get(scriptId);
    if (paths) paths.push(path);
    else references.set(scriptId, [path]);
  };
  if (!isMergePatchObject(definition)) return references;
  const actions = definition.actions;
  if (isMergePatchObject(actions)) {
    for (const [actionName, action] of Object.entries(actions)) {
      if (isMergePatchObject(action)) add(action.scriptId, `actions.${actionName}`);
    }
  }
  const models = definition.models;
  if (isMergePatchObject(models)) {
    for (const [modelName, model] of Object.entries(models)) {
      if (!isMergePatchObject(model) || !isMergePatchObject(model.sources)) continue;
      for (const [sourceName, source] of Object.entries(model.sources)) {
        if (isMergePatchObject(source)) {
          add(source.scriptId, `models.${modelName}.sources.${sourceName}`);
        }
      }
    }
  }
  return references;
}

/**
 * Is this agent-scoped script foreign to the writing principal? Operators
 * (no writer identity at all) may wire anything; an agent may wire its own;
 * a web user owns no scripts, so every agent-scoped script is foreign to it.
 */
function foreignScriptForWriter(
  context: AppDefinitionParseContext,
  script: NonNullable<Awaited<ReturnType<typeof getScriptById>>>,
): boolean {
  if (script.scope !== "agent") return false;
  if (context.writerIsUser === true) return true;
  if (!context.writerAgentId) return false;
  return getSavedScriptOwnerAgentId(script) !== context.writerAgentId;
}

/**
 * Canonical form of everything security-relevant about a script reference:
 * which script runs, with what arguments, over which connection. Grandfathering
 * compares THIS, not the bare id — an id-only match would let a non-owner keep
 * a stored foreign reference while swapping in attacker-chosen args or a
 * different connection, all executed under the owner's credentials.
 */
function scriptRefKey(scriptId: unknown, args: unknown, connection: unknown): string | null {
  if (typeof scriptId !== "string" || scriptId.length === 0) return null;
  return JSON.stringify({ scriptId, args: args ?? null, connection: connection ?? null });
}

/**
 * Path-exact grandfathering index: `definition path -> scriptRefKey`. A
 * reference is grandfathered only when the stored definition already carries
 * the SAME script, args, and connection at the SAME path.
 */
function collectScriptReferencePathMap(definition: unknown): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!isMergePatchObject(definition)) return byPath;
  const actions = definition.actions;
  if (isMergePatchObject(actions)) {
    for (const [actionName, action] of Object.entries(actions)) {
      if (!isMergePatchObject(action)) continue;
      const key = scriptRefKey(action.scriptId, action.args, undefined);
      if (key) byPath.set(`actions.${actionName}`, key);
    }
  }
  const models = definition.models;
  if (isMergePatchObject(models)) {
    for (const [modelName, model] of Object.entries(models)) {
      if (!isMergePatchObject(model) || !isMergePatchObject(model.sources)) continue;
      for (const [sourceName, source] of Object.entries(model.sources)) {
        if (!isMergePatchObject(source)) continue;
        const key = scriptRefKey(source.scriptId, source.args, source.connection);
        if (key) byPath.set(`models.${modelName}.sources.${sourceName}`, key);
      }
    }
  }
  return byPath;
}

/** Semantic checks for a model's sources and its columns' source bindings. */
async function modelSourceIssues(
  modelName: string,
  model: ModelDef,
  context: AppDefinitionParseContext,
  grandfatheredScriptRefs: Map<string, string>,
): Promise<AppValidationIssue[]> {
  const issues: AppValidationIssue[] = [];
  const sources = model.sources ?? {};
  const sourceNames = new Set(Object.keys(sources));

  for (const [sourceName, source] of Object.entries(sources)) {
    const path = `models.${modelName}.sources.${sourceName}`;
    const joinColumn = Object.hasOwn(model.columns, source.joinKey)
      ? model.columns[source.joinKey]!
      : undefined;
    if (!joinColumn || joinColumn.hidden === true) {
      issues.push({
        path: `${path}.joinKey`,
        message: `unknown or hidden column "${source.joinKey}"`,
      });
    } else if (joinColumn.kind !== "string") {
      issues.push({
        path: `${path}.joinKey`,
        message: `join key column "${source.joinKey}" must be a string column`,
      });
    } else {
      if (joinColumn.source) {
        issues.push({
          path: `${path}.joinKey`,
          message: `join key column "${source.joinKey}" must not be bound to a source`,
        });
      }
      if (joinColumn.required === true) {
        issues.push({
          path: `${path}.joinKey`,
          message: `join key column "${source.joinKey}" must not be required`,
        });
      }
      if (joinColumn.default !== undefined) {
        issues.push({
          path: `${path}.joinKey`,
          message: `join key column "${source.joinKey}" must not declare a default`,
        });
      }
    }

    if (source.connector !== "script") continue;
    const script = await getScriptById(source.scriptId);
    if (!script) {
      issues.push({ path: `${path}.scriptId`, message: `script "${source.scriptId}" not found` });
      continue;
    }
    const runAs = await resolveSyncRunAs(script);
    const grandfatheredRef =
      grandfatheredScriptRefs.get(path) ===
      scriptRefKey(source.scriptId, source.args, source.connection);
    // A pull runs the script with its OWNER's bindings, so a writer may only
    // wire scripts it owns (or global ones) — the script-action rule.
    if (foreignScriptForWriter(context, script) && !grandfatheredRef) {
      issues.push({
        path: `${path}.scriptId`,
        message: `script "${source.scriptId}" is agent-scoped to another agent — reference a script you own or a global script`,
      });
    } else if (
      // Owner-less (and foreign-owned) GLOBAL scripts sync with runAs's
      // credential bindings — for the catalog that is the LEAD. Introducing or
      // altering such a source is that identity's (or the operator's)
      // privilege; every other writer keeps only pinned stored references.
      script.scope !== "agent" &&
      (context.writerIsUser === true || typeof context.writerAgentId === "string") &&
      context.writerAgentId !== runAs &&
      !grandfatheredRef
    ) {
      issues.push({
        path: `${path}.scriptId`,
        message: `script "${source.scriptId}" syncs with agent "${runAs}"'s credentials — only that agent or the operator may wire or alter this source`,
      });
    }
    if (source.connection !== undefined) {
      const reachable = listScriptConnections({ agentId: runAs });
      if (!reachable.some((connection) => connection.slug === source.connection)) {
        issues.push({
          path: `${path}.connection`,
          message: `connection "${source.connection}" not found or disabled for the sync run-as identity`,
        });
      }
    }
  }

  for (const [columnName, column] of Object.entries(model.columns)) {
    const path = `models.${modelName}.columns.${columnName}`;
    if (!column.source) {
      // Sync creates rows from projected fields alone, so every required column
      // it does NOT own has to be satisfiable without a writer.
      if (
        sourceNames.size > 0 &&
        column.required === true &&
        column.hidden !== true &&
        column.default === undefined
      ) {
        issues.push({
          path,
          message:
            "required column on a model with sources must declare a default — sync-created rows cannot supply it",
        });
      }
      continue;
    }
    if (!sourceNames.has(column.source.of)) {
      issues.push({ path: `${path}.source.of`, message: `unknown source "${column.source.of}"` });
    }
    const transform = column.source.transform;
    if (transform && TRANSFORM_COLUMN_KIND[transform] !== column.kind) {
      issues.push({
        path: `${path}.source.transform`,
        message: `transform "${transform}" requires a ${TRANSFORM_COLUMN_KIND[transform]} column`,
      });
    }
    if (column.required === true) {
      issues.push({
        path: `${path}.required`,
        message: "source-bound column must not be required",
      });
    }
    if (column.default !== undefined) {
      issues.push({
        path: `${path}.default`,
        message: "source-bound column must not declare a default",
      });
    }
  }

  return issues;
}

/** A `sync` action must resolve to at least one (model x source) pair. */
function syncActionIssues(
  name: string,
  action: { model?: string; source?: string },
  models: Record<string, ModelDef>,
): AppValidationIssue[] {
  if (action.model !== undefined && !Object.hasOwn(models, action.model)) {
    return [{ path: `actions.${name}.model`, message: `unknown model "${action.model}"` }];
  }
  const candidates = action.model !== undefined ? [action.model] : Object.keys(models);
  const pairs = candidates.flatMap((modelName) =>
    Object.keys(models[modelName]?.sources ?? {}).filter(
      (sourceName) => action.source === undefined || sourceName === action.source,
    ),
  );
  if (pairs.length > 0) return [];
  if (action.source !== undefined) {
    return [
      {
        path: `actions.${name}.source`,
        message:
          action.model !== undefined
            ? `unknown source "${action.source}" on model "${action.model}"`
            : `unknown source "${action.source}" — no model declares it`,
      },
    ];
  }
  if (action.model !== undefined) {
    return [
      { path: `actions.${name}.model`, message: `model "${action.model}" declares no sources` },
    ];
  }
  return [{ path: `actions.${name}`, message: "no model declares a source to sync" }];
}

export async function parseAppDefinition(
  input: unknown,
  elementContext: AppDefinitionParseContext = {},
): Promise<
  { success: true; definition: AppDefinition } | { success: false; issues: AppValidationIssue[] }
> {
  if (isMergePatchObject(input) && Object.hasOwn(input, "page")) {
    return {
      success: false,
      issues: [
        {
          path: "page",
          message: "legacy singular page is no longer supported — define pages plus defaultPage",
        },
      ],
    };
  }
  if (isMergePatchObject(input)) {
    const unknownKeys = Object.keys(input).filter((key) => !APP_DEFINITION_TOP_LEVEL_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return {
        success: false,
        issues: unknownKeys.map((key) => ({
          path: key,
          message: `unknown top-level key "${key}"${TOP_LEVEL_KEY_SUGGESTIONS[key] ? ` — did you mean "${TOP_LEVEL_KEY_SUGGESTIONS[key]}"?` : ""}`,
        })),
      };
    }
  }
  const parsedInput = isMergePatchObject(input) ? { ...input } : input;
  if (isMergePatchObject(parsedInput)) delete parsedInput.schemaVersion;
  const parsed = AppDefinitionSchema.safeParse(parsedInput);
  if (!parsed.success) return { success: false, issues: appDefinitionIssues(parsed.error) };

  const issues = [
    ...Object.keys(parsed.data.pages).flatMap((pageName) =>
      validatePage(parsed.data, catalog, pageName),
    ),
    ...crossPageDefinitionIssues(parsed.data, catalog),
    ...(await elementDefinitionIssues(parsed.data, catalog, elementContext)),
  ];
  const grandfatheredScriptRefs = collectScriptReferencePathMap(elementContext.existingDefinition);
  for (const [modelName, model] of Object.entries(parsed.data.models)) {
    issues.push(
      ...(await modelSourceIssues(modelName, model, elementContext, grandfatheredScriptRefs)),
    );
  }
  for (const [name, action] of Object.entries(parsed.data.actions ?? {})) {
    if (action.kind === "sync") {
      issues.push(...syncActionIssues(name, action, parsed.data.models));
      continue;
    }
    if (action.kind !== "script") continue;
    const script = await getScriptById(action.scriptId);
    if (!script) {
      issues.push({
        path: `actions.${name}.scriptId`,
        message: `script "${action.scriptId}" not found`,
      });
      continue;
    }
    // Invoke-time runs the script with the OWNER's bindings, so a writer may
    // only wire scripts it owns (or global ones). A reference the stored
    // definition already carries at this exact path is grandfathered so
    // foreign-authored apps stay editable — the bare id is not, so an existing
    // foreign reference cannot seed a new one elsewhere.
    if (
      foreignScriptForWriter(elementContext, script) &&
      grandfatheredScriptRefs.get(`actions.${name}`) !==
        scriptRefKey(action.scriptId, action.args, undefined)
    ) {
      issues.push({
        path: `actions.${name}.scriptId`,
        message: `script "${action.scriptId}" is agent-scoped to another agent — reference a script you own or a global script`,
      });
    }
  }

  if (issues.length > 0) return { success: false, issues };
  return { success: true, definition: parsed.data };
}

function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineMergePatchValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

const DANGEROUS_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function dangerousPatchKeyIssues(value: unknown, path: string[] = []): AppValidationIssue[] {
  if (!isMergePatchObject(value)) return [];

  const issues: AppValidationIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (DANGEROUS_PATCH_KEYS.has(key)) {
      issues.push({
        path: childPath.join("."),
        message: `unsafe merge patch key "${key}" is not allowed`,
      });
      continue;
    }
    issues.push(...dangerousPatchKeyIssues(child, childPath));
  }
  return issues;
}

function definitionPatchIssues(stored: AppDefinition, patch: unknown): AppValidationIssue[] {
  if (!isMergePatchObject(patch)) return [];

  const issues = dangerousPatchKeyIssues(patch);
  if (Object.hasOwn(patch, "page")) {
    issues.push({
      path: "page",
      message: "definitions are normalized to the pages map — patch pages.<name> instead",
    });
  }

  if (isMergePatchObject(patch.pages)) {
    const effectiveDefaultPage =
      typeof patch.defaultPage === "string" ? patch.defaultPage : stored.defaultPage;
    if (patch.pages[effectiveDefaultPage] === null) {
      issues.push({
        path: `pages.${effectiveDefaultPage}`,
        message: "cannot delete the default page",
      });
    }
  }

  if (isMergePatchObject(patch.elements)) {
    for (const [elementName, elementPatch] of Object.entries(patch.elements)) {
      if (!isMergePatchObject(elementPatch)) continue;
      const replacesWholeElement = Object.keys(elementPatch).some((key) => key !== "elements");
      if (!replacesWholeElement || !isMergePatchObject(elementPatch.elements)) continue;
      for (const [nodeId, nodePatch] of Object.entries(elementPatch.elements)) {
        if (nodePatch !== null) continue;
        issues.push({
          path: `elements.${elementName}.elements.${nodeId}`,
          message:
            "null node in a full element replace — to delete a node use elements.<name>.elements.<id> = null",
        });
      }
    }
  }

  return issues;
}

function withoutSchemaVersion(patch: unknown): unknown {
  if (!isMergePatchObject(patch)) return patch;
  const normalized = { ...patch };
  delete normalized.schemaVersion;
  return normalized;
}

function applyMergePatch(target: unknown, patch: unknown, path: string[]): unknown {
  if (!isMergePatchObject(patch)) return patch;

  const result: Record<string, unknown> = isMergePatchObject(target) ? { ...target } : {};
  const entriesAreAtomic =
    (path.length === 1 && path[0] === "actions") ||
    (path.length === 1 && path[0] === "elements") ||
    (path.length === 1 && path[0] === "userConfig") ||
    (path.length === 3 && path[0] === "models" && path[2] === "columns") ||
    (path.length === 3 && path[0] === "models" && path[2] === "sources") ||
    (path.length === 3 && path[0] === "elements" && path[2] === "elements") ||
    (path.length === 3 && path[0] === "pages" && (path[2] === "elements" || path[2] === "params"));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    defineMergePatchValue(
      result,
      key,
      entriesAreAtomic &&
        !(
          path.length === 1 &&
          path[0] === "elements" &&
          isMergePatchObject(value) &&
          Object.keys(value).length === 1 &&
          isMergePatchObject(value.elements)
        )
        ? value
        : applyMergePatch(result[key], value, [...path, key]),
    );
  }
  return result;
}

/**
 * Apply RFC 7396 JSON Merge Patch semantics to an app definition without
 * mutating either input. Individual action, page-element, model-column, and
 * model-source entries are intentionally atomic — whole-replaced, never
 * key-merged — so a patch can never splice two connector shapes together.
 * A reusable-element patch containing only `elements` merges node-by-node;
 * any other key makes it a full replacement.
 */
export function applyAppDefinitionPatch(
  stored: AppDefinition,
  patch: unknown,
): AppDefinitionPatchResult {
  const normalizedPatch = withoutSchemaVersion(patch);
  const issues = definitionPatchIssues(stored, normalizedPatch);
  if (issues.length > 0) return { success: false, issues };

  const merged = applyMergePatch(structuredClone(stored), normalizedPatch, []);
  return { success: true, definition: structuredClone(merged) };
}
