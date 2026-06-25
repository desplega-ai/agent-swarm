/**
 * OpenAI models used by the Vercel AI SDK ToolLoopAgent harness.
 *
 * Kept separate from the adapter so selectors and tests can import model,
 * context-window, and pricing metadata without loading the AI SDK runtime.
 */

export const AI_SDK_AGENT_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const;

export type AiSdkAgentModel = (typeof AI_SDK_AGENT_MODELS)[number];

export const AI_SDK_AGENT_DEFAULT_MODEL: AiSdkAgentModel = "gpt-5.4";

const CLAUDE_SHORTNAMES: Record<string, AiSdkAgentModel> = {
  fable: "gpt-5.5",
  opus: "gpt-5.4",
  sonnet: "gpt-5.4",
  haiku: "gpt-5.4-mini",
};

export function resolveAiSdkAgentModel(modelStr: string | undefined): string {
  if (!modelStr) return AI_SDK_AGENT_DEFAULT_MODEL;
  const normalized = modelStr.toLowerCase();
  return CLAUDE_SHORTNAMES[normalized] ?? normalized.replace(/^openai\//, "");
}

export const AI_SDK_AGENT_MODEL_CONTEXT_WINDOWS: Record<AiSdkAgentModel, number> = {
  "gpt-5.5": 1_050_000,
  "gpt-5.4": 200_000,
  "gpt-5.4-mini": 200_000,
  "gpt-5.3-codex": 1_000_000,
  "gpt-5.2-codex": 200_000,
};

export function getAiSdkAgentContextWindow(model: string): number {
  return AI_SDK_AGENT_MODEL_CONTEXT_WINDOWS[model as AiSdkAgentModel] ?? 200_000;
}

export interface AiSdkAgentModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

export const AI_SDK_AGENT_MODEL_PRICING: Record<AiSdkAgentModel, AiSdkAgentModelPricing> = {
  "gpt-5.5": {
    inputPerMillion: 5.0,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30.0,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15.0,
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  },
  "gpt-5.3-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
  "gpt-5.2-codex": {
    inputPerMillion: 1.75,
    cachedInputPerMillion: 0.175,
    outputPerMillion: 14.0,
  },
};

const warnedUnknownAiSdkAgentModels = new Set<string>();

export function computeAiSdkAgentCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const pricing = AI_SDK_AGENT_MODEL_PRICING[model as AiSdkAgentModel];
  if (!pricing) {
    if (!warnedUnknownAiSdkAgentModels.has(model)) {
      warnedUnknownAiSdkAgentModels.add(model);
      console.warn(
        `[ai-sdk-agent] unpriced model ${JSON.stringify(model)} - adapter cost will report $0; ` +
          "server-side recompute will tag costSource='unpriced' if the pricing table has no rows.",
      );
    }
    return 0;
  }
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInput / 1_000_000) * pricing.inputPerMillion +
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
