import * as z from "zod";
import { getScriptById } from "../be/scripts/db";
import catalog from "./catalog.generated.json";
import { crossPageDefinitionIssues, validatePage } from "./page-validator";

export const AppNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, {
  message: "must start with a lowercase letter and contain only letters, numbers, or underscores",
});

export const ColumnKindSchema = z.enum(["string", "number", "boolean", "date", "enum"]);

const SourceTransformSchema = z.enum(["slug", "lower", "upper", "cents", "date-parse"]);

const SourceBindingSchema = z.object({
  of: AppNameSchema,
  field: z.string().min(1, { message: "field must not be empty" }),
  transform: SourceTransformSchema.optional(),
});

const SourceDefSchema = z.discriminatedUnion("connector", [
  z.object({
    connector: z.literal("swarm-tasks"),
    joinKey: AppNameSchema,
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({
    connector: z.literal("script"),
    joinKey: AppNameSchema,
    scriptId: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
]);

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
    source: SourceBindingSchema.optional(),
  })
  .superRefine((column, ctx) => {
    if (column.kind === "enum") {
      if (!column.enum || column.enum.length === 0) {
        ctx.addIssue({ code: "custom", path: ["enum"], message: "enum values are required" });
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
      if (
        name === "id" ||
        name === "createdAt" ||
        name === "updatedAt" ||
        name === "source" ||
        name === "syncedAt" ||
        name === "stale"
      ) {
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
    agentId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal("sync"),
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

export const AppDefinitionSchema = z
  .object({
    models: z.record(AppNameSchema, ModelDefSchema),
    queries: z.record(AppNameSchema, AppQueryDefSchema).optional(),
    actions: z.record(AppNameSchema, AppActionDefSchema).optional(),
    page: AppPageSchema.optional(),
    pages: z.record(AppNameSchema, AppPageSchema).optional(),
    defaultPage: AppNameSchema.optional(),
  })
  .superRefine((definition, ctx) => {
    const hasPage = definition.page !== undefined;
    const hasPages = definition.pages !== undefined;
    if (hasPage === hasPages) {
      ctx.addIssue({
        code: "custom",
        path: [hasPage ? "pages" : "page"],
        message: hasPage
          ? "page and pages are mutually exclusive"
          : "exactly one of page or pages is required",
      });
    }
    if (hasPages) {
      if (definition.defaultPage === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultPage"],
          message: "defaultPage is required when pages is defined",
        });
      } else if (!Object.hasOwn(definition.pages!, definition.defaultPage)) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultPage"],
          message: `unknown page "${definition.defaultPage}"`,
        });
      }
    } else if (definition.defaultPage !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultPage"],
        message: "defaultPage is only allowed when pages is defined",
      });
    }

    const pages = definition.pages ?? (definition.page ? { main: definition.page } : {});
    const pagesPath = definition.pages ? "pages" : "page";
    for (const [pageName, page] of Object.entries(pages)) {
      for (const paramName of Object.keys(page.params ?? {})) {
        if (RESERVED_PAGE_PARAM_NAMES.has(paramName)) {
          ctx.addIssue({
            code: "custom",
            path:
              pagesPath === "pages"
                ? [pagesPath, pageName, "params", paramName]
                : [pagesPath, "params", paramName],
            message: "reserved param name",
          });
        }
      }
    }

    const modelCount = Object.keys(definition.models).length;
    if (modelCount < 1 || modelCount > 10) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "must define 1 to 10 models" });
    }

    const actionCount = Object.keys(definition.actions ?? {}).length;
    if (actionCount > 20) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: "must define at most 20 actions",
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
        if (!Object.hasOwn(model.columns, column)) {
          ctx.addIssue({
            code: "custom",
            path: ["queries", queryName, "filter", column],
            message: `unknown column "${column}"`,
          });
          continue;
        }
        const columnDefinition = model.columns[column]!;
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
        sortColumn !== "syncedAt" &&
        !Object.hasOwn(model.columns, sortColumn)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["queries", queryName, "sort", "column"],
          message: `unknown column "${sortColumn}"`,
        });
      }
    }
  })
  .transform((definition) => {
    const { page, pages, defaultPage, ...rest } = definition;
    if (page !== undefined) {
      return { ...rest, pages: { main: page }, defaultPage: "main" };
    }
    return { ...rest, pages: pages!, defaultPage: defaultPage! };
  });

export type ColumnKind = z.infer<typeof ColumnKindSchema>;
export type ColumnDef = z.infer<typeof ColumnDefSchema>;
export type SourceDef = z.infer<typeof SourceDefSchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
export type AppQueryDef = z.infer<typeof AppQueryDefSchema>;
export type AppActionDef = z.infer<typeof AppActionDefSchema>;
export type AppPageParam = z.infer<typeof AppPageParamSchema>;
export type AppPage = z.infer<typeof AppPageSchema>;
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;

export interface AppValidationIssue {
  path: string;
  message: string;
}

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

