/**
 * Unforgeable host-only capability symbol set on `RunScriptInput` strictly at
 * the host boundary (`POST /api/x/script/{endpointId}`) after `validateJsonSchema`
 * succeeds. Because `Symbol` keys cannot be produced by JSON deserialization,
 * callers that forward request-shaped JSON fields into `RunScriptInput` can
 * never opt out of `argsSchema` validation.
 */
export const HOST_VALIDATED_ARGS = Symbol("swarm.hostValidatedArgs");

/**
 * Checks whether a runtime `argsSchema` (Zod v4 / `zod/mini` schema) and its
 * candidate `value` are semantically equivalent to the host-side JSON Schema
 * validation performed by `validateJsonSchema` in `src/http/x.ts`.
 *
 * Returns `true` only when `schema.parse(value)` is guaranteed to succeed and
 * return a value deeply identical to `value` without running any defaults,
 * coercions, transforms, refinements, or unknown-key stripping.
 */
export function isHostValidationEquivalent(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const zodInternal = (schema as { _zod?: { def?: Record<string, unknown>; values?: unknown } })
    ._zod;
  const def = zodInternal?.def;
  if (!def || typeof def !== "object") return false;

  if (def.coerce) return false;
  if (Array.isArray(def.checks) && def.checks.length > 0) return false;

  switch (def.type) {
    case "string":
      return typeof value === "string" && !def.format;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && !def.format;
    case "boolean":
      return typeof value === "boolean";
    case "literal": {
      const rawValues = def.values;
      const values = Array.isArray(rawValues)
        ? rawValues
        : rawValues instanceof Set
          ? Array.from(rawValues)
          : [];
      return (
        values.length > 0 &&
        values.some((v) => v === value && typeof v !== "bigint" && typeof v !== "symbol")
      );
    }
    case "enum": {
      if (zodInternal?.values instanceof Set) {
        return zodInternal.values.has(value);
      }
      const entriesObj =
        def.entries && typeof def.entries === "object"
          ? (def.entries as Record<string, unknown>)
          : null;
      if (!entriesObj) return false;
      const entries = Object.values(entriesObj).filter(
        (v) => !(typeof v === "string" && typeof entriesObj[v] === "number"),
      );
      return entries.length > 0 && entries.includes(value);
    }
    case "optional":
      return value === undefined
        ? isStructuralSchemaNode(def.innerType)
        : isHostValidationEquivalent(def.innerType, value);
    case "nullable":
      return value === null
        ? isStructuralSchemaNode(def.innerType)
        : isHostValidationEquivalent(def.innerType, value);
    case "array":
      return (
        Array.isArray(value) &&
        isStructuralSchemaNode(def.element) &&
        value.every((item) => isHostValidationEquivalent(def.element, item))
      );
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const rawShape = typeof def.shape === "function" ? def.shape() : def.shape;
      if (!rawShape || typeof rawShape !== "object") return false;
      const shape = rawShape as Record<string, unknown>;
      const obj = value as Record<string, unknown>;

      // If `value` carries extra keys not declared in `shape`, let `.parse()`
      // handle key stripping (`z.object`), passthrough (`z.looseObject`), or
      // rejection (`z.strictObject`).
      for (const key of Object.keys(obj)) {
        if (!Object.hasOwn(shape, key)) return false;
      }

      for (const [key, propSchema] of Object.entries(shape)) {
        // Retain Zod's property lookup semantics: if `key` is absent as an own
        // property on `obj` but resolves via `Object.prototype` (e.g. `constructor`,
        // `toString`), fall back to `.parse()` so Zod validates/rejects the
        // inherited prototype value identically to `main`.
        if (!Object.hasOwn(obj, key) && key in obj) return false;
        const propValue = obj[key];
        if (!isHostValidationEquivalent(propSchema, propValue)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function isStructuralSchemaNode(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def || typeof def !== "object") return false;
  if (def.coerce) return false;
  if (Array.isArray(def.checks) && def.checks.length > 0) return false;
  switch (def.type) {
    case "string":
    case "number":
      return !def.format;
    case "boolean":
    case "literal":
    case "enum":
      return true;
    case "optional":
    case "nullable":
      return isStructuralSchemaNode(def.innerType);
    case "array":
      return isStructuralSchemaNode(def.element);
    case "object": {
      const rawShape = typeof def.shape === "function" ? def.shape() : def.shape;
      if (!rawShape || typeof rawShape !== "object") return false;
      return Object.values(rawShape as Record<string, unknown>).every(isStructuralSchemaNode);
    }
    default:
      return false;
  }
}
