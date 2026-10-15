/**
 * The registry of OpenAI-compatible LLM providers that pi and opencode reach
 * with one API key and a base URL (`nan/*`, `helmcode/*`, `vercel/*`).
 *
 * This table is the only place a provider is declared. The API server, the
 * worker and the dashboard all derive from it through the helpers in
 * `openai-compatible-registry.ts`: credential routing and pools, the runner's
 * alias normalization, env forwarding (E2B, ACP), secret scrubbing, the live
 * key probe, the pi models.json block, the opencode provider block, $0 pricing
 * rows, the model catalog section, integration cards, picker groups and label
 * maps. Adding a provider takes one entry here plus its glyph in the
 * dashboard's `provider-icon.tsx`.
 *
 * Data only: helpers live in `openai-compatible-registry.ts` and read this
 * table at call time.
 */

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
  /** Catalog family (`glm`, `qwen`). Read only when `catalog` is `"registry"`. */
  family?: string;
  /** `reasoning_options` effort levels. Read only when `catalog` is `"registry"`. */
  reasoningEfforts?: readonly string[];
}

export interface OpenAICompatibleProvider {
  /** Model prefix (`<id>/<model>`), catalog section id and provider block id. */
  id: string;
  displayName: string;
  /** One sentence for the dashboard integration card. */
  description: string;
  /** Default OpenAI-compatible API root; `/models` and `/chat/completions` hang off it. `<ID>_BASE_URL` overrides it unless `baseUrlLocked`. */
  baseUrl: string;
  /**
   * The provider has exactly one endpoint, so `baseUrl` is the only URL it is
   * ever reached at: no `<ID>_BASE_URL` override is read, forwarded or offered
   * in the dashboard, and pi gets `baseUrl` even over a hand-written block.
   */
  baseUrlLocked?: boolean;
  /** Vendor docs, shown as the catalog section's `doc`. */
  docsUrl: string;
  /** The env var the harnesses and the credential pool read. */
  envVar: string;
  /**
   * Other env var names an operator may have used for the same key. The
   * runner copies the first set alias into `envVar` when `envVar` is empty,
   * so per-task code only ever sees the canonical name.
   */
  aliasEnvVars: readonly string[];
  /** Extra sentence for the key field on the integration card. */
  keyNote?: string;
  /**
   * Where the model catalog section comes from.
   * - `"models.dev"`: models.dev lists the provider, so the snapshot carries
   *   its section and opencode ships it built in (the picked key is spliced
   *   into opencode's own provider).
   * - `"registry"`: models.dev does not list it. The section is synthesized
   *   from `models` (`registryCatalogSections`), and opencode gets a full
   *   custom provider block.
   */
  catalog: "models.dev" | "registry";
  /** AI SDK package opencode loads for the provider (`@ai-sdk/gateway` is OpenCode's built-in Vercel provider). */
  npm: "@ai-sdk/openai-compatible" | "@ai-sdk/gateway";
  /** Tool-calling chat models pi and opencode get in their config blocks. */
  models: readonly OpenAICompatibleModel[];
  /**
   * pi also gets every tool-calling chat model of the provider's models.dev
   * section (`catalogChatModels`), so a gateway with hundreds of models needs
   * no hand-kept list. Requires `catalog: "models.dev"`.
   */
  modelsFromCatalog?: boolean;
}

const DEVELOPER_ROLE = { supportsDeveloperRole: true } as const;
const TEXT_IMAGE = ["text", "image"] as const;
const TEXT_ONLY = ["text"] as const;
const EFFORTS = ["low", "medium", "high", "max"] as const;
const EFFORTS_WITH_NONE = ["none", "low", "medium", "high", "max"] as const;

export const OPENAI_COMPATIBLE_PROVIDERS = {
  nan: {
    id: "nan",
    displayName: "NaN",
    description:
      "Open-weight models such as GLM, Qwen and DeepSeek for the pi and opencode harnesses.",
    baseUrl: "https://api.nan.builders/v1",
    docsUrl: "https://nan.builders/docs/models",
    envVar: "NAN_API_KEY",
    aliasEnvVars: ["HELMCODE_API_NAN"],
    catalog: "models.dev",
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
    description: "Open-weight models through Helmcode for the pi and opencode harnesses.",
    baseUrl: "https://api.helmcode.com/v1",
    docsUrl: "https://helmcode.com/docs",
    envVar: "HELMCODE_API_KEY",
    aliasEnvVars: [],
    keyNote: "Helmcode org plans include 5, 15 or 40 keys.",
    catalog: "registry",
    npm: "@ai-sdk/openai-compatible",
    // Helmcode's own agent models, copied from its opencode/pi config blocks
    // (helmcode.com/docs), 2026-10-15. The resold frontier models (Claude,
    // GPT, Gemini on prepaid credit) are out of scope.
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
        family: "deepseek-flash",
        reasoningEfforts: EFFORTS_WITH_NONE,
      },
      {
        id: "glm5.3",
        name: "GLM-5.3",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
        family: "glm",
        reasoningEfforts: EFFORTS,
      },
      {
        id: "glm5.3-flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
        family: "glm-flash",
        reasoningEfforts: EFFORTS,
      },
      {
        id: "qwen3.6",
        name: "Qwen3.6",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
        family: "qwen",
        reasoningEfforts: EFFORTS_WITH_NONE,
      },
      {
        id: "gemma4",
        name: "Gemma 4",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        input: TEXT_IMAGE,
        reasoning: true,
        compat: DEVELOPER_ROLE,
        family: "gemma",
        reasoningEfforts: EFFORTS_WITH_NONE,
      },
    ],
  },
  vercel: {
    id: "vercel",
    displayName: "Vercel AI Gateway",
    description:
      "Every AI Gateway chat model (GLM, Kimi, Claude, GPT, Gemini and more), including Token Pass.",
    // OpenAI Chat Completions endpoint:
    // vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    baseUrlLocked: true,
    docsUrl: "https://vercel.com/docs/ai-gateway/token-pass",
    envVar: "AI_GATEWAY_API_KEY",
    aliasEnvVars: [],
    keyNote: "Use a Token Pass API key for Token Pass credit; regular keys use AI Gateway credit.",
    catalog: "models.dev",
    // OpenCode ships Vercel built in (models.dev `vercel`, AI Gateway SDK);
    // pi reaches the OpenAI Chat Completions endpoint above.
    npm: "@ai-sdk/gateway",
    models: [],
    modelsFromCatalog: true,
  },
} satisfies Record<string, OpenAICompatibleProvider>;

/** Registry ids (`"nan" | "helmcode" | "vercel"`); a new entry extends this union. */
export type OpenAICompatibleProviderId = keyof typeof OPENAI_COMPATIBLE_PROVIDERS;
