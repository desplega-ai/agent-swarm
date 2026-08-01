import * as z from "zod";
import { getScriptById } from "../be/scripts/db";
import catalog from "./catalog.generated.json";
import { validatePage } from "./page-validator";

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
  .object({ columns: z.record(AppNameSchema, ColumnDefSchema) })
  .superRefine((model, ctx) => {
    const count = Object.keys(model.columns).length;
    if (count < 1 || count > 40) {
      ctx.addIssue({ code: "custom", path: ["columns"], message: "must define 1 to 40 columns" });
    }
    for (const name of Object.keys(model.columns)) {
      if (name === "id" || name === "createdAt" || name === "updatedAt") {
        ctx.addIssue({
          code: "custom",
          path: ["columns", name],
          message: "reserved column name",
        });
      }
    }
  });

const AppQueryDefSchema = z.object({
  model: AppNameSchema,
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
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
]);

export const AppDefinitionSchema = z
  .object({
    models: z.record(AppNameSchema, ModelDefSchema),
    queries: z.record(AppNameSchema, AppQueryDefSchema).optional(),
    actions: z.record(AppNameSchema, AppActionDefSchema).optional(),
    page: z.record(z.string(), z.unknown()),
  })
  .superRefine((definition, ctx) => {
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
        !Object.hasOwn(model.columns, sortColumn)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["queries", queryName, "sort", "column"],
          message: `unknown column "${sortColumn}"`,
        });
      }
    }
  });

export type ColumnKind = z.infer<typeof ColumnKindSchema>;
export type ColumnDef = z.infer<typeof ColumnDefSchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
export type AppQueryDef = z.infer<typeof AppQueryDefSchema>;
export type AppActionDef = z.infer<typeof AppActionDefSchema>;
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

export function parseAppDefinition(
  input: unknown,
): { success: true; definition: AppDefinition } | { success: false; issues: AppValidationIssue[] } {
  const parsed = AppDefinitionSchema.safeParse(input);
  if (!parsed.success) return { success: false, issues: appDefinitionIssues(parsed.error) };

  const issues = validatePage(parsed.data, catalog);
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

function applyMergePatch(target: unknown, patch: unknown, path: string[]): unknown {
  if (!isMergePatchObject(patch)) return patch;

  const result: Record<string, unknown> = isMergePatchObject(target) ? { ...target } : {};
  const entriesAreAtomic =
    (path.length === 1 && path[0] === "actions") ||
    (path.length === 2 && path[0] === "page" && path[1] === "elements");

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
 * mutating either input. Individual action and page-element entries are
 * intentionally atomic so callers cannot accidentally leave half of one
 * executable/renderable subtree behind.
 */
export function applyAppDefinitionPatch(
  stored: AppDefinition,
  patch: unknown,
): AppDefinitionPatchResult {
  const issues = dangerousPatchKeyIssues(patch);
  if (issues.length > 0) return { success: false, issues };

  const merged = applyMergePatch(structuredClone(stored), patch, []);
  return { success: true, definition: structuredClone(merged) };
}
