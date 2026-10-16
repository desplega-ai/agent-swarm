/**
 * Config references: `{ "$config": "KEY" }` leaves inside a JSON config value
 * that point at another config key (usually a secret). Pure, no DB access: the
 * caller supplies the lookup and decides which keys are allowed.
 */

export interface ConfigRef {
  $config: string;
}

/** True when `value` is exactly `{ "$config": "<non-empty string>" }`. */
export function isConfigRef(value: unknown): value is ConfigRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const ref = (value as { $config?: unknown }).$config;
  return keys.length === 1 && keys[0] === "$config" && typeof ref === "string" && ref.length > 0;
}

export class ConfigRefError extends Error {
  constructor(
    message: string,
    readonly missingKeys: string[],
  ) {
    super(message);
    this.name = "ConfigRefError";
  }
}

/**
 * Replace every `{ "$config": "KEY" }` leaf in `value` with `lookup(KEY)`.
 * Walks arrays and plain objects. Missing keys (lookup returns undefined) are
 * collected and reported in one error. A lookup that throws (for example on a
 * forbidden key) propagates as-is.
 */
export function resolveConfigRefs<T>(
  value: unknown,
  lookup: (key: string) => string | undefined,
): T {
  const missing = new Set<string>();

  const walk = (node: unknown): unknown => {
    if (isConfigRef(node)) {
      const resolved = lookup(node.$config);
      if (resolved === undefined) missing.add(node.$config);
      return resolved;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };

  const result = walk(value);
  if (missing.size > 0) {
    const keys = [...missing].sort();
    throw new ConfigRefError(`Unresolved config reference(s): ${keys.join(", ")}`, keys);
  }
  return result as T;
}
