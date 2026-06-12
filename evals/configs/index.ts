import type { HarnessConfig } from "../src/types.ts";

/**
 * The harness-config axis of the eval matrix. Models are deliberately cheap:
 * evals measure orchestration capability across harnesses, not peak model
 * quality. (pi/opencode cross-provider runs use deepseek-v4-flash per the
 * standing repo convention.)
 *
 * Catalog contract (v6 §0.14, frozen):
 * - ids match /^(claude|pi|opencode|codex)-[a-z0-9][a-z0-9.-]*$/ — `<short>`
 *   drops the vendor path (deepseek-pro, not deepseek-deepseek-v4-pro).
 * - NO `env` blocks: provider creds are injected at boot exclusively by
 *   `credentialsForConfig` (src/swarm/sandbox.ts) — openrouter/-prefixed
 *   models get OPENROUTER_API_KEY only; never put a secret value here.
 * - `modelTier` stays unset: tier-resolved configs would grade a moving target.
 * - DEFAULT_CONFIG_IDS stays the curated trio regardless of catalog size.
 */
export const configs: HarnessConfig[] = [
  {
    id: "claude-haiku",
    label: "Claude Code / haiku",
    provider: "claude",
    model: "haiku",
  },
  {
    id: "claude-sonnet",
    label: "Claude Code / sonnet",
    provider: "claude",
    model: "sonnet",
  },
  {
    id: "claude-opus",
    label: "Claude Code / opus (latest)",
    provider: "claude",
    model: "opus",
  },
  {
    id: "claude-opus-4.6",
    label: "Claude Code / opus 4.6",
    provider: "claude",
    model: "claude-opus-4-6",
  },
  {
    id: "claude-opus-4.7",
    label: "Claude Code / opus 4.7",
    provider: "claude",
    model: "claude-opus-4-7",
  },
  {
    id: "claude-opus-4.8",
    label: "Claude Code / opus 4.8",
    provider: "claude",
    model: "claude-opus-4-8",
  },
  {
    id: "claude-fable",
    label: "Claude Code / fable 5",
    provider: "claude",
    // Pinned concrete id (round-7 item 4) — bare "fable" would grade a moving
    // target. Historical rows with model "fable" resolve at read time (v7 §8).
    model: "claude-fable-5",
  },
  {
    id: "pi-deepseek-flash",
    label: "pi-mono / DeepSeek v4 flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/deepseek/deepseek-v4-flash",
  },
  {
    id: "pi-deepseek-pro",
    label: "pi-mono / DeepSeek v4 pro (OpenRouter)",
    provider: "pi",
    model: "openrouter/deepseek/deepseek-v4-pro",
  },
  {
    id: "pi-gemini-flash",
    label: "pi-mono / Gemini 3 flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/google/gemini-3-flash-preview",
  },
  {
    // v7.7 item 1: frontier-preset member. The preview slug IS the OpenRouter
    // id (modelsdev openrouter section: "Gemini 3.1 Pro Preview", priced) —
    // the bare gemini-3.1-pro id is a different, non-OpenRouter entry.
    id: "pi-gemini-pro",
    label: "pi-mono / Gemini 3.1 Pro Preview (OpenRouter)",
    provider: "pi",
    model: "openrouter/google/gemini-3.1-pro-preview",
  },
  {
    id: "pi-glm-flash",
    label: "pi-mono / GLM 4.7 flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/z-ai/glm-4.7-flash",
  },
  {
    id: "pi-qwen-coder",
    label: "pi-mono / Qwen3 Coder next (OpenRouter)",
    provider: "pi",
    model: "openrouter/qwen/qwen3-coder-next",
  },
  {
    id: "pi-minimax-m2.5",
    label: "pi-mono / MiniMax M2.5 (OpenRouter)",
    provider: "pi",
    model: "openrouter/minimax/minimax-m2.5",
  },
  {
    id: "pi-kimi-k2.5",
    label: "pi-mono / Kimi K2.5 (OpenRouter)",
    provider: "pi",
    model: "openrouter/moonshotai/kimi-k2.5",
  },
  {
    id: "pi-gpt-oss-120b",
    label: "pi-mono / GPT-OSS 120B (OpenRouter)",
    provider: "pi",
    model: "openrouter/openai/gpt-oss-120b",
  },
  // Round-8 OSS refresh (AA snapshot 2026-06-12). Every slug verified against
  // src/be/modelsdev-cache.json openrouter section with open_weights: true.
  // Skipped from the same AA cut: MiniMax-M3, Qwen3.7 Max/Plus (slugs exist
  // but open_weights: false — API-only, not OSS).
  {
    id: "pi-kimi-k2.6",
    label: "pi-mono / Kimi K2.6 (OpenRouter)",
    provider: "pi",
    model: "openrouter/moonshotai/kimi-k2.6",
  },
  {
    id: "pi-glm-5.1",
    label: "pi-mono / GLM 5.1 (OpenRouter)",
    provider: "pi",
    model: "openrouter/z-ai/glm-5.1",
  },
  {
    id: "pi-mimo-v2.5-pro",
    label: "pi-mono / MiMo V2.5 Pro (OpenRouter)",
    provider: "pi",
    model: "openrouter/xiaomi/mimo-v2.5-pro",
  },
  {
    id: "pi-mimo-v2.5",
    label: "pi-mono / MiMo V2.5 (OpenRouter)",
    provider: "pi",
    model: "openrouter/xiaomi/mimo-v2.5",
  },
  {
    // Paid slug, not the ":free" twin — free-tier rate limits would starve runs.
    id: "pi-nemotron-3-ultra",
    label: "pi-mono / Nemotron 3 Ultra (OpenRouter)",
    provider: "pi",
    model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b",
  },
  {
    id: "opencode-gemini-flash",
    label: "opencode / Gemini 3 flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/google/gemini-3-flash-preview",
  },
  {
    id: "opencode-deepseek-flash",
    label: "opencode / DeepSeek v4 flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/deepseek/deepseek-v4-flash",
  },
  {
    id: "opencode-deepseek-pro",
    label: "opencode / DeepSeek v4 pro (OpenRouter)",
    provider: "opencode",
    model: "openrouter/deepseek/deepseek-v4-pro",
  },
  {
    id: "opencode-glm-flash",
    label: "opencode / GLM 4.7 flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/z-ai/glm-4.7-flash",
  },
  {
    id: "opencode-qwen-coder",
    label: "opencode / Qwen3 Coder next (OpenRouter)",
    provider: "opencode",
    model: "openrouter/qwen/qwen3-coder-next",
  },
  {
    id: "opencode-minimax-m2.5",
    label: "opencode / MiniMax M2.5 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/minimax/minimax-m2.5",
  },
  {
    id: "opencode-kimi-k2.5",
    label: "opencode / Kimi K2.5 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/moonshotai/kimi-k2.5",
  },
  {
    id: "opencode-gemini-flash-lite",
    label: "opencode / Gemini 3.1 flash lite (OpenRouter)",
    provider: "opencode",
    model: "openrouter/google/gemini-3.1-flash-lite",
  },
  // Round-8 OSS refresh — opencode twins of the pi- entries above.
  {
    id: "opencode-kimi-k2.6",
    label: "opencode / Kimi K2.6 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/moonshotai/kimi-k2.6",
  },
  {
    id: "opencode-glm-5.1",
    label: "opencode / GLM 5.1 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/z-ai/glm-5.1",
  },
  {
    id: "opencode-mimo-v2.5-pro",
    label: "opencode / MiMo V2.5 Pro (OpenRouter)",
    provider: "opencode",
    model: "openrouter/xiaomi/mimo-v2.5-pro",
  },
  {
    id: "opencode-mimo-v2.5",
    label: "opencode / MiMo V2.5 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/xiaomi/mimo-v2.5",
  },
  {
    // Paid slug, not the ":free" twin — free-tier rate limits would starve runs.
    id: "opencode-nemotron-3-ultra",
    label: "opencode / Nemotron 3 Ultra (OpenRouter)",
    provider: "opencode",
    model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b",
  },
  {
    id: "codex-5.4-mini",
    label: "Codex / gpt-5.4-mini",
    provider: "codex",
    model: "gpt-5.4-mini",
  },
  {
    id: "codex-5.4",
    label: "Codex / gpt-5.4",
    provider: "codex",
    model: "gpt-5.4",
  },
  {
    id: "codex-5.5",
    label: "Codex / gpt-5.5",
    provider: "codex",
    model: "gpt-5.5",
  },
];

export const DEFAULT_CONFIG_IDS = ["claude-haiku", "pi-deepseek-flash", "opencode-gemini-flash"];
