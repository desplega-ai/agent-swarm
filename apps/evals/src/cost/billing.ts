/**
 * Which spend counts against a run's metered cost cap.
 *
 * Metered spend = agent cost of configs billed per token + the LLM judge +
 * an estimate of E2B sandbox time. An agent on a flat subscription costs $0
 * metered; it is limited by the subscription's rate limit, which is what the
 * per-config concurrency cap below protects.
 *
 * E2B time is priced from E2B's published per-second rates and the two sandbox
 * shapes an attempt boots. The E2B bill itself is not reachable with the runner's
 * API key (`GET /teams` answers 401: it needs a dashboard session), so this is an
 * estimate; `EVALS_E2B_USD_PER_SANDBOX_HOUR` replaces it with one flat rate per
 * sandbox once someone has a real number from the bill.
 *
 * Billing is decided from the credential the sandbox is actually given
 * (`credentialsForConfig` in src/swarm/sandbox.ts), never from the provider
 * name alone:
 *   - claude: OAuth token present -> subscription; else ANTHROPIC_API_KEY -> metered.
 *   - codex:  the sandbox only receives OPENAI_API_KEY, which bills per token,
 *             so it is metered unless EVALS_CODEX_BILLING=subscription says the
 *             key fronts a flat plan.
 *   - pi / opencode: OpenRouter or provider API keys -> metered.
 */

import type { AttemptRow, HarnessConfig } from "../types.ts";

export type Billing = "subscription" | "metered";

/** Default per-config attempt concurrency for subscription configs (one run must not drain a rate window). */
export const DEFAULT_SUBSCRIPTION_CONFIG_CONCURRENCY = 3;

/**
 * E2B published compute rates (https://e2b.dev/pricing, checked 2026-09-30).
 * The Hobby and Pro tiers charge the same per-second rates.
 */
export const E2B_USD_PER_VCPU_SECOND = 0.000014;
export const E2B_USD_PER_GIB_SECOND = 0.0000045;

/**
 * Shapes of the two sandboxes an attempt boots, read from `GET /templates` on
 * 2026-09-30: `agent-swarm-api-latest` is 2 vCPU / 2 GiB, `agent-swarm-worker-latest`
 * is 4 vCPU / 8 GiB. Re-check when a template is rebuilt with a new size.
 */
export const API_SANDBOX_SHAPE = { vcpu: 2, gib: 2 } as const;
export const WORKER_SANDBOX_SHAPE = { vcpu: 4, gib: 8 } as const;

/** USD per hour of one running sandbox of the given shape, at the published rates. */
export function sandboxHourlyUsd(shape: { vcpu: number; gib: number }): number {
  return (shape.vcpu * E2B_USD_PER_VCPU_SECOND + shape.gib * E2B_USD_PER_GIB_SECOND) * 3600;
}

type Env = Record<string, string | undefined>;

export function configBilling(
  config: Pick<HarnessConfig, "provider">,
  env: Env = process.env,
): Billing {
  switch (config.provider) {
    case "claude":
      return env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : "metered";
    case "codex":
      return env.EVALS_CODEX_BILLING === "subscription" ? "subscription" : "metered";
    default:
      return "metered";
  }
}

export function subscriptionConfigConcurrency(env: Env = process.env): number {
  const n = Number(env.EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_SUBSCRIPTION_CONFIG_CONCURRENCY;
}

/** Flat per-sandbox override from `EVALS_E2B_USD_PER_SANDBOX_HOUR`; null = use the published per-shape rates. */
export function e2bUsdPerSandboxHour(env: Env = process.env): number | null {
  const n = Number(env.EVALS_E2B_USD_PER_SANDBOX_HOUR);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * E2B time for one attempt: wall clock x the API sandbox plus one worker-shaped
 * sandbox per roster entry (the lead, when a scenario has one, is a roster entry).
 * `flatUsdPerHour` (see {@link e2bUsdPerSandboxHour}) prices every sandbox alike.
 */
export function estimateSandboxUsd(
  attempt: Pick<AttemptRow, "durationMs" | "sandbox">,
  flatUsdPerHour: number | null = null,
): number {
  if (attempt.durationMs === null || attempt.durationMs === undefined) return 0;
  const workers = attempt.sandbox?.workers.length ?? 1;
  const hours = attempt.durationMs / 3_600_000;
  if (flatUsdPerHour !== null) return hours * (1 + workers) * flatUsdPerHour;
  return (
    hours * (sandboxHourlyUsd(API_SANDBOX_SHAPE) + workers * sandboxHourlyUsd(WORKER_SANDBOX_SHAPE))
  );
}

/**
 * Metered dollars one attempt spent: agent cost only when the config is billed
 * per token, plus judge and sandbox time. Unpriced (null) parts count as 0.
 */
export function attemptMeteredUsd(
  attempt: Pick<AttemptRow, "costUsd" | "judgeCostUsd" | "durationMs" | "sandbox">,
  billing: Billing,
  flatUsdPerSandboxHour: number | null = null,
): number {
  const agent = billing === "metered" ? (attempt.costUsd ?? 0) : 0;
  return agent + (attempt.judgeCostUsd ?? 0) + estimateSandboxUsd(attempt, flatUsdPerSandboxHour);
}
