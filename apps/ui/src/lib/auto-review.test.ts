import { describe, expect, test } from "bun:test";
import { isAutoReview } from "./auto-review";

describe("isAutoReview", () => {
  test("only system follow-ups are auto reviews", () => {
    expect(isAutoReview({ source: "system", taskType: "follow-up" })).toBe(true);
    expect(isAutoReview({ source: "ui", taskType: "follow-up" })).toBe(false);
    expect(isAutoReview({ source: "system", taskType: "question" })).toBe(false);
    expect(isAutoReview({ source: "system" })).toBe(false);
  });
});
