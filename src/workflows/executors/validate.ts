import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

export const ValidateConfigSchema = z.object({
  targetNodeId: z.string(),
  prompt: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});

export const ValidateOutputSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

// ─── Executor ───────────────────────────────────────────────

export class ValidateExecutor extends BaseExecutor<
  typeof ValidateConfigSchema,
  typeof ValidateOutputSchema
> {
  readonly type = "validate";
  readonly mode = "instant" as const;
  readonly configSchema = ValidateConfigSchema;
  readonly outputSchema = ValidateOutputSchema;

  protected async execute(
    config: z.infer<typeof ValidateConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof ValidateOutputSchema>>> {
    const targetOutput = context[config.targetNodeId];
    if (targetOutput === undefined) {
      return {
        status: "success",
        output: {
          pass: false,
          reasoning: `Target node "${config.targetNodeId}" has no output in context`,
          confidence: 1,
        },
        nextPort: "fail",
      };
    }

    // Schema-based validation (no LLM call needed)
    if (config.schema) {
      return this.validateWithSchema(targetOutput, config.schema);
    }

    // Prompt-based validation (uses LLM)
    if (config.prompt) {
      return this.validateWithLlm(targetOutput, config.prompt, context);
    }

    // Neither schema nor prompt — just check that output exists
    return {
      status: "success",
      output: { pass: true, reasoning: "Target node output exists", confidence: 1 },
      nextPort: "pass",
    };
  }

  private validateWithSchema(
    targetOutput: unknown,
    schema: Record<string, unknown>,
  ): ExecutorResult<z.infer<typeof ValidateOutputSchema>> {
    try {
      // Use JSON Schema validation via Zod's loose parsing:
      // Convert the JSON Schema to a basic check. For full JSON Schema support
      // we'd need ajv, but for now we do structural matching.
      const errors = validateJsonSchemaBasic(targetOutput, schema);
      if (errors.length === 0) {
        return {
          status: "success",
          output: { pass: true, reasoning: "Output matches schema", confidence: 1 },
          nextPort: "pass",
        };
      }
      return {
        status: "success",
        output: {
          pass: false,
          reasoning: `Schema validation failed: ${errors.join("; ")}`,
          confidence: 1,
        },
        nextPort: "fail",
      };
    } catch (err) {
      return {
        status: "success",
        output: {
          pass: false,
          reasoning: `Schema validation error: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0.5,
        },
        nextPort: "fail",
      };
    }
  }

  private async validateWithLlm(
    targetOutput: unknown,
    prompt: string,
    context: Readonly<Record<string, unknown>>,
  ): Promise<ExecutorResult<z.infer<typeof ValidateOutputSchema>>> {
    const interpolatedPrompt = this.deps.interpolate(prompt, context as Record<string, unknown>);
    const outputStr =
      typeof targetOutput === "string" ? targetOutput : JSON.stringify(targetOutput);

    try {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const { generateObject, jsonSchema } = await import("ai");

      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      const { object } = await generateObject({
        model: openrouter("google/gemini-2.0-flash-001"),
        schema: jsonSchema({
          type: "object",
          properties: {
            pass: { type: "boolean" },
            reasoning: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["pass", "reasoning", "confidence"],
        }),
        prompt: `Evaluate the following output against the validation criteria.

Criteria: ${interpolatedPrompt}

Output to validate:
${outputStr}

Respond with pass (boolean), reasoning (string), and confidence (0-1).`,
      });

      const result = object as { pass: boolean; reasoning: string; confidence: number };
      return {
        status: "success",
        output: result,
        nextPort: result.pass ? "pass" : "fail",
      };
    } catch (err) {
      return {
        status: "success",
        output: {
          pass: false,
          reasoning: `LLM validation failed: ${err instanceof Error ? err.message : String(err)}`,
          confidence: 0,
        },
        nextPort: "fail",
      };
    }
  }
}

// ─── Basic JSON Schema Validator ────────────────────────────

function validateJsonSchemaBasic(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (schema.type) {
    const expectedType = schema.type as string;
    if (expectedType === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`Expected object, got ${Array.isArray(value) ? "array" : typeof value}`);
        return errors;
      }
      // Check properties with const/enum constraints
      if (schema.properties && typeof schema.properties === "object") {
        const props = schema.properties as Record<string, Record<string, unknown>>;
        const obj = value as Record<string, unknown>;
        for (const [key, propSchema] of Object.entries(props)) {
          if ("const" in propSchema && obj[key] !== propSchema.const) {
            errors.push(
              `Property "${key}": expected const ${JSON.stringify(propSchema.const)}, got ${JSON.stringify(obj[key])}`,
            );
          }
          if ("enum" in propSchema && Array.isArray(propSchema.enum)) {
            if (!propSchema.enum.includes(obj[key])) {
              errors.push(
                `Property "${key}": expected one of ${JSON.stringify(propSchema.enum)}, got ${JSON.stringify(obj[key])}`,
              );
            }
          }
        }
      }
      // Check required fields
      if (Array.isArray(schema.required)) {
        const obj = value as Record<string, unknown>;
        for (const key of schema.required as string[]) {
          if (!(key in obj)) {
            errors.push(`Missing required property "${key}"`);
          }
        }
      }
    } else if (expectedType === "string" && typeof value !== "string") {
      errors.push(`Expected string, got ${typeof value}`);
    } else if (expectedType === "number" && typeof value !== "number") {
      errors.push(`Expected number, got ${typeof value}`);
    } else if (expectedType === "boolean" && typeof value !== "boolean") {
      errors.push(`Expected boolean, got ${typeof value}`);
    } else if (expectedType === "array" && !Array.isArray(value)) {
      errors.push(`Expected array, got ${typeof value}`);
    }
  }

  return errors;
}
