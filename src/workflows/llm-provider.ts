import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface LlmProvider {
  query<T>(input: string, schema: z.ZodSchema<T>): Promise<T>;
}

class OpenRouterProvider implements LlmProvider {
  async query<T>(input: string, schema: z.ZodSchema<T>): Promise<T> {
    const { generateObject, zodSchema } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });

    const { object } = await generateObject({
      model: openrouter("google/gemini-2.0-flash-001"),
      schema: zodSchema(schema as z.core.$ZodType<T>),
      prompt: input,
    });
    return object;
  }
}

class ClaudeCliProvider implements LlmProvider {
  async query<T>(input: string, schema: z.ZodSchema<T>): Promise<T> {
    // biome-ignore lint/suspicious/noExplicitAny: zodToJsonSchema types only accept Zod v3; cast is safe at runtime
    const jsonSchema = JSON.stringify(zodToJsonSchema(schema as any));
    const proc = Bun.spawn(
      ["claude", "-p", "--model", "haiku", "--output-format", "json", "--json-schema", jsonSchema],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(input);
    proc.stdin.end();
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(output);
    // Claude CLI with --output-format json wraps result, extract the actual content
    const result = parsed.result ?? parsed;
    return schema.parse(result);
  }
}

let provider: LlmProvider | null = null;

export function createProvider(): LlmProvider {
  if (provider) return provider;
  if (process.env.OPENROUTER_API_KEY) {
    provider = new OpenRouterProvider();
  } else {
    provider = new ClaudeCliProvider();
  }
  return provider;
}

/** Reset the cached provider. Useful for tests. */
export function resetProvider(): void {
  provider = null;
}
