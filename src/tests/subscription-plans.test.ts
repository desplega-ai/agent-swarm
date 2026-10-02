import { describe, expect, test } from "bun:test";
import { planAllowsModelFamily } from "../utils/subscription-plans";

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
