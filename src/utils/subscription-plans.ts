/**
 * Flat-rate subscription plans behind pooled OAuth credentials, with list
 * prices, so the usage page can compare them with the API-priced cost of the
 * sessions they ran.
 *
 * Detection: a Codex (ChatGPT) token carries the plan in its JWT
 * (`chatgpt_plan_type`), see `codexPlanFromClaim`. A Claude token from
 * `claude setup-token` has only the `user:inference` scope, so Anthropic's
 * `/api/oauth/profile` answers 403 (checked 2026-09-25). The Claude plan is
 * estimated from rate-limit utilization instead (`estimateClaudePlan`), and
 * the operator can always pick it on the dashboard.
 */

export interface SubscriptionPlan {
  id: string;
  label: string;
  /** Credential pool var the plan applies to. */
  keyType: "CLAUDE_CODE_OAUTH_TOKEN" | "CODEX_OAUTH";
  /** Monthly list price in USD, billed monthly. */
  monthlyUsd: number;
}

/** List prices from claude.com/pricing and chatgpt.com/pricing, checked 2026-09-25. */
export const SUBSCRIPTION_PLANS_CHECKED_AT = "2026-09-25";

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  { id: "claude_pro", label: "Claude Pro", keyType: "CLAUDE_CODE_OAUTH_TOKEN", monthlyUsd: 20 },
  {
    id: "claude_max_5x",
    label: "Claude Max 5x",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 100,
  },
  {
    id: "claude_max_20x",
    label: "Claude Max 20x",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 200,
  },
  {
    id: "claude_team_standard",
    label: "Claude Team, standard seat",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 25,
  },
  {
    id: "claude_team_premium",
    label: "Claude Team, premium seat",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    monthlyUsd: 125,
  },
  { id: "chatgpt_go", label: "ChatGPT Go", keyType: "CODEX_OAUTH", monthlyUsd: 8 },
  { id: "chatgpt_plus", label: "ChatGPT Plus", keyType: "CODEX_OAUTH", monthlyUsd: 20 },
  { id: "chatgpt_pro_5x", label: "ChatGPT Pro 5x", keyType: "CODEX_OAUTH", monthlyUsd: 100 },
  { id: "chatgpt_pro", label: "ChatGPT Pro 20x", keyType: "CODEX_OAUTH", monthlyUsd: 200 },
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
 * Map the `chatgpt_plan_type` JWT claim to a plan id. The claim says `pro`
 * for both Pro tiers, so `pro` maps to the 20x plan (the operator can change
 * it). `free`, `enterprise`, `edu` and unknown values have no list price and
 * return null.
 */
export function codexPlanFromClaim(claim: string | null | undefined): string | null {
  switch (claim?.toLowerCase()) {
    case "go":
      return "chatgpt_go";
    case "plus":
      return "chatgpt_plus";
    case "pro":
      return "chatgpt_pro";
    case "team":
    case "business":
      return "chatgpt_business";
    default:
      return null;
  }
}

/**
 * A Claude token cannot tell its plan, but the provider reports how much of
 * each rate-limit window the credential used. The API-priced spend it ran in
 * the 7-day window, divided by that share, is the window's capacity in USD.
 * Measured on production on 2026-09-25, 3 Max 20x credentials held about
 * $2,000 per 7-day window (8 of 8 windows classified right). Max 5x has 1/4 of
 * the Max 20x capacity and Pro 1/20. The 5-hour window was too noisy (15% of
 * windows looked like Max 5x), so it is not used.
 */
const MAX_20X_WEEKLY_CAPACITY_USD = 2000;
/** Below this share of the week the spend is too small to classify. */
export const MIN_ESTIMATE_UTILIZATION = 0.25;
const CLAUDE_TIERS: readonly (readonly [plan: string, shareOfMax20x: number])[] = [
  ["claude_pro", 1 / 20],
  ["claude_max_5x", 1 / 4],
  ["claude_max_20x", 1],
];

/**
 * Estimate a Claude plan from the 7-day window: the nearest tier on a log
 * scale. Returns null when the window is too little used. Usage outside the
 * swarm on the same account raises the utilization, so it can read a tier low.
 */
export function estimateClaudePlan(
  weeklyUtilization: number,
  weeklySpendUsd: number,
): string | null {
  if (weeklyUtilization < MIN_ESTIMATE_UTILIZATION || weeklySpendUsd <= 0) return null;
  const share = weeklySpendUsd / weeklyUtilization / MAX_20X_WEEKLY_CAPACITY_USD;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [plan, tierShare] of CLAUDE_TIERS) {
    const distance = Math.abs(Math.log(share / tierShare));
    if (distance < bestDistance) {
      best = plan;
      bestDistance = distance;
    }
  }
  return best;
}
