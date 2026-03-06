import type { NodeResult } from "../engine";

export interface PropertyMatchCondition {
  field: string; // dot-path into context, e.g. "trigger.source"
  op: "eq" | "neq" | "contains" | "not_contains" | "gt" | "lt" | "exists";
  value?: unknown;
}

export interface PropertyMatchConfig {
  conditions: PropertyMatchCondition[];
  mode?: "all" | "any"; // default: "all"
}

export function executePropertyMatch(
  config: PropertyMatchConfig,
  ctx: Record<string, unknown>,
): NodeResult {
  const mode = config.mode ?? "all";
  const results = config.conditions.map((cond) => evaluateCondition(cond, ctx));
  const passed = mode === "all" ? results.every(Boolean) : results.some(Boolean);
  return { mode: "instant", nextPort: passed ? "true" : "false", output: { passed, results } };
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
