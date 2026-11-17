/**
 * Per-credential model registries for the internal-ai abstraction.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 0 § "models.ts"
 *
 * Model defaults are per credential kind, NOT per harness — every credential
 * kind has exactly one default model. Two registries live here and must stay
 * independent:
 *   - {@link DEFAULT_MODEL}: the general default (workflow LLM nodes). Bump it
 *     freely.
 *   - {@link MEMORY_RATER_DEFAULT_MODEL}: the pinned judge for session
 *     summaries and `llm` memory ratings. Override via `MEMORY_RATER_MODEL`
 *     env (kept for backwards-compat with the claude hook).
 */

/**
 * A provider the internal-ai layer can call. The value doubles as the
 * `provider/` prefix a model string carries (`parseModelStr`), so a kind and
 * its provider id are the same string by construction.
 */
export type CredentialKind =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "openai-codex"
  | "claude-cli"
  | "fireworks"
  | "amazon-bedrock";

/**
 * Per-credential default model strings. The "claude-cli" kind uses the
 * shorthand "haiku" because the only consumer is the `claude -p --model haiku`
 * shellout, not pi-ai's `getModel`.
 *
 * Every `provider/model-id` value here must exist in pi-ai's own catalog
 * (`getBuiltinModel(provider, modelId)`), because `complete-structured.ts`
 * resolves it through that catalog and a miss is a silent no-op.
 *
 * `amazon-bedrock` names a cross-region inference profile
 * (`global.` prefix). A foundation-model id would only be invocable in the one
 * region that owns it, and the profile prefix is what current Claude models on
 * Bedrock actually take. Pin a region-scoped profile (`us.…`, `eu.…`) with
 * `MEMORY_RATER_MODEL` / `TASK_AUTO_TITLE_MODEL` where an account needs one.
 */
export const DEFAULT_MODEL: Record<CredentialKind, string> = {
  openrouter: "openrouter/deepseek/deepseek-v4.1-flash",
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-6-luna",
  "openai-codex": "openai-codex/gpt-6-luna",
  "claude-cli": "haiku",
  fireworks: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
  "amazon-bedrock": "amazon-bedrock/global.anthropic.claude-haiku-5-5",
};

/**
 * Per-credential model for the session-summary + `llm` memory rater.
 *
 * Pinned on purpose and deliberately NOT derived from {@link DEFAULT_MODEL}.
 * Every `llm` rating is a judgement by this model, so changing it shifts the
 * score distribution that memory ranking reads. Bumping `DEFAULT_MODEL` for
 * another caller once swapped the judge unnoticed (Gemini 3 Flash to DeepSeek
 * v4.1 Flash, 2026-09-23). Change an entry here only as a deliberate decision
 * about the judge; each rating records the model that produced it in
 * `memory_rating.model`.
 */
export const MEMORY_RATER_DEFAULT_MODEL: Record<CredentialKind, string> = {
  openrouter: "openrouter/deepseek/deepseek-v4.1-flash",
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-6-luna",
  "openai-codex": "openai-codex/gpt-6-luna",
  "claude-cli": "haiku",
  // Same model family as the OpenRouter judge above (DeepSeek V4.1 Flash), so a
  // Fireworks deployment rates with the model the distribution was tuned on
  // rather than shifting it. `fireworks/accounts/fireworks/models/…` is the
  // provider's native id; the `routers/…` variants cost more per token.
  fireworks: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
  // A Haiku, i.e. the same family the Anthropic kind rates with, reached
  // through a global inference profile. Not `anthropic.claude-haiku-4-5`: that
  // generation costs 1.00/5.00 per million on Bedrock, ten times this one, and
  // a new kind has no existing rating distribution to stay consistent with.
  "amazon-bedrock": "amazon-bedrock/global.anthropic.claude-haiku-5-5",
};

/**
 * Resolve the model string the session-summary + `llm` memory rater uses for
 * a credential kind. `MEMORY_RATER_MODEL` env wins (it pre-dates the per-kind
 * registry and applies to every kind); otherwise the pinned
 * {@link MEMORY_RATER_DEFAULT_MODEL}. Not for other callers: they read
 * {@link DEFAULT_MODEL}.
 */
export function resolveRaterModelString(kind: CredentialKind): string {
  return process.env.MEMORY_RATER_MODEL ?? MEMORY_RATER_DEFAULT_MODEL[kind];
}

const PROVIDER_TO_KIND: Record<string, CredentialKind> = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai-codex",
  fireworks: "fireworks",
  "amazon-bedrock": "amazon-bedrock",
};

/**
 * Credential kind a model string belongs to. `provider/model-id` maps through
 * the provider prefix; a bare alias (`haiku`) is a `claude -p` model. `null`
 * for a provider the internal-ai layer cannot call.
 */
export function kindForModelString(modelStr: string): CredentialKind | null {
  const slash = modelStr.indexOf("/");
  if (slash < 0) return "claude-cli";
  return PROVIDER_TO_KIND[modelStr.slice(0, slash)] ?? null;
}

/**
 * Split a `provider/model-id` string on the FIRST `/` so that OpenRouter
 * compound IDs like `openrouter/deepseek/deepseek-v4.1-flash` parse as
 * `("openrouter", "deepseek/deepseek-v4.1-flash")`. Mirrors the existing
 * convention in `src/providers/pi-mono-adapter.ts:161-170`.
 */
export function parseModelStr(modelStr: string): [provider: string, modelId: string] {
  const idx = modelStr.indexOf("/");
  if (idx < 0) throw new Error(`invalid model string (no '/'): ${modelStr}`);
  return [modelStr.slice(0, idx), modelStr.slice(idx + 1)];
}
