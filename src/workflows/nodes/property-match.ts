import type { NodeResult } from "../engine";

export interface PropertyMatchCondition {
  field: string; // dot-path into context, e.g. "trigger.source"
  op: "eq" | "neq" | "contains" | "not_contains" | "gt" | "lt" | "exists";
  value?: unknown;
}

export interface PropertyMatchConfig {
  conditions?: PropertyMatchCondition[];
  mode?: "all" | "any"; // default: "all"
  // Flat single-condition format — workflow definitions created via the API/UI
  // store property-match nodes as { property, operator, value } rather than
  // the conditions array format used in code/tests. Both formats are supported.
  property?: string;
  operator?: PropertyMatchCondition["op"];
  value?: unknown;
}

export function executePropertyMatch(
  config: PropertyMatchConfig,
  ctx: Record<string, unknown>,
): NodeResult {
  const mode = config.mode ?? "all";
  const conditions = normalizeConditions(config);
  if (conditions === null) {
    return {
      mode: "instant",
      nextPort: "false",
      output: { passed: false, results: [], error: "No valid conditions configured" },
    };
  }
  const results = conditions.map((cond) => evaluateCondition(cond, ctx));
  const passed = mode === "all" ? results.every(Boolean) : results.some(Boolean);
  return { mode: "instant", nextPort: passed ? "true" : "false", output: { passed, results } };
}

function normalizeConditions(config: PropertyMatchConfig): PropertyMatchCondition[] | null {
  if (config.conditions && config.conditions.length > 0) {
    return config.conditions;
  }
  if (config.property && config.operator) {
    return [{ field: config.property, op: config.operator, value: config.value }];
  }
  if (config.property && !config.operator) {
    console.warn(
      `[workflow] property-match node has "property" (${config.property}) but no "operator" — node will fail`,
    );
  }
  return null;
}

function evaluateCondition(cond: PropertyMatchCondition, ctx: Record<string, unknown>): boolean {
  const value = resolvePath(ctx, cond.field);
  switch (cond.op) {
    case "eq":
      return value === cond.value;
    case "neq":
      return value !== cond.value;
    case "contains":
      return Array.isArray(value)
        ? value.includes(cond.value)
        : String(value ?? "").includes(String(cond.value));
    case "not_contains":
      return Array.isArray(value)
        ? !value.includes(cond.value)
        : !String(value ?? "").includes(String(cond.value));
    case "gt":
      return Number(value) > Number(cond.value);
    case "lt":
      return Number(value) < Number(cond.value);
    case "exists":
      return value != null;
    default:
      return false;
  }
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
