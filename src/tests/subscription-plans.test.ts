import { describe, expect, test } from "bun:test";
import {
  codexPlanFromClaim,
  planAllowsModelFamily,
  SUBSCRIPTION_PLANS,
} from "../utils/subscription-plans";

describe("planAllowsModelFamily", () => {
  test("claude_team_standard cannot run fable", () => {
    expect(planAllowsModelFamily("claude_team_standard", "fable")).toBe(false);
  });

  test("claude_team_standard can run opus", () => {
    expect(planAllowsModelFamily("claude_team_standard", "opus")).toBe(true);
  });

  test("claude_team_premium can run fable", () => {
    expect(planAllowsModelFamily("claude_team_premium", "fable")).toBe(true);
  });

  test("a null plan fails open", () => {
    expect(planAllowsModelFamily(null, "fable")).toBe(true);
  });

  test("an unknown plan fails open", () => {
    expect(planAllowsModelFamily("unknown_plan", "fable")).toBe(true);
  });

  test("an undefined family is always allowed", () => {
    expect(planAllowsModelFamily("claude_team_standard", undefined)).toBe(true);
  });
});

test("current labels retain stable IDs and add a manual Pro 500 choice", () => {
  const plans = new Map(SUBSCRIPTION_PLANS.map((plan) => [plan.id, plan]));
  expect(plans.get("claude_max_5x")?.label).toBe("Claude Max");
  expect(plans.get("claude_max_20x")?.label).toBe("Claude Ultra");
  for (const [id, label, price] of [
    ["chatgpt_pro_5x", "ChatGPT Pro 100", 100],
    ["chatgpt_pro", "ChatGPT Pro 200", 200],
    ["chatgpt_pro_500", "ChatGPT Pro 500", 500],
  ] as const) {
    expect(plans.get(id)).toMatchObject({ label, monthlyUsd: price });
  }
  for (const raw of ["pro", "prolite", "promax", "future-tier"])
    expect(codexPlanFromClaim(raw)).toBeNull();
});
