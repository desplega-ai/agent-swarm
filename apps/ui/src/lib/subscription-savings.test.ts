import { expect, test } from "bun:test";
import type { SubscriptionPlan, UsageSummaryByCredentialRow } from "../api/types";
import { subscriptionSavings } from "./subscription-savings";

test("unknown credentials and estimated plans do not become confirmed billing", () => {
  const start = Date.parse("2026-11-08T00:00:00Z");
  const row = (extra: Partial<UsageSummaryByCredentialRow>) =>
    ({
      keyType: null,
      keySuffix: null,
      subscription: false,
      costUsd: 7,
      sessions: 1,
      firstSessionAt: new Date(start).toISOString(),
      ...extra,
    }) as UsageSummaryByCredentialRow;
  const unknown = row({});
  const payg = row({ keyType: "OPENAI_API_KEY", keySuffix: "payg" });
  const estimate = row({
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    keySuffix: "estimated",
    subscription: true,
    plan: "claude_max_20x",
    planSource: "estimated",
  });
  const manual = row({ ...estimate, keySuffix: "manual", planSource: "manual" });
  const plans = [
    { id: "claude_max_20x", keyType: "CLAUDE_CODE_OAUTH_TOKEN", monthlyUsd: 200 },
  ] as SubscriptionPlan[];
  const summary = subscriptionSavings(
    [unknown, payg, estimate, manual],
    plans,
    start,
    start + 3600000,
  );
  expect(summary.payg).toEqual([payg]);
  expect(summary.counted.map((line) => line.row.keySuffix)).toEqual(["manual"]);
  expect(summary.apiValue).toBe(7);
  expect(summary.lines.find((line) => line.row.keySuffix === "estimated")?.planCost).toBeNull();
});
