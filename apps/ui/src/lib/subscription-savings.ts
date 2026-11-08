// What subscription runs would cost at API prices, minus what their plans
// cost over the same days. Shared by Usage (Subscriptions vs API) and the
// Home strip ("Subs saved today"), so the two never disagree.

import type { SubscriptionPlan, UsageSummaryByCredentialRow } from "../api/types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Plans are priced per month; a day costs 1/30.44 of it. */
const DAYS_PER_MONTH = 30.44;

export interface SubscriptionLine {
  key: string;
  row: UsageSummaryByCredentialRow;
  plan: SubscriptionPlan | null;
  planCost: number | null;
  saved: number | null;
}

export interface SubscriptionSavings {
  /** Subscription credentials, most expensive first. */
  lines: SubscriptionLine[];
  /** Pay-as-you-go credentials, most expensive first. */
  payg: UsageSummaryByCredentialRow[];
  /** Lines with a known plan: only these count toward the saving. */
  counted: SubscriptionLine[];
  apiValue: number;
  plansCost: number;
  saved: number;
}

export function credentialKey(row: UsageSummaryByCredentialRow): string {
  return `${row.keyType ?? "none"}:${row.keySuffix ?? "none"}`;
}

/**
 * A plan is billed per day from the later of the window start and the
 * credential's first session, at least one day.
 */
export function subscriptionSavings(
  rows: UsageSummaryByCredentialRow[],
  plans: SubscriptionPlan[],
  windowStartMs: number,
  now: number,
): SubscriptionSavings {
  const byCost = (a: UsageSummaryByCredentialRow, b: UsageSummaryByCredentialRow) =>
    b.costUsd - a.costUsd;
  const lines: SubscriptionLine[] = rows
    .filter((row) => row.subscription)
    .sort(byCost)
    .map((row) => {
      const plan =
        row.planSource === "estimated"
          ? null
          : (plans.find((p) => p.id === row.plan && p.keyType === row.keyType) ?? null);
      if (!plan) return { key: credentialKey(row), row, plan, planCost: null, saved: null };
      const billedFrom = Math.max(windowStartMs, Date.parse(row.firstSessionAt));
      const billedDays = Math.max(1, (now - billedFrom) / DAY_MS);
      const planCost = (plan.monthlyUsd * billedDays) / DAYS_PER_MONTH;
      return { key: credentialKey(row), row, plan, planCost, saved: row.costUsd - planCost };
    });
  const payg = rows.filter((row) => !row.subscription && row.keyType !== null).sort(byCost);
  const counted = lines.filter((line) => line.plan);
  const apiValue = counted.reduce((sum, line) => sum + line.row.costUsd, 0);
  const plansCost = counted.reduce((sum, line) => sum + (line.planCost ?? 0), 0);
  return { lines, payg, counted, apiValue, plansCost, saved: apiValue - plansCost };
}
