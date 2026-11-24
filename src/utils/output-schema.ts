/**
 * Task `outputSchema` presence rules, shared by the API server and workers.
 *
 * An explicit empty schema (`{}`) means "no output schema". Callers pass it on
 * purpose to stop a child task from inheriting the parent's schema. It must
 * never reach a harness as a contract: a worker told to return JSON matching
 * `{}` completes with the literal output "{}" and drops its real result.
 */

import { validateJsonSchema } from "../workflows/json-schema-validator";

/** True when `schema` is a non-empty JSON Schema object the task must satisfy. */
export function isEffectiveOutputSchema(schema: unknown): schema is Record<string, unknown> {
  return (
    !!schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Object.keys(schema).length > 0
  );
}

/** Returns the schema when it is effective, otherwise `undefined`. */
export function normalizeOutputSchema(schema: unknown): Record<string, unknown> | undefined {
  return isEffectiveOutputSchema(schema) ? schema : undefined;
}

/**
 * Texts that may hold the JSON in an agent's final message, in the order to
 * try them: the whole message, each fenced code block from last to first, then
 * the span from the first `{` (or `[`) to the last `}` (or `]`). Agents often
 * answer a schema-bound task with "Here is the result:" plus a ```json block
 * instead of calling store-progress, and `JSON.parse` on the whole message
 * fails on that. Fences run last to first because an earlier fence is often an
 * example or a draft that also matches the schema, and the answer comes last.
 */
export function jsonOutputCandidates(text: string): string[] {
  const candidates = [text];
  const fenced: string[] = [];
  for (const match of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)) {
    if (match[1]?.trim()) fenced.push(match[1].trim());
  }
  candidates.push(...fenced.reverse());
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  }
  return [...new Set(candidates)];
}

/**
 * `value` without the `null`s a strict-mode harness writes for optional
 * properties (Codex `outputSchema`, see src/providers/codex-output-schema.ts).
 * Only keys `schema` does not list in `required` are dropped.
 */
export function stripOptionalNulls(schema: unknown, value: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const node = schema as { properties?: unknown; required?: unknown; items?: unknown };
  if (Array.isArray(value)) return value.map((item) => stripOptionalNulls(node.items, item));
  if (
    !value ||
    typeof value !== "object" ||
    !node.properties ||
    typeof node.properties !== "object"
  ) {
    return value;
  }
  const properties = node.properties as Record<string, unknown>;
  const required = Array.isArray(node.required) ? node.required : [];
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && !required.includes(key)) continue;
    out[key] = stripOptionalNulls(properties[key], child);
  }
  return out;
}

/**
 * Whether an agent's final message satisfies `schema`. `output` is set when
 * the accepted JSON differs from the raw text (it came out of a fence or
 * prose, or lost strict-mode `null`s). `errors` holds the first candidate's
 * validation errors when some candidate parsed but none matched.
 */
export function matchOutputSchema(
  schema: Record<string, unknown>,
  text: string,
): { ok: true; output?: string } | { ok: false; errors?: string[] } {
  let firstErrors: string[] | undefined;
  for (const [index, candidate] of jsonOutputCandidates(text).entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const errors = validateJsonSchema(schema, parsed);
    if (errors.length === 0) return index === 0 ? { ok: true } : { ok: true, output: candidate };
    const stripped = stripOptionalNulls(schema, parsed);
    if (validateJsonSchema(schema, stripped).length === 0) {
      return { ok: true, output: JSON.stringify(stripped) };
    }
    firstErrors ??= errors;
  }
  return { ok: false, errors: firstErrors };
}
