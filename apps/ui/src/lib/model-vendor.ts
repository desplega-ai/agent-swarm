import { humanizeModelId, type LiveModelsCatalog } from "./agent-runtime-models";
import { getAgentModelPresentation } from "./agents-list-model-display";

/**
 * Who makes a model, read from its id, so a model shows its maker's mark
 * (Anthropic, OpenAI, DeepSeek, Z.ai, ...) and not the route it runs through
 * (OpenRouter). The logos live in `public/provider-logos/`.
 */
export type ModelVendor = "anthropic" | "openai" | "deepseek" | "zai" | "google" | "xai";

export const MODEL_VENDOR_LOGO: Record<ModelVendor, string> = {
  anthropic: "/provider-logos/anthropic.svg",
  openai: "/provider-logos/openai.svg",
  deepseek: "/provider-logos/deepseek.svg",
  zai: "/provider-logos/zai.svg",
  google: "/provider-logos/google.svg",
  xai: "/provider-logos/xai.svg",
};

const VENDOR_PATTERNS: ReadonlyArray<[RegExp, ModelVendor]> = [
  [/^(anthropic\/|claude|opus|sonnet|haiku|fable)/, "anthropic"],
  [/^(openai\/|gpt-|o\d|text-embedding-)/, "openai"],
  [/^(deepseek\/|deepseek-)/, "deepseek"],
  [/^(z-ai\/|glm-)/, "zai"],
  [/^(google\/|gemini)/, "google"],
  [/^(x-ai\/|grok)/, "xai"],
];

export function modelVendor(model: string | null | undefined): ModelVendor | null {
  // A router prefix says how the model is reached, not who makes it.
  const id = (model ?? "")
    .trim()
    .toLowerCase()
    .replace(/^openrouter\//, "");
  if (!id) return null;
  return VENDOR_PATTERNS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

/** Brand casing the id humanizer cannot know. */
const BRAND_CASE: ReadonlyArray<[RegExp, string]> = [
  [/\bDeepseek\b/g, "DeepSeek"],
  [/\bGlm\b/g, "GLM"],
  [/\bGpt\b/g, "GPT"],
];

/** "claude-opus-5-5" reads "Claude Opus 5.5": the catalog name, else a humanized id. */
export function modelDisplayName(model: string, liveCatalog?: LiveModelsCatalog): string {
  let label = getAgentModelPresentation(model, liveCatalog)?.label ?? model;
  // Some catalog names are the bare id ("text-embedding-3-small").
  if (/^[a-z0-9.-]+$/.test(label) && label.includes("-")) label = humanizeModelId(label);
  return BRAND_CASE.reduce((text, [pattern, fixed]) => text.replace(pattern, fixed), label);
}
