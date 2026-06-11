import type { HarnessConfig } from "../src/types.ts";

/**
 * The harness-config axis of the eval matrix. Models are deliberately cheap:
 * evals measure orchestration capability across harnesses, not peak model
 * quality. (pi/opencode cross-provider runs use deepseek-v4-flash per the
 * standing repo convention.)
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
    label: "Claude Code / fable (latest)",
    provider: "claude",
    model: "fable",
  },
  {
    id: "pi-deepseek-flash",
    label: "pi-mono / DeepSeek v4 flash (OpenRouter)",
    provider: "pi",
    model: "openrouter/deepseek/deepseek-v4-flash",
  },
  {
    id: "opencode-gemini-flash",
    label: "opencode / Gemini 3 flash (OpenRouter)",
    provider: "opencode",
    model: "openrouter/google/gemini-3-flash-preview",
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
