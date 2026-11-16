/**
 * ChatGPT subscription models on the pi harness.
 *
 * `openai-codex/<id>` runs `<id>` through the swarm's shared Codex/ChatGPT
 * OAuth pool (`codex_oauth_<n>` slots) instead of an OpenAI API key. The
 * prefix is pi-ai's provider id for the ChatGPT backend. `<id>` is an OpenAI
 * catalog id, so the same ids the codex harness lists are valid here.
 *
 * opencode is not on the list: see its `unsupported` trait below.
 *
 * Pure module: no IO, no Bun APIs.
 */

/** Model id prefix that selects the ChatGPT subscription pool. */
export const CHATGPT_SUBSCRIPTION_PROVIDER = "openai-codex";

/**
 * Each harness's subscription-first trait for OpenAI models: whether a
 * `codex_oauth` pool slot can serve them, and how the model is named then.
 * One runner resolver reads it: the pool wins, OPENAI_API_KEY is the fallback
 * only when the pool has no slot.
 * - `native`: the harness runs bare ids on the pool itself (codex).
 * - `prefixed`: the harness runs `openai-codex/<id>` on the pool (pi).
 * - `unsupported`: OpenAI models use an API key only; `reason` says why.
 */
export type ChatgptSubscriptionTrait =
  | { kind: "native" }
  | { kind: "prefixed" }
  | { kind: "unsupported"; reason: string };

const CHATGPT_SUBSCRIPTION_TRAITS: Readonly<Record<string, ChatgptSubscriptionTrait>> = {
  codex: { kind: "native" },
  pi: { kind: "prefixed" },
  opencode: {
    kind: "unsupported",
    reason:
      "opencode's ChatGPT login is an internal plugin the embedded SDK host does not register (integration.list is empty), and it refreshes the token itself, outside the pool's refresh lock",
  },
};

export function chatgptSubscriptionTrait(harness: string): ChatgptSubscriptionTrait {
  return (
    CHATGPT_SUBSCRIPTION_TRAITS[harness] ?? {
      kind: "unsupported",
      reason: "no ChatGPT subscription path",
    }
  );
}

/** Harnesses that run `openai-codex/<id>` models (codex runs bare ids on the pool already). */
export const CHATGPT_SUBSCRIPTION_HARNESSES: readonly string[] = Object.keys(
  CHATGPT_SUBSCRIPTION_TRAITS,
).filter((harness) => CHATGPT_SUBSCRIPTION_TRAITS[harness]?.kind === "prefixed");

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
