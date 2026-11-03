/**
 * Task `outputSchema` presence rules, shared by the API server and workers.
 *
 * An explicit empty schema (`{}`) means "no output schema". Callers pass it on
 * purpose to stop a child task from inheriting the parent's schema. It must
 * never reach a harness as a contract: a worker told to return JSON matching
 * `{}` completes with the literal output "{}" and drops its real result.
 */

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
