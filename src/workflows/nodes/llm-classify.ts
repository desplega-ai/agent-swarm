import { z } from "zod";
import type { NodeResult } from "../engine";
import { createProvider, type LlmProvider } from "../llm-provider";
import { interpolate } from "../template";

export interface LlmClassifyConfig {
  prompt: string;
  categories: string[];
  model?: string;
  fallbackPort?: string;
}

export async function executeLlmClassify(
  config: LlmClassifyConfig,
  ctx: Record<string, unknown>,
  providerOverride?: LlmProvider,
): Promise<NodeResult> {
  const prompt = interpolate(config.prompt, ctx);
  const categories = config.categories;
  const schema = z.object({
    category: z.enum(categories as [string, ...string[]]),
    confidence: z.number().min(0).max(1),
  });

  try {
    const provider = providerOverride ?? createProvider();
    const result = await provider.query(
      `Classify the following into one of these categories: ${categories.join(", ")}.\n\n${prompt}`,
      schema,
    );
    return {
      mode: "instant",
      nextPort: result.category,
      output: { category: result.category, confidence: result.confidence },
    };
  } catch (err) {
    const fallback = config.fallbackPort ?? categories[categories.length - 1] ?? "unknown";
    return {
      mode: "instant",
      nextPort: fallback,
      output: { category: fallback, confidence: 0, error: String(err) },
    };
  }
}
