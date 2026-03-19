import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

const ConditionSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "neq", "contains", "not_contains", "gt", "lt", "exists"]),
  value: z.unknown().optional(),
});

export const PropertyMatchConfigSchema = z.object({
  conditions: z.array(ConditionSchema).min(1),
  mode: z.enum(["all", "any"]).default("all"),
});

const ConditionResultSchema = z.object({
  field: z.string(),
  op: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  passed: z.boolean(),
});

export const PropertyMatchOutputSchema = z.object({
  passed: z.boolean(),
  results: z.array(ConditionResultSchema),
});

// ─── Types ──────────────────────────────────────────────────

type PropertyMatchConfig = z.infer<typeof PropertyMatchConfigSchema>;
type ConditionResult = z.infer<typeof ConditionResultSchema>;

// ─── Executor ───────────────────────────────────────────────

export class PropertyMatchExecutor extends BaseExecutor<
  typeof PropertyMatchConfigSchema,
  typeof PropertyMatchOutputSchema
> {
  readonly type = "property-match";
  readonly mode = "instant" as const;
  readonly configSchema = PropertyMatchConfigSchema;
  readonly outputSchema = PropertyMatchOutputSchema;

  protected async execute(
    config: PropertyMatchConfig,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof PropertyMatchOutputSchema>>> {
    const results: ConditionResult[] = config.conditions.map((cond) => {
      const actual = resolvePath(context, cond.field);
      const passed = evaluateCondition(cond.op, actual, cond.value);
      return { field: cond.field, op: cond.op, expected: cond.value, actual, passed };
    });

    const passed =
      config.mode === "all" ? results.every((r) => r.passed) : results.some((r) => r.passed);

    return {
      status: "success",
      output: { passed, results },
      nextPort: passed ? "true" : "false",
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function evaluateCondition(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "contains":
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual ?? "").includes(String(expected));
    case "not_contains":
      return Array.isArray(actual)
        ? !actual.includes(expected)
        : !String(actual ?? "").includes(String(expected));
    case "gt":
      return Number(actual) > Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "exists":
      return actual != null;
    default:
      return false;
  }
}
