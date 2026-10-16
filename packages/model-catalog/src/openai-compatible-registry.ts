/**
 * Derivations over the OpenAI-compatible provider registry
 * (`openai-compatible-providers.ts`). Every helper reads the table at call
 * time, so nothing here caches a provider list.
 */

import {
  OPENAI_COMPATIBLE_PROVIDERS,
  type OpenAICompatibleModel,
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

/** Every `<ID>_BASE_URL` var a provider honors (`baseUrlLocked` ones have none), in declaration order. */
export function openAICompatibleBaseUrlVars(): string[] {
  return openAICompatibleProviders()
    .filter((p) => !p.baseUrlLocked)
    .map(baseUrlEnvVar);
}

/**
 * The `<ID>_BASE_URL` value from `env` without trailing slashes, or `undefined`
 * when unset or the provider is `baseUrlLocked`.
 */
export function baseUrlOverride(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  if (provider.baseUrlLocked) return undefined;
  const value = env[baseUrlEnvVar(provider)]?.trim().replace(/\/+$/, "");
  return value || undefined;
}

/**
 * The `<ID>_BASE_URL` var name when `env` sets one for a `baseUrlLocked`
 * provider, which ignores it; adapters warn with it. `undefined` otherwise.
 */
export function ignoredBaseUrlVar(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  const name = baseUrlEnvVar(provider);
  return provider.baseUrlLocked && env[name]?.trim() ? name : undefined;
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

/** The models.dev row fields that decide whether and how a harness can run a model. */
export interface CatalogChatRow {
  id?: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  modalities?: { input?: readonly string[]; output?: readonly string[] };
  limit?: { context?: number; output?: number };
}

/**
 * Whether pi and opencode can run a catalog row as an agent: it calls tools
 * and answers in text. Embeddings, rerankers and image or video models fail.
 */
export function isAgentChatModel(row: CatalogChatRow): boolean {
  return row.tool_call === true && (row.modalities?.output ?? []).includes("text");
}

/** The agent chat models of a models.dev section, as registry model entries. */
export function catalogChatModels(
  section: Readonly<Record<string, CatalogChatRow>> | undefined,
): OpenAICompatibleModel[] {
  const models: OpenAICompatibleModel[] = [];
  for (const [key, row] of Object.entries(section ?? {})) {
    if (!isAgentChatModel(row)) continue;
    const id = row.id ?? key;
    const input = (row.modalities?.input ?? []).filter(
      (m): m is "text" | "image" => m === "text" || m === "image",
    );
    models.push({
      id,
      name: row.name ?? id,
      contextWindow: row.limit?.context ?? 128000,
      maxOutputTokens: row.limit?.output ?? 16384,
      input: input.length > 0 ? input : ["text"],
      reasoning: row.reasoning === true,
      // A gateway fronts many vendors; `system` is the role every one accepts.
      compat: { supportsDeveloperRole: false },
    });
  }
  return models;
}

/**
 * The models pi gets for `provider`: its `models`, plus every agent chat model
 * of `section` when it is `modelsFromCatalog`. A `models` entry wins on id.
 */
export function providerHarnessModels(
  provider: OpenAICompatibleProvider,
  section?: Readonly<Record<string, CatalogChatRow>>,
): OpenAICompatibleModel[] {
  if (!provider.modelsFromCatalog) return [...provider.models];
  const listed = new Set(provider.models.map((m) => m.id));
  return [...provider.models, ...catalogChatModels(section).filter((m) => !listed.has(m.id))];
}

/**
 * Drop the rows of registry-provider sections that pi and opencode cannot run
 * (`isAgentChatModel`), so pickers, validation and pricing only see agent
 * chat models. Other sections pass through. `cache` is not mutated.
 */
export function withAgentChatRegistrySections<T extends object>(cache: T): T {
  const out = { ...cache } as Record<string, unknown>;
  for (const provider of openAICompatibleProviders()) {
    const section = out[provider.id] as { models?: Record<string, CatalogChatRow> } | undefined;
    if (!section?.models) continue;
    out[provider.id] = {
      ...section,
      models: Object.fromEntries(
        Object.entries(section.models).filter(([, row]) => isAgentChatModel(row)),
      ),
    };
  }
  return out as T;
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
 * `cache` with the registry-synthesized sections added and the registry
 * providers' models.dev sections cut to agent chat models
 * (`withAgentChatRegistrySections`). A registry section replaces a same-id
 * section in `cache`; `cache` is not mutated.
 */
export function withRegistryCatalogSections<T extends object>(cache: T): T {
  return { ...withAgentChatRegistrySections(cache), ...registryCatalogSections() };
}
