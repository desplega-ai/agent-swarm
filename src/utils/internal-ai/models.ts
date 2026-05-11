/**
 * Per-credential default model registry for the internal-ai abstraction.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 0 § "models.ts"
 *
 * Model defaults are per credential kind, NOT per harness — every credential
 * kind has exactly one default model. Override via `MEMORY_RATER_MODEL` env
 * (kept for backwards-compat with the claude hook).
 */

export type CredentialKind = "openrouter" | "anthropic" | "openai" | "openai-codex" | "claude-cli";

/**
 * Per-credential default model strings. The "claude-cli" kind uses the
 * shorthand "haiku" because the only consumer is the `claude -p --model haiku`
 * shellout, not pi-ai's `getModel`.
 */
export const DEFAULT_MODEL: Record<CredentialKind, string> = {
  openrouter: "openrouter/google/gemini-3-flash-preview",
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-5.4-mini",
  "openai-codex": "openai-codex/gpt-5.4-mini",
  "claude-cli": "haiku",
};

/**
 * Resolve the effective model string for a credential kind. Honours the
 * `MEMORY_RATER_MODEL` env var so existing claude-hook users keep their
 * override (it pre-dates the per-kind registry).
 */
export function resolveModelString(kind: CredentialKind): string {
  return process.env.MEMORY_RATER_MODEL ?? DEFAULT_MODEL[kind];
}

/**
 * Split a `provider/model-id` string on the FIRST `/` so that OpenRouter
 * compound IDs like `openrouter/google/gemini-3-flash-preview` parse as
 * `("openrouter", "google/gemini-3-flash-preview")`. Mirrors the existing
 * convention in `src/providers/pi-mono-adapter.ts:161-170`.
 */
export function parseModelStr(modelStr: string): [provider: string, modelId: string] {
  const idx = modelStr.indexOf("/");
  if (idx < 0) throw new Error(`invalid model string (no '/'): ${modelStr}`);
  return [modelStr.slice(0, idx), modelStr.slice(idx + 1)];
}
