export type PiProviderFamily = "anthropic" | "openrouter" | "openai" | "ollama";

export interface PiResolvedConfig {
  providerFamily: PiProviderFamily;
  requiredEnvKeys: string[];
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

export function resolvePiProviderFamily(model: string): PiProviderFamily {
  const normalized = normalizeModel(model);

  if (normalized.startsWith("openrouter/")) return "openrouter";
  if (normalized.startsWith("openai/")) return "openai";
  if (normalized.startsWith("ollama/") || normalized.startsWith("local/")) return "ollama";

  if (
    normalized.includes("claude") ||
    normalized === "haiku" ||
    normalized === "sonnet" ||
    normalized === "opus"
  ) {
    return "anthropic";
  }

  // Default to Anthropic for legacy model aliases.
  return "anthropic";
}

export function getRequiredEnvKeysForPiProvider(providerFamily: PiProviderFamily): string[] {
  switch (providerFamily) {
    case "openrouter":
      return ["OPENROUTER_API_KEY"];
    case "openai":
      return ["OPENAI_API_KEY"];
    case "ollama":
      return [];
    default:
      return ["ANTHROPIC_API_KEY"];
  }
}

export function validatePiAuthForModel(
  model: string,
  env: Record<string, string | undefined>,
): PiResolvedConfig {
  const providerFamily = resolvePiProviderFamily(model);
  const requiredEnvKeys = getRequiredEnvKeysForPiProvider(providerFamily);
  const missing = requiredEnvKeys.filter((key) => !env[key]);

  if (missing.length > 0) {
    const hint =
      providerFamily === "openrouter"
        ? "Set OPENROUTER_API_KEY to use OpenRouter models in pi mode."
        : providerFamily === "openai"
          ? "Set OPENAI_API_KEY to use OpenAI-compatible models in pi mode."
          : providerFamily === "anthropic"
            ? "Set ANTHROPIC_API_KEY to use Anthropic models in pi mode."
            : "Set the required provider credentials for pi mode.";

    throw new Error(
      `HARNESS_PROVIDER=pi requires ${missing.join(", ")} for model "${model}" (${providerFamily}). ${hint}`,
    );
  }

  return {
    providerFamily,
    requiredEnvKeys,
  };
}

export function parsePiModelIdentifier(model: string): { providerId: string; modelId: string } {
  const normalized = model.trim();
  if (!normalized) {
    return { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" };
  }

  const parts = normalized.split("/");

  // openrouter/openai/gpt-oss-120b -> provider=openrouter model=openai/gpt-oss-120b
  if (parts.length >= 3 && parts[0]?.toLowerCase() === "openrouter") {
    return {
      providerId: "openrouter",
      modelId: parts.slice(1).join("/"),
    };
  }

  if (parts.length >= 2) {
    return {
      providerId: parts[0] || "anthropic",
      modelId: parts.slice(1).join("/"),
    };
  }

  const alias = normalized.toLowerCase();
  if (alias === "haiku") {
    return { providerId: "anthropic", modelId: "claude-3-5-haiku-latest" };
  }
  if (alias === "sonnet") {
    return { providerId: "anthropic", modelId: "claude-sonnet-4-20250514" };
  }
  if (alias === "opus") {
    return { providerId: "anthropic", modelId: "claude-opus-4-1-20250805" };
  }

  return { providerId: "anthropic", modelId: normalized };
}
