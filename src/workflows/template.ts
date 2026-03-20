/**
 * Replace {{path.to.value}} tokens in a template string
 * with values from the context object.
 *
 * Returns the interpolated result and a list of any unresolved token paths.
 */

export interface InterpolateResult {
  result: string;
  unresolved: string[];
}

export function interpolate(template: string, ctx: Record<string, unknown>): InterpolateResult {
  const unresolved: string[] = [];
  const result = template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const keys = path.trim().split(".");
    let value: unknown = ctx;
    for (const key of keys) {
      if (value == null || typeof value !== "object") {
        unresolved.push(path.trim());
        return "";
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (value == null) {
      unresolved.push(path.trim());
      return "";
    }
    return typeof value === "object" ? safeStringify(value) : String(value);
  });
  return { result, unresolved };
}

/**
 * Circular-reference-safe JSON.stringify for interpolation.
 * Returns "[Circular]" instead of throwing on circular structures.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[Circular]";
  }
}

/**
 * Deep-interpolate an arbitrary value tree (objects, arrays, strings).
 * Non-string leaves are passed through unchanged.
 */
export function deepInterpolate(
  value: unknown,
  ctx: Record<string, unknown>,
): { value: unknown; unresolved: string[] } {
  const allUnresolved: string[] = [];

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const { result, unresolved } = interpolate(v, ctx);
      allUnresolved.push(...unresolved);
      return result;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v != null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }

  return { value: walk(value), unresolved: allUnresolved };
}
