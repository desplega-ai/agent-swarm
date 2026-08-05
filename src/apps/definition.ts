import * as z from "zod";
import { getScriptById } from "../be/scripts/db";
import { getSavedScriptOwnerAgentId } from "../be/scripts/run-saved";
import catalog from "./catalog.generated.json";
import {
  crossPageDefinitionIssues,
  type ElementReferenceContext,
  elementDefinitionIssues,
  validatePage,
} from "./page-validator";

export const AppNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, {
  message: "must start with a lowercase letter and contain only letters, numbers, or underscores",
});

export const ColumnKindSchema = z.enum(["string", "number", "boolean", "date", "enum"]);

const ISO_8601_PREFIX = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;

export function isIso8601Date(value: string): boolean {
  return ISO_8601_PREFIX.test(value) && !Number.isNaN(Date.parse(value));
}

const ColumnDefSchema = z
  .object({
    kind: ColumnKindSchema,
    required: z.boolean().optional(),
    enum: z.array(z.string()).optional(),
    index: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    hidden: z.boolean().optional(),
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

const ModelDefSchema = z
  .object({
    columns: z.record(AppNameSchema, ColumnDefSchema),
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
};

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

export const AppDefinitionSchema = z
  .object({
    models: z.record(AppNameSchema, ModelDefSchema),
    queries: z.record(AppNameSchema, AppQueryDefSchema).optional(),
    actions: z.record(AppNameSchema, AppActionDefSchema).optional(),
    elements: AppElementsSchema.optional(),
    userConfig: UserConfigSchema.optional(),
    pages: z.record(AppNameSchema, AppPageSchema),
    defaultPage: AppNameSchema,
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
        sortColumn !== "createdAt" &&
        sortColumn !== "updatedAt" &&
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
]);

const TOP_LEVEL_KEY_SUGGESTIONS: Record<string, string> = {
  element: "elements",
  userconfig: "userConfig",
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
   * The app's current stored definition, for grandfathering: script ids already
   * wired into the app stay referenceable so an agent can keep editing an app
   * that legitimately carries another owner's script action.
   */
  existingDefinition?: unknown;
};

/** Defensively collect script action ids from a possibly-broken definition. */
function collectScriptActionIds(definition: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isMergePatchObject(definition)) return ids;
  const actions = definition.actions;
  if (!isMergePatchObject(actions)) return ids;
  for (const action of Object.values(actions)) {
    if (isMergePatchObject(action) && typeof action.scriptId === "string") {
      ids.add(action.scriptId);
    }
  }
  return ids;
}

export function parseAppDefinition(
  input: unknown,
  elementContext: AppDefinitionParseContext = {},
): { success: true; definition: AppDefinition } | { success: false; issues: AppValidationIssue[] } {
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
    ...elementDefinitionIssues(parsed.data, catalog, elementContext),
  ];
  const grandfatheredScriptIds = collectScriptActionIds(elementContext.existingDefinition);
  for (const [name, action] of Object.entries(parsed.data.actions ?? {})) {
    if (action.kind !== "script") continue;
    const script = getScriptById(action.scriptId);
    if (!script) {
      issues.push({
        path: `actions.${name}.scriptId`,
        message: `script "${action.scriptId}" not found`,
      });
      continue;
    }
    // Invoke-time runs the script with the OWNER's bindings, so an agent writer
    // may only wire scripts it owns (or global ones). Script ids already present
    // in the stored definition are grandfathered so foreign-authored apps stay
    // editable.
    if (
      elementContext.writerAgentId &&
      script.scope === "agent" &&
      getSavedScriptOwnerAgentId(script) !== elementContext.writerAgentId &&
      !grandfatheredScriptIds.has(action.scriptId)
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
 * mutating either input. Individual action, page-element, and model-column
 * entries are intentionally atomic. A reusable-element patch containing only
 * `elements` merges node-by-node; any other key makes it a full replacement.
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
