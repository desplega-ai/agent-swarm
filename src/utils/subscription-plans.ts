/**
 * Flat-rate subscription plans behind pooled OAuth credentials, with list
 * prices, so the usage page can compare them with the API-priced cost of the
 * sessions they ran.
 *
 * Detection: a Codex (ChatGPT) token carries the plan in its JWT
 * (`chatgpt_plan_type`), see `codexPlanFromClaim`. A Claude token from
 * `claude setup-token` has only the `user:inference` scope, so Anthropic's
 * `/api/oauth/profile` answers 403 (checked 2026-09-25). The Claude plan is
 * unknown unless the operator selects it. Historical estimates remain uncertain.
 */

import type { ModelFamily } from "./model-rate-limit-windows";

export interface SubscriptionPlan {
  id: string;
  label: string;
  /** Credential pool var the plan applies to. */
  keyType: "CLAUDE_CODE_OAUTH_TOKEN" | "CODEX_OAUTH";
  /** Monthly list price in USD, billed monthly. */
  monthlyUsd: number;
  /** Model families the plan cannot run. Absent means the plan runs every family. */
  excludedModelFamilies?: readonly ModelFamily[];
}

/** List prices from claude.com/pricing and chatgpt.com/pricing, checked 2026-11-08. */
export const SUBSCRIPTION_PLANS_CHECKED_AT = "2026-11-08";

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  { id: "claude_pro", label: "Claude Pro", keyType: "CLAUDE_CODE_OAUTH_TOKEN", monthlyUsd: 20 },
  {
    id: "claude_max_5x",
    label: "Claude Max",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 100,
  },
  {
    id: "claude_max_20x",
    label: "Claude Ultra",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 200,
  },
  {
    id: "claude_team_standard",
    label: "Claude Team, standard seat",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 25,
    // Preserve the existing routing policy. This label update does not
    // establish whether paid usage credits permit a model.
    excludedModelFamilies: ["fable"],
  },
  {
    id: "claude_team_premium",
    label: "Claude Team, premium seat",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 125,
  },
  { id: "chatgpt_go", label: "ChatGPT Go", keyType: "CODEX_OAUTH", monthlyUsd: 8 },
  { id: "chatgpt_plus", label: "ChatGPT Plus", keyType: "CODEX_OAUTH", monthlyUsd: 20 },
  { id: "chatgpt_pro_5x", label: "ChatGPT Pro 100", keyType: "CODEX_OAUTH", monthlyUsd: 100 },
  { id: "chatgpt_pro", label: "ChatGPT Pro 200", keyType: "CODEX_OAUTH", monthlyUsd: 200 },
  { id: "chatgpt_pro_500", label: "ChatGPT Pro 500", keyType: "CODEX_OAUTH", monthlyUsd: 500 },
  {
    id: "chatgpt_business",
    label: "ChatGPT Business, standard seat",
    keyType: "CODEX_OAUTH",
    monthlyUsd: 25,
  },
  {
    id: "chatgpt_business_premium",
    label: "ChatGPT Business, premium seat",
    keyType: "CODEX_OAUTH",
    monthlyUsd: 125,
  },
];

/** Credential types billed as a flat subscription rather than per token. */
export const SUBSCRIPTION_KEY_TYPES: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_OAUTH"];

export function isSubscriptionPlanId(id: string): boolean {
  return SUBSCRIPTION_PLANS.some((plan) => plan.id === id);
}

/**
 * Whether a key on `plan` can run `family`. Fails open: a null plan, a plan
 * id the map does not know, or an undefined family returns true. Returns
 * false only when the plan record lists the family in `excludedModelFamilies`.
 */
export function planAllowsModelFamily(
  plan: string | null | undefined,
  family: ModelFamily | undefined,
): boolean {
  if (!plan || !family) return true;
  const record = SUBSCRIPTION_PLANS.find((p) => p.id === plan);
  if (!record?.excludedModelFamilies) return true;
  return !record.excludedModelFamilies.includes(family);
}

/** Map only unambiguous claims to priced plans. Preserve raw Pro identities separately. */
export function codexPlanFromClaim(claim: string | null | undefined): string | null {
  switch (claim?.toLowerCase()) {
    case "go":
      return "chatgpt_go";
    case "plus":
      return "chatgpt_plus";
    case "team":
    case "business":
      return "chatgpt_business";
    default:
      return null;
  }
}
