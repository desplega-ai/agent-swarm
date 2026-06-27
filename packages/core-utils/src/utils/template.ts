/**
 * Replace {{path.to.value}} tokens in a template string
 * with values from the context object.
 *
 * Returns the interpolated result and a list of any unresolved token paths.
 *
 * Lives in `utils/` (not `workflows/`) so any domain — prompts, worker
 * commands, HTTP handlers, MCP tools — can interpolate template strings
 * without taking a dependency on the workflow engine module. The workflow
 * engine re-exports these from `@/workflows/template` for its own use.
 */

export interface InterpolateResult {
  result: string;
  unresolved: string[];
}

export interface DeepInterpolateOptions {
  preserveRawTokens?: boolean;
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

/** Matches a string that is EXACTLY one {{path}} token with no surrounding text. */
const EXACT_TOKEN_RE = /^\{\{([^}]+)\}\}$/;

/**
 * Resolve a dot-separated path against a context object.
 * Returns `{ found: true, value }` on success, `{ found: false }` when any
 * segment is missing or the traversal hits a non-object.
 */
function resolvePath(
  path: string,
  ctx: Record<string, unknown>,
): { found: true; value: unknown } | { found: false } {
  const keys = path.trim().split(".");
  let value: unknown = ctx;
  for (const key of keys) {
    if (value == null || typeof value !== "object") return { found: false };
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) return { found: false };
  return { found: true, value };
}

/**
 * Deep-interpolate an arbitrary value tree (objects, arrays, strings).
 *
 * When `preserveRawTokens` is true and a string value is **exactly** one
 * `{{path}}` token with no surrounding text, the resolved value is returned
 * as-is (preserving object / array / number / boolean types). This is the
 * "raw injection" path used by `swarm-script` node `config.args`.
 *
 * When a string contains multiple tokens or surrounding text (e.g.
 * `"prefix-{{x}}"`) the existing string-interpolation path is used so the
 * result remains a string.
 *
 * Non-string leaves are passed through unchanged.
 */
export function deepInterpolate(
  value: unknown,
  ctx: Record<string, unknown>,
  options: DeepInterpolateOptions = {},
): { value: unknown; unresolved: string[] } {
  const allUnresolved: string[] = [];

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const exactMatch = options.preserveRawTokens ? EXACT_TOKEN_RE.exec(v) : null;
      if (exactMatch?.[1]) {
        const path = exactMatch[1].trim();
        const resolved = resolvePath(path, ctx);
        if (!resolved.found) {
          allUnresolved.push(path);
          return "";
        }
        return resolved.value;
      }
      // Multi-token or mixed string - fall back to string interpolation.
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
