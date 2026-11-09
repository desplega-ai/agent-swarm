import { validateJsonSchema } from "./json-schema-validator";

/**
 * Shared output-schema validation for both first-attempt and retry completion paths.
 * Returns an error message if the successful result fails the node's outputSchema, else null.
 */
export function validateOutputSchema(
  node: { outputSchema?: Record<string, unknown> | null },
  result: { status: string; output: unknown },
): string | null {
  if (!node.outputSchema || result.status !== "success") {
    return null;
  }
  const errors = validateJsonSchema(
    node.outputSchema as Record<string, unknown>,
    result.output,
  );
  if (errors.length === 0) {
    return null;
  }
  return `Output schema validation failed: ${errors.join("; ")}`;
}
