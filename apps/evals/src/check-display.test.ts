import { describe, expect, test } from "bun:test";
import { isScoredJudgment, observedText } from "../ui/src/lib/check-descriptions.ts";

describe("scored check display", () => {
  test("a dimension check with a score is scored; a gate is not", () => {
    expect(isScoredJudgment({ dimension: "correctness", score: 0.67 })).toBe(true);
    expect(isScoredJudgment({ dimension: null, score: 1 })).toBe(false);
    expect(isScoredJudgment({ dimension: "correctness", score: null })).toBe(false);
  });

  test("a scored 0.67 reads as a number, not as Failed", () => {
    const text = observedText("2/3 facts", false, 0.67, true);
    expect(text).toBe("Scored 0.67 of 1: 2/3 facts");
    expect(text).not.toMatch(/Failed/);
  });

  test("gates keep pass/fail", () => {
    expect(observedText("missing", false, null)).toBe("Failed: missing");
  });
});
