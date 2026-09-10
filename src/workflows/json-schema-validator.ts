/**
 * Minimal hand-rolled JSON Schema validator.
 *
 * Supports the subset needed for workflow I/O schemas and `triggerSchema`:
 * - `type`: "object", "string", "number", "boolean", "array"
 * - `required`: array of required property names
 * - `properties`: map of property name → schema (recursive)
 * - `enum`: array of allowed primitive values (strict equality)
 * - `const`: a single allowed value (strict equality)
 * - `items`: schema applied to every element of an array (recursive)
 *
 * Other JSON-Schema keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`,
 * `additionalProperties`, etc.) are silently ignored. Document any new
 * authoring surface for `triggerSchema` accordingly.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates that a candidate JSON Schema uses only the shape `validateJsonSchema`
 * above can consume — every nested schema under `properties`/`items` must itself
 * be a plain object. A schema that passes this check can never crash the
 * validator (e.g. `{ properties: { answer: null } }` reading `null.type`).
 *
 * Returns an array of error strings naming the offending path (empty = valid).
 */
export function findJsonSchemaShapeErrors(schema: unknown, path = "outputSchema"): string[] {
  const errors: string[] = [];

  if (!isPlainObject(schema)) {
    errors.push(`${path}: must be a JSON Schema object, got ${typeOf(schema)}`);
    return errors;
  }

  if (schema.type !== undefined && typeof schema.type !== "string") {
    errors.push(`${path}.type: must be a string, got ${typeOf(schema.type)}`);
  }

  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every((v) => typeof v === "string"))
  ) {
    errors.push(`${path}.required: must be an array of strings`);
  }

  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    errors.push(`${path}.enum: must be an array`);
  }

  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      errors.push(`${path}.properties: must be an object mapping property names to schemas`);
    } else {
      for (const [key, value] of Object.entries(schema.properties)) {
        errors.push(...findJsonSchemaShapeErrors(value, `${path}.properties.${key}`));
      }
    }
  }

  if (schema.items !== undefined) {
    errors.push(...findJsonSchemaShapeErrors(schema.items, `${path}.items`));
  }

  return errors;
}
