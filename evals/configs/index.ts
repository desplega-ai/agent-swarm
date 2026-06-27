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
  // Round-9 expansion (AA snapshot 2026-06-12): proprietary-API models are now
  // welcome — this lifts the round-8 open-weights-only filter and brings in the
  // previously-skipped MiniMax-M3 and Qwen3.7 Max/Plus (open_weights: false).
  // Every slug verified against src/be/modelsdev-cache.json openrouter section
  // with tool_call: true.
  {
    id: "pi-minimax-m3",
    label: "pi-mono / MiniMax M3 (OpenRouter)",
    provider: "pi",
    model: "openrouter/minimax/minimax-m3",
  },
  {
    id: "pi-qwen3.7-max",
    label: "pi-mono / Qwen3.7 Max (OpenRouter)",
    provider: "pi",
    model: "openrouter/qwen/qwen3.7-max",
  },
  {
    id: "pi-qwen3.7-plus",
    label: "pi-mono / Qwen3.7 Plus (OpenRouter)",
    provider: "pi",
    model: "openrouter/qwen/qwen3.7-plus",
  },
  {
    id: "pi-grok-4.3",
    label: "pi-mono / Grok 4.3 (OpenRouter)",
    provider: "pi",
    model: "openrouter/x-ai/grok-4.3",
  },
  {
    // The cache slug really is mistral-medium-3-5 (dashes) while the display
    // name is "Mistral Medium 3.5" — don't "fix" the slug to dots.
    id: "pi-mistral-medium-3.5",
    label: "pi-mono / Mistral Medium 3.5 (OpenRouter)",
    provider: "pi",
    model: "openrouter/mistralai/mistral-medium-3-5",
  },
  {
    id: "pi-hy3-preview",
    label: "pi-mono / Tencent Hy3 preview (OpenRouter)",
    provider: "pi",
    model: "openrouter/tencent/hy3-preview",
  },
  {
    // Speed pick: 381 tok/s median in the AA snapshot.
    id: "pi-step-3.7-flash",
    label: "pi-mono / Step 3.7 Flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/stepfun/step-3.7-flash",
  },
  {
    // Speed pick: Inception's diffusion LM, 745 tok/s median in the AA snapshot.
    id: "pi-mercury-2",
    label: "pi-mono / Mercury 2 (OpenRouter)",
    provider: "pi",
    model: "openrouter/inception/mercury-2",
  },
  {
    // Twin completion: opencode-gemini-flash-lite predates the pi/opencode
    // twin convention — same model, pi side.
    id: "pi-gemini-flash-lite",
    label: "pi-mono / Gemini 3.1 flash lite (OpenRouter)",
    provider: "pi",
    model: "openrouter/google/gemini-3.1-flash-lite",
  },
  // Round-10 leaderboard additions (Hermes Agent + OpenClaw agent-usage
  // top-20s, 2026-06): models with heavy real-world agent usage missing from
  // the catalog. Every slug verified against src/be/modelsdev-cache.json
  // openrouter section with tool_call: true; ":free" variants skipped.
  // Skipped from the same leaderboard cut as superseded by catalog entries:
  // Step 3.5 Flash (step-3.7-flash), Gemini 2.5 Flash / Flash Lite
  // (gemini-3-flash-preview / gemini-3.1-flash-lite), GLM 4.5 Air
  // (glm-4.7-flash / glm-5.1), MiniMax M2.5 (already present).
  {
    // xAI's coding/build-focused line — distinct model from Grok 4.3.
    id: "pi-grok-build-0.1",
    label: "pi-mono / Grok Build 0.1 (OpenRouter)",
    provider: "pi",
    model: "openrouter/x-ai/grok-build-0.1",
  },
  {
    // OpenRouter's own stealth/alpha model (#1 on Hermes Agent by tokens) —
    // the vendor segment really is "openrouter", hence the doubled prefix.
    id: "pi-owl-alpha",
    label: "pi-mono / Owl Alpha (OpenRouter)",
    provider: "pi",
    model: "openrouter/openrouter/owl-alpha",
  },
  {
    id: "pi-gemini-3.5-flash",
    label: "pi-mono / Gemini 3.5 Flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/google/gemini-3.5-flash",
  },
  {
    // Paid slug, not the ":free" twin — free-tier rate limits would starve runs.
    id: "pi-nemotron-3-super",
    label: "pi-mono / Nemotron 3 Super (OpenRouter)",
    provider: "pi",
    model: "openrouter/nvidia/nemotron-3-super-120b-a12b",
  },
  {
    // Previously skipped as superseded by M3, but top-8 by usage on both
    // leaderboards — usage earns it a slot alongside M2.5/M3.
    id: "pi-minimax-m2.7",
    label: "pi-mono / MiniMax M2.7 (OpenRouter)",
    provider: "pi",
    model: "openrouter/minimax/minimax-m2.7",
  },
  {
    // Previously skipped for the 3.7 line, but carries 189B tokens/month of
    // agent usage — kept alongside qwen3.7-plus.
    id: "pi-qwen3.6-plus",
    label: "pi-mono / Qwen3.6 Plus (OpenRouter)",
    provider: "pi",
    model: "openrouter/qwen/qwen3.6-plus",
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
  // Round-9 expansion — opencode twins of the pi- entries above
  // (pi-gemini-flash-lite has no twin here: opencode-gemini-flash-lite exists).
  {
    id: "opencode-minimax-m3",
    label: "opencode / MiniMax M3 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/minimax/minimax-m3",
  },
  {
    id: "opencode-qwen3.7-max",
    label: "opencode / Qwen3.7 Max (OpenRouter)",
    provider: "opencode",
    model: "openrouter/qwen/qwen3.7-max",
  },
  {
    id: "opencode-qwen3.7-plus",
    label: "opencode / Qwen3.7 Plus (OpenRouter)",
    provider: "opencode",
    model: "openrouter/qwen/qwen3.7-plus",
  },
  {
    id: "opencode-grok-4.3",
    label: "opencode / Grok 4.3 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/x-ai/grok-4.3",
  },
  {
    // Dashed slug — see the pi- twin's note.
    id: "opencode-mistral-medium-3.5",
    label: "opencode / Mistral Medium 3.5 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/mistralai/mistral-medium-3-5",
  },
  {
    id: "opencode-hy3-preview",
    label: "opencode / Tencent Hy3 preview (OpenRouter)",
    provider: "opencode",
    model: "openrouter/tencent/hy3-preview",
  },
  {
    id: "opencode-step-3.7-flash",
    label: "opencode / Step 3.7 Flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/stepfun/step-3.7-flash",
  },
  {
    id: "opencode-mercury-2",
    label: "opencode / Mercury 2 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/inception/mercury-2",
  },
  // Round-10 leaderboard additions — opencode twins of the pi- entries above.
  {
    id: "opencode-grok-build-0.1",
    label: "opencode / Grok Build 0.1 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/x-ai/grok-build-0.1",
  },
  {
    // Doubled prefix is correct — see the pi- twin's note.
    id: "opencode-owl-alpha",
    label: "opencode / Owl Alpha (OpenRouter)",
    provider: "opencode",
    model: "openrouter/openrouter/owl-alpha",
  },
  {
    id: "opencode-gemini-3.5-flash",
    label: "opencode / Gemini 3.5 Flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/google/gemini-3.5-flash",
  },
  {
    // Paid slug, not the ":free" twin — free-tier rate limits would starve runs.
    id: "opencode-nemotron-3-super",
    label: "opencode / Nemotron 3 Super (OpenRouter)",
    provider: "opencode",
    model: "openrouter/nvidia/nemotron-3-super-120b-a12b",
  },
  {
    id: "opencode-minimax-m2.7",
    label: "opencode / MiniMax M2.7 (OpenRouter)",
    provider: "opencode",
    model: "openrouter/minimax/minimax-m2.7",
  },
  {
    id: "opencode-qwen3.6-plus",
    label: "opencode / Qwen3.6 Plus (OpenRouter)",
    provider: "opencode",
    model: "openrouter/qwen/qwen3.6-plus",
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