function sourceDefinitionIssues(definition: AppDefinition): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];

  for (const [modelName, model] of Object.entries(definition.models)) {
    const sources = model.sources ?? {};
    for (const [sourceName, source] of Object.entries(sources)) {
      const sourcePath = `models.${modelName}.sources.${sourceName}`;
      const joinColumn = Object.hasOwn(model.columns, source.joinKey)
        ? model.columns[source.joinKey]
        : undefined;
      if (!joinColumn) {
        issues.push({
          path: `${sourcePath}.joinKey`,
          message: `unknown column "${source.joinKey}"`,
        });
      } else {
        if (joinColumn.kind !== "string") {
          issues.push({
            path: `${sourcePath}.joinKey`,
            message: "join key must reference a string column",
          });
        }
        if (joinColumn.source !== undefined) {
          issues.push({
            path: `models.${modelName}.columns.${source.joinKey}.source`,
            message: "sync join-key columns must not carry a source binding",
          });
        }
        if (joinColumn.required === true) {
          issues.push({
            path: `models.${modelName}.columns.${source.joinKey}.required`,
            message: "sync join-key columns must not be required",
          });
        }
        if (joinColumn.default !== undefined) {
          issues.push({
            path: `models.${modelName}.columns.${source.joinKey}.default`,
            message: "sync join-key columns must not carry a default",
          });
        }
      }

      if (source.connector === "script" && !getScriptById(source.scriptId)) {
        issues.push({
          path: `${sourcePath}.scriptId`,
          message: `script "${source.scriptId}" not found`,
        });
      }
    }

    for (const [columnName, column] of Object.entries(model.columns)) {
      const columnPath = `models.${modelName}.columns.${columnName}`;
      if (column.source) {
        if (!Object.hasOwn(sources, column.source.of)) {
          issues.push({
            path: `${columnPath}.source.of`,
            message: `unknown source "${column.source.of}"`,
          });
        }
        const transform = column.source.transform;
        const compatible =
          transform === undefined ||
          ((transform === "slug" || transform === "lower" || transform === "upper") &&
            column.kind === "string") ||
          (transform === "cents" && column.kind === "number") ||
          (transform === "date-parse" && column.kind === "date");
        if (!compatible) {
          issues.push({
            path: `${columnPath}.source.transform`,
            message: `transform "${transform}" is not compatible with ${column.kind} columns`,
          });
        }
        if (column.required === true) {
          issues.push({
            path: `${columnPath}.required`,
            message: "source-bound columns must not be required",
          });
        }
        if (column.default !== undefined) {
          issues.push({
            path: `${columnPath}.default`,
            message: "source-bound columns must not carry a default",
          });
        }
      } else if (
        Object.keys(sources).length > 0 &&
        column.required === true &&
        column.default === undefined
      ) {
        issues.push({
          path: `${columnPath}.default`,
          message: "required owned columns on a sourced model must carry a default",
        });
      }
    }
  }

  for (const [actionName, action] of Object.entries(definition.actions ?? {})) {
    if (action.kind !== "sync") continue;

    const models = action.model
      ? Object.hasOwn(definition.models, action.model)
        ? [[action.model, definition.models[action.model]!] as const]
        : []
      : Object.entries(definition.models);
    if (action.model) {
      const model = Object.hasOwn(definition.models, action.model)
        ? definition.models[action.model]
        : undefined;
      if (!model) {
        issues.push({
          path: `actions.${actionName}.model`,
          message: `unknown model "${action.model}"`,
        });
      } else if (Object.keys(model.sources ?? {}).length === 0) {
        issues.push({
          path: `actions.${actionName}.model`,
          message: `model "${action.model}" has no sources`,
        });
      }
    }

    const matches = models.flatMap(([, model]) =>
      Object.keys(model.sources ?? {}).filter(
        (sourceName) => action.source === undefined || sourceName === action.source,
      ),
    );
    if (action.source !== undefined && matches.length === 0) {
      issues.push({
        path: `actions.${actionName}.source`,
        message: action.model
          ? `unknown source "${action.source}" on model "${action.model}"`
          : `unknown source "${action.source}"`,
      });
    }
    if (matches.length === 0) {
      issues.push({
        path: `actions.${actionName}`,
        message: "sync action matches no model sources",
      });
    }
  }

  return issues;
}

export function parseAppDefinition(
  input: unknown,
): { success: true; definition: AppDefinition } | { success: false; issues: AppValidationIssue[] } {
  const parsed = AppDefinitionSchema.safeParse(input);
  if (!parsed.success) return { success: false, issues: appDefinitionIssues(parsed.error) };

  const issues = [
    ...Object.keys(parsed.data.pages).flatMap((pageName) =>
      validatePage(parsed.data, catalog, pageName),
    ),
    ...crossPageDefinitionIssues(parsed.data, catalog),
    ...sourceDefinitionIssues(parsed.data),
  ];
  for (const [name, action] of Object.entries(parsed.data.actions ?? {})) {
    if (action.kind === "script" && !getScriptById(action.scriptId)) {
      issues.push({
        path: `actions.${name}.scriptId`,
        message: `script "${action.scriptId}" not found`,
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

  return issues;
}

function applyMergePatch(target: unknown, patch: unknown, path: string[]): unknown {
  if (!isMergePatchObject(patch)) return patch;

  const result: Record<string, unknown> = isMergePatchObject(target) ? { ...target } : {};
  const entriesAreAtomic =
    (path.length === 1 && path[0] === "actions") ||
    (path.length === 2 && path[0] === "page" && path[1] === "elements") ||
    (path.length === 3 &&
      path[0] === "models" &&
      (path[2] === "columns" || path[2] === "sources")) ||
    (path.length === 3 && path[0] === "pages" && (path[2] === "elements" || path[2] === "params"));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    defineMergePatchValue(
      result,
      key,
      entriesAreAtomic ? value : applyMergePatch(result[key], value, [...path, key]),
    );
  }
  return result;
}

/**
 * Apply RFC 7396 JSON Merge Patch semantics to an app definition without
 * mutating either input. Individual action, page-element, model-column, and
 * model-source entries are intentionally atomic so callers cannot accidentally
 * leave half of one executable/renderable subtree behind.
 */
export function applyAppDefinitionPatch(
  stored: AppDefinition,
  patch: unknown,
): AppDefinitionPatchResult {
  const issues = definitionPatchIssues(stored, patch);
  if (issues.length > 0) return { success: false, issues };

  const merged = applyMergePatch(structuredClone(stored), patch, []);
  return { success: true, definition: structuredClone(merged) };
}
