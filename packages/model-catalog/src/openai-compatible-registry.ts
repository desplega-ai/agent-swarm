/**
 * Derivations over the OpenAI-compatible provider registry
 * (`openai-compatible-providers.ts`). Every helper reads the table at call
 * time, so nothing here caches a provider list.
 */

import {
  OPENAI_COMPATIBLE_PROVIDERS,
  type OpenAICompatibleProvider,
  type OpenAICompatibleProviderId,
} from "./openai-compatible-providers.ts";

function table(): Readonly<Record<string, OpenAICompatibleProvider>> {
  return OPENAI_COMPATIBLE_PROVIDERS;
}

/** Every registry entry, in declaration order. */
export function openAICompatibleProviders(): OpenAICompatibleProvider[] {
  return Object.values(table());
}

/** Every registry id, in declaration order. */
export function openAICompatibleProviderIds(): OpenAICompatibleProviderId[] {
  return Object.keys(table()) as OpenAICompatibleProviderId[];
}

/** The canonical key var followed by its aliases. */
export function providerKeyVars(provider: OpenAICompatibleProvider): string[] {
  return [provider.envVar, ...provider.aliasEnvVars];
}

/** Every env var (canonical and alias) that can carry a registry provider's key. */
export function openAICompatibleKeyVars(): string[] {
  return openAICompatibleProviders().flatMap(providerKeyVars);
}

/** `<ID>_BASE_URL`: the env var that overrides a provider's default base URL. */
export function baseUrlEnvVar(provider: OpenAICompatibleProvider): string {
  return `${provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`;
}

/** Every `<ID>_BASE_URL` var, in declaration order. */
export function openAICompatibleBaseUrlVars(): string[] {
  return openAICompatibleProviders().map(baseUrlEnvVar);
}

/** The `<ID>_BASE_URL` value from `env` without trailing slashes, or `undefined` when unset. */
export function baseUrlOverride(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  const value = env[baseUrlEnvVar(provider)]?.trim().replace(/\/+$/, "");
  return value || undefined;
}

/** The base URL a provider is reached at: the `<ID>_BASE_URL` override, else the default. */
export function providerBaseUrl(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string {
  return baseUrlOverride(provider, env) ?? provider.baseUrl;
}

/** Registry entry for an id, or `undefined` (never a prototype member). */
export function openAICompatibleProvider(id: string): OpenAICompatibleProvider | undefined {
  return Object.hasOwn(table(), id) ? table()[id] : undefined;
}

/**
 * Provider entry for a `<provider>/<model>` id by exact prefix, or `undefined`
 * (`nan/glm5.3` → nan; `openrouter/nan/x` and bare `glm5.3` → undefined).
 */
export function providerForModel(model: string | undefined): OpenAICompatibleProvider | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return openAICompatibleProvider(model.slice(0, slash));
}

/** Provider entry whose canonical or alias key var is `name`, or `undefined`. */
export function providerForKeyVar(name: string): OpenAICompatibleProvider | undefined {
  return openAICompatibleProviders().find((p) => providerKeyVars(p).includes(name));
}

/**
 * First non-empty key value for a provider from `env`, canonical var first,
 * then aliases. Returns `undefined` when none is set.
 */
export function providerKeyFromEnv(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const name of providerKeyVars(provider)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** A synthesized models.dev-shaped catalog section (`catalog: "registry"` entries). */
export interface RegistryCatalogSection {
  id: string;
  name: string;
  env: string[];
  npm: string;
  api: string;
  doc: string;
  models: Record<
    string,
    {
      id: string;
      name: string;
      family?: string;
      attachment: boolean;
      reasoning: boolean;
      reasoning_options?: { type: string; values: string[] }[];
      tool_call: boolean;
      modalities: { input: string[]; output: string[] };
      limit: { context: number; output: number };
      cost: { input: number; output: number };
    }
  >;
}

/**
 * Catalog sections for the registry entries models.dev does not list
 * (`catalog: "registry"`), synthesized from their model lists at $0 (flat-rate
 * subscriptions). Merge them over every models.dev payload or snapshot that
 * feeds a catalog (`withRegistryCatalogSections`).
 */
export function registryCatalogSections(): Record<string, RegistryCatalogSection> {
  const sections: Record<string, RegistryCatalogSection> = {};
  for (const provider of openAICompatibleProviders()) {
    if (provider.catalog !== "registry") continue;
    const models: RegistryCatalogSection["models"] = {};
    for (const m of provider.models) {
      models[m.id] = {
        id: m.id,
        name: m.name,
        ...(m.family ? { family: m.family } : {}),
        attachment: m.input.includes("image"),
        reasoning: m.reasoning,
        ...(m.reasoningEfforts
          ? { reasoning_options: [{ type: "effort", values: [...m.reasoningEfforts] }] }
          : {}),
        tool_call: true,
        modalities: { input: [...m.input], output: ["text"] },
        limit: { context: m.contextWindow, output: m.maxOutputTokens },
        cost: { input: 0, output: 0 },
      };
    }
    sections[provider.id] = {
      id: provider.id,
      name: provider.displayName,
      env: [provider.envVar],
      npm: provider.npm,
      api: provider.baseUrl,
      doc: provider.docsUrl,
      models,
    };
  }
  return sections;
}

/**
 * `cache` with the registry-synthesized sections added. A registry section
 * replaces a same-id section in `cache`; `cache` is not mutated.
 */
export function withRegistryCatalogSections<T extends object>(cache: T): T {
  return { ...cache, ...registryCatalogSections() };
}
