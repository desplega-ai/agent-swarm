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
 *   - codex:  a ChatGPT auth.json from the swarm's codex_oauth slot
 *             (src/swarm/codex-auth.ts) -> subscription; else OPENAI_API_KEY -> metered.
 *   - pi / opencode: OpenRouter or provider API keys -> metered.
 *
 * bootStack records each member's billing from what it actually installed
 * (`SandboxWorkerInfo.billing`); {@link attemptMeteredUsd} prefers that record.
 * {@link configBilling} predicts the same answer before boot, for the
 * per-config concurrency limit and for rows written before the record existed.
 */

import { codexOAuthSource } from "../swarm/codex-auth.ts";
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
      return codexOAuthSource(env) ? "subscription" : "metered";
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
 * Billing the attempt's members recorded at boot: subscription only when every
 * member ran on a subscription credential. Null when any member has no record
 * (rows written before bootStack recorded it).
 */
export function recordedBilling(sandbox: AttemptRow["sandbox"]): Billing | null {
  const workers = sandbox?.workers ?? [];
  if (workers.length === 0 || workers.some((w) => !w.billing)) return null;
  return workers.every((w) => w.billing === "subscription") ? "subscription" : "metered";
}

/**
 * Metered dollars one attempt spent: agent cost only when the attempt was
 * billed per token, plus judge and sandbox time. Unpriced (null) parts count
 * as 0. `fallbackBilling` applies only when the attempt carries no recorded
 * billing ({@link recordedBilling}).
 */
export function attemptMeteredUsd(
  attempt: Pick<AttemptRow, "costUsd" | "judgeCostUsd" | "durationMs" | "sandbox">,
  fallbackBilling: Billing,
  flatUsdPerSandboxHour: number | null = null,
): number {
  const billing = recordedBilling(attempt.sandbox) ?? fallbackBilling;
  const agent = billing === "metered" ? (attempt.costUsd ?? 0) : 0;
  return agent + (attempt.judgeCostUsd ?? 0) + estimateSandboxUsd(attempt, flatUsdPerSandboxHour);
}
