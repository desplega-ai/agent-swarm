/**
 * ChatGPT subscription models on the pi harness.
 *
 * `openai-codex/<id>` runs `<id>` through the swarm's shared Codex/ChatGPT
 * OAuth pool (`codex_oauth_<n>` slots) instead of an OpenAI API key. The
 * prefix is pi-ai's provider id for the ChatGPT backend. `<id>` is an OpenAI
 * catalog id, so the same ids the codex harness lists are valid here.
 *
 * opencode is not on the list: it keeps credentials in its own SQLite store
 * (`opencode auth import`), not a per-session file, and drops to API-key mode
 * when a refresh fails.
 *
 * Pure module: no IO, no Bun APIs.
 */

/** Model id prefix that selects the ChatGPT subscription pool. */
export const CHATGPT_SUBSCRIPTION_PROVIDER = "openai-codex";

/** Harnesses that can run a subscription model (codex runs bare ids on the pool already). */
export const CHATGPT_SUBSCRIPTION_HARNESSES: readonly string[] = ["pi"];

/** The bare OpenAI id of an `openai-codex/<id>` model, else null. */
export function chatgptSubscriptionModelId(model: string | null | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  const prefix = `${CHATGPT_SUBSCRIPTION_PROVIDER}/`;
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const id = trimmed.slice(prefix.length);
  return id && !id.includes("/") ? id : null;
}

/** True when `model` runs on the ChatGPT subscription pool. */
export function isChatgptSubscriptionModel(model: string | null | undefined): boolean {
  return chatgptSubscriptionModelId(model) !== null;
}
