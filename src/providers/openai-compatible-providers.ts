/**
 * Worker-side table of the OpenAI-compatible LLM providers that pi and
 * opencode reach through a custom provider block (`nan`, `helmcode`).
 *
 * Worker code may not import `src/be/*`, so it cannot read the catalog store.
 * This table is the single worker-side source for base URLs, key env vars and
 * model limits: the pi models.json writer, the opencode provider block, and
 * the live credential probe all read it. The model limits mirror the vendors'
 * own opencode/pi config blocks and the `nan` / `helmcode` sections of
 * `src/be/modelsdev-cache.json`; a drift test keeps the two in sync.
 *
 * Keep this module free of `src/be` imports and runtime dependencies.
 */

export type OpenAICompatibleProviderId = "nan" | "helmcode";

export interface OpenAICompatibleModel {
  /** Model id without the provider prefix (`glm5.3-flash`, not `nan/glm5.3-flash`). */
  id: string;
  /** Human-readable name for config blocks and pickers. */
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  compat: { supportsDeveloperRole: boolean };
}

export interface OpenAICompatibleProvider {
  id: OpenAICompatibleProviderId;
  displayName: string;
  /** OpenAI-compatible API root; `/models` and `/chat/completions` hang off it. */
  baseUrl: string;
  /** The env var the harnesses and the credential pool read. */
  envVar: string;
  /**
   * Other env var names an operator may have used for the same key. The
   * runner copies the first alias into `envVar` when `envVar` is empty, so
   * downstream code only ever sees the canonical name.
   */
  aliasEnvVars: readonly string[];
  /** AI SDK package opencode loads for a custom provider block. */
  npm: "@ai-sdk/openai-compatible";
  models: readonly OpenAICompatibleModel[];
}

const DEVELOPER_ROLE = { supportsDeveloperRole: true } as const;
const TEXT_IMAGE = ["text", "image"] as const;
const TEXT_ONLY = ["text"] as const;

export const OPENAI_COMPATIBLE_PROVIDERS: Readonly<
  Record<OpenAICompatibleProviderId, OpenAICompatibleProvider>
> = {
  nan: {
    id: "nan",
    displayName: "NaN",
    baseUrl: "https://api.nan.builders/v1",
    envVar: "NAN_API_KEY",
    aliasEnvVars: ["HELMCODE_API_NAN"],
    npm: "@ai-sdk/openai-compatible",
    // Tool-calling chat models listed upstream on models.dev. Excludes the
    // image model `qwen-image-2.1` (no tool calls) and delisted ids that the
    // snapshot only carries forward for history (`glm5.2`, `mimo-v2.5`).
    // mimo-v2.6-flash also accepts audio; pi/opencode only take text+image.
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4.1 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "glm5.3",
        name: "GLM-5.3",
        contextWindow: 1000000,
        maxOutputTokens: 131072,
        input: TEXT_ONLY,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "glm5.3-flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1000000,
        maxOutputTokens: 131072,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "qwen3.6",
        name: "Qwen3.6 35B-A3B",
        contextWindow: 262144,
        maxOutputTokens: 65536,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "qwen3.8-flash",
        name: "Qwen3.8 Flash",
        contextWindow: 262144,
        maxOutputTokens: 131072,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "gemma4",
        name: "Gemma 4 26B A4B IT",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "mimo-v2.6-flash",
        name: "MiMo-V2.6-Flash",
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
    ],
  },
  helmcode: {
    id: "helmcode",
    displayName: "Helmcode",
    baseUrl: "https://api.helmcode.com/v1",
    envVar: "HELMCODE_API_KEY",
    aliasEnvVars: [],
    npm: "@ai-sdk/openai-compatible",
    // Helmcode's own agent models (its opencode/pi config blocks). The resold
    // frontier models (Claude, GPT, Gemini on prepaid credit) are out of scope.
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "glm5.3",
        name: "GLM-5.3",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "glm5.3-flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "qwen3.6",
        name: "Qwen3.6",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
      {
        id: "gemma4",
        name: "Gemma 4",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
      },
    ],
  },
};

export const OPENAI_COMPATIBLE_PROVIDER_IDS = Object.keys(
  OPENAI_COMPATIBLE_PROVIDERS,
) as OpenAICompatibleProviderId[];

/** Every env var (canonical and alias) that can carry a key for these providers. */
export const OPENAI_COMPATIBLE_KEY_VARS: readonly string[] = OPENAI_COMPATIBLE_PROVIDER_IDS.flatMap(
  (id) => [OPENAI_COMPATIBLE_PROVIDERS[id].envVar, ...OPENAI_COMPATIBLE_PROVIDERS[id].aliasEnvVars],
);

/**
 * Provider entry for a `<provider>/<model>` id by exact prefix, or `undefined`
 * (`nan/glm5.3` → nan; `openrouter/nan/x` and bare `glm5.3` → undefined).
 */
export function providerForModel(model: string | undefined): OpenAICompatibleProvider | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const prefix = model.slice(0, slash);
  return Object.hasOwn(OPENAI_COMPATIBLE_PROVIDERS, prefix)
    ? OPENAI_COMPATIBLE_PROVIDERS[prefix as OpenAICompatibleProviderId]
    : undefined;
}

/** Model entry for a `<provider>/<model>` id, or `undefined` when either part is unknown. */
export function modelForId(model: string | undefined): OpenAICompatibleModel | undefined {
  const provider = providerForModel(model);
  if (!provider || !model) return undefined;
  const id = model.slice(provider.id.length + 1);
  return provider.models.find((m) => m.id === id);
}

/**
 * First non-empty key value for a provider from `env`, canonical var first,
 * then aliases. Returns `undefined` when none is set.
 */
export function providerKeyFromEnv(
  provider: OpenAICompatibleProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const name of [provider.envVar, ...provider.aliasEnvVars]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
