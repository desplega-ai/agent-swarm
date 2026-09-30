import { describe, expect, test } from "bun:test";
import { buildAttemptOutcome, oneLine, outcomeVerdict } from "../ui/src/lib/attempt-outcome.ts";
import type { JudgmentJson } from "../ui/src/types.ts";

function judgment(o: Partial<JudgmentJson> & { name: string }): JudgmentJson {
  return {
    id: o.name,
    attemptId: "a",
    kind: "deterministic",
    pass: true,
    score: 1,
    reasoning: null,
    raw: null,
    durationMs: null,
    costUsd: null,
    tokens: null,
    steps: null,
    dimension: null,
    weight: null,
    createdAt: "2026-09-30T00:00:00Z",
    ...o,
  } as JudgmentJson;
}

describe("oneLine", () => {
  test("keeps the first non-empty line and cuts a long one with an ellipsis", () => {
    expect(oneLine("\n  \nAll three answers match.\nSecond paragraph.")).toBe(
      "All three answers match.",
    );
    const cut = oneLine("x".repeat(400), 50);
    expect(cut?.length).toBe(50);
    expect(cut?.endsWith("…")).toBe(true);
  });

  test("null and blank text have no reason", () => {
    expect(oneLine(null)).toBeNull();
    expect(oneLine("  \n \n")).toBeNull();
  });
});

describe("outcomeVerdict", () => {
  test("an error attempt is its own verdict, apart from a failed one", () => {
    expect(outcomeVerdict("error")).toBe("error");
    expect(outcomeVerdict("failed")).toBe("failed");
    expect(outcomeVerdict("passed")).toBe("passed");
  });

  test("anything still moving is unfinished", () => {
    for (const s of ["pending", "running", "judging"]) expect(outcomeVerdict(s)).toBe("unfinished");
  });
});

describe("buildAttemptOutcome", () => {
  const judgments = [
    judgment({ name: "correctness", dimension: "correctness", weight: 3, score: 1 }),
    judgment({ name: "report-exists", pass: false, score: 0, reasoning: "no report.md\nsecond" }),
    judgment({
      kind: "llm",
      name: "communication",
      dimension: "communication",
      weight: 1,
      score: 0.5,
      reasoning: "States the answers but skips the evidence.",
    }),
  ];

  test("a judgment with no dimension is a gate, and gates come apart from dimensions", () => {
    const view = buildAttemptOutcome("failed", judgments);
    expect(view.gates).toEqual([{ name: "report-exists", pass: false, reason: "no report.md" }]);
    expect(view.dimensions.map((d) => d.name)).toEqual(["correctness", "communication"]);
  });

  test("the aggregate is the weight-weighted mean of scored dimensions", () => {
    expect(buildAttemptOutcome("failed", judgments).aggregate).toBeCloseTo((3 * 1 + 1 * 0.5) / 4);
  });

  test("an unscored dimension does not drag the aggregate down", () => {
    const view = buildAttemptOutcome("judging", [
      judgment({ name: "a", dimension: "a", weight: 3, score: 0.8 }),
      judgment({ name: "b", dimension: "b", weight: 1, score: null }),
    ]);
    expect(view.aggregate).toBeCloseTo(0.8);
  });

  test("an attempt from before dimensions existed shows only gates and no aggregate", () => {
    const view = buildAttemptOutcome("passed", [judgment({ name: "old-check" })]);
    expect(view.dimensions).toEqual([]);
    expect(view.aggregate).toBeNull();
    expect(view.gates).toHaveLength(1);
  });
});
