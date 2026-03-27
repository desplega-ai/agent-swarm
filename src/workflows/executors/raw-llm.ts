import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

export const RawLlmConfigSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  fallbackPort: z.string().optional(),
});

export const RawLlmOutputSchema = z.object({
  result: z.unknown(),
  model: z.string(),
});

// ─── Executor ───────────────────────────────────────────────

export class RawLlmExecutor extends BaseExecutor<
  typeof RawLlmConfigSchema,
  typeof RawLlmOutputSchema
> {
  readonly type = "raw-llm";
  readonly mode = "instant" as const;
  readonly configSchema = RawLlmConfigSchema;
  readonly outputSchema = RawLlmOutputSchema;

  protected async execute(
    config: z.infer<typeof RawLlmConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof RawLlmOutputSchema>>> {
    const prompt = this.deps.interpolate(config.prompt, context as Record<string, unknown>);
    const modelName = config.model ?? "google/gemini-2.0-flash-001";

    try {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openrouter = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });
      const model = openrouter(modelName);

      if (config.schema) {
        const { generateObject, jsonSchema } = await import("ai");
        const { object } = await generateObject({
          model,
          schema: jsonSchema(config.schema),
          prompt,
          providerOptions: {
            openai: { strictJsonSchema: false },
          },
        });
        return {
          status: "success",
          output: { result: object, model: modelName },
        };
      }

      const { generateText } = await import("ai");
      const { text } = await generateText({
        model,
        prompt,
      });
      return {
        status: "success",
        output: { result: text, model: modelName },
      };
    } catch (err) {
      if (config.fallbackPort) {
        return {
          status: "success",
          output: { result: null, model: modelName },
          nextPort: config.fallbackPort,
          error: `LLM call failed, using fallback port: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        status: "failed",
        error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
