/**
 * Task `outputSchema` -> the schema Codex sends as `turn/start.outputSchema`.
 *
 * Codex forwards that schema to the Responses API with `strict: true`, and
 * strict mode rejects the whole turn (HTTP 400 `invalid_json_schema`) unless
 * every object sets `additionalProperties: false` and lists every property in
 * `required`. Task schemas rarely do, so this rewrites them: each object is
 * closed and an optional property becomes required-but-nullable. The model
 * then answers `null` for an optional field it would have left out;
 * `stripOptionalNulls` (src/utils/output-schema.ts) drops those again before
 * the result is validated against the original schema.
 *
 * A schema that strict mode cannot express without changing its meaning (an
 * open object, an array without `items`, `oneOf`/`allOf`, unknown keywords)
 * returns `undefined`, and the turn runs unconstrained as before.
 */

const KEPT_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "description",
  "title",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);
/** Annotations strict mode may reject and that never change what validates. */
const DROPPED_KEYWORDS = new Set(["$schema", "$id", "$comment", "default", "examples"]);
const STRUCTURAL_KEYWORDS = new Set([
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
]);
/** The Responses API allows 10 levels of nesting; each recursion is one level. */
const MAX_DEPTH = 10;

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function convert(node: unknown, depth: number): Schema | undefined {
  if (!isSchema(node) || depth > MAX_DEPTH) return undefined;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (KEPT_KEYWORDS.has(key)) out[key] = value;
    else if (!DROPPED_KEYWORDS.has(key) && !STRUCTURAL_KEYWORDS.has(key)) return undefined;
  }

  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  if (types.length === 0 && !("enum" in node) && !("const" in node) && !("anyOf" in node)) {
    return undefined;
  }

  if ("anyOf" in node) {
    if (!Array.isArray(node.anyOf)) return undefined;
    const branches = node.anyOf.map((branch) => convert(branch, depth + 1));
    if (branches.some((branch) => !branch)) return undefined;
    out.anyOf = branches;
  }

  if (types.includes("object") || "properties" in node) {
    if (!isSchema(node.properties)) return undefined;
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      return undefined;
    }
    const keys = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    if (required.some((name) => !keys.includes(name as string))) return undefined;
    const properties: Schema = {};
    for (const key of keys) {
      const child = convert(node.properties[key], depth + 1);
      if (!child) return undefined;
      properties[key] = required.includes(key) ? child : { anyOf: [child, { type: "null" }] };
    }
    out.properties = properties;
    out.required = keys;
    out.additionalProperties = false;
  } else if ("required" in node || "additionalProperties" in node) {
    return undefined;
  }

  if (types.includes("array") || "items" in node) {
    const items = convert(node.items, depth + 1);
    if (!items) return undefined;
    out.items = items;
  }
  return out;
}

/** The strict-mode form of `schema`, or `undefined` when it has none. */
export function toCodexOutputSchema(schema: unknown): Schema | undefined {
  if (!isSchema(schema) || schema.type !== "object") return undefined;
  return convert(schema, 1);
}
