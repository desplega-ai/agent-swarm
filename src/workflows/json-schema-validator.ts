/**
 * Minimal hand-rolled JSON Schema validator.
 *
 * Supports the subset needed for workflow I/O schemas:
 * - `type`: "object", "string", "number", "boolean", "array"
 * - `required`: array of required property names
 * - `properties`: map of property name → schema (recursive)
 *
 * Returns an array of validation error strings (empty = valid).
 */
export function validateJsonSchema(schema: Record<string, unknown>, data: unknown): string[] {
  const errors: string[] = [];
  validate(schema, data, "", errors);
  return errors;
}

function validate(
  schema: Record<string, unknown>,
  data: unknown,
  path: string,
  errors: string[],
): void {
  const prefix = path || "root";

  // Type check
  if (schema.type !== undefined) {
    const expected = schema.type as string;
    if (!matchesType(expected, data)) {
      errors.push(`${prefix}: expected type "${expected}", got ${typeOf(data)}`);
      return; // No point checking properties of wrong type
    }
  }

  // Required fields (only for objects)
  if (Array.isArray(schema.required) && typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required as string[]) {
      if (!(key in obj)) {
        errors.push(`${prefix}: missing required property "${key}"`);
      }
    }
  }

  // Enum check
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((v) => JSON.stringify(v) === JSON.stringify(data))) {
      errors.push(
        `${prefix}: value ${JSON.stringify(data)} not in enum [${allowed.map((v) => JSON.stringify(v)).join(", ")}]`,
      );
      return;
    }
  }

  // Const check
  if ("const" in schema) {
    if (JSON.stringify(data) !== JSON.stringify(schema.const)) {
      errors.push(
        `${prefix}: value ${JSON.stringify(data)} does not match const ${JSON.stringify(schema.const)}`,
      );
      return;
    }
  }

  // Recursive property validation (only for objects)
  if (
    schema.properties !== undefined &&
    typeof schema.properties === "object" &&
    schema.properties !== null &&
    typeof data === "object" &&
    data !== null
  ) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const obj = data as Record<string, unknown>;
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) {
        validate(subSchema, obj[key], path ? `${path}.${key}` : key, errors);
      }
    }
  }

  // Items validation (for arrays)
  if (
    schema.items !== undefined &&
    typeof schema.items === "object" &&
    schema.items !== null &&
    Array.isArray(data)
  ) {
    const itemSchema = schema.items as Record<string, unknown>;
    for (let i = 0; i < data.length; i++) {
      validate(itemSchema, data[i], `${prefix}[${i}]`, errors);
    }
  }
}

function matchesType(expected: string, data: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof data === "string";
    case "number":
      return typeof data === "number";
    case "boolean":
      return typeof data === "boolean";
    case "array":
      return Array.isArray(data);
    case "object":
      return typeof data === "object" && data !== null && !Array.isArray(data);
    default:
      return true; // Unknown type — don't block
  }
}

function typeOf(data: unknown): string {
  if (data === null) return "null";
  if (data === undefined) return "undefined";
  if (Array.isArray(data)) return "array";
  return typeof data;
}
