import { describe, expect, test } from "bun:test";
import { normalizeOutcome } from "./normalize-outcome.ts";
import { DEFAULT_PASS_THRESHOLD } from "./scoring.ts";
import type { CheckResult, DeterministicCheck, DimensionSpec, OutcomeSpec } from "./types.ts";

/** Trivial passing check; only the name matters for normalization assertions. */
function check(name: string, weight?: number): DeterministicCheck {
  const c: DeterministicCheck = {
    name,
    fn: async (): Promise<CheckResult> => ({ pass: true }),
  };
  if (weight !== undefined) c.weight = weight;
  return c;
}

describe("normalizeOutcome — v1 → v2 mapping (v8.0)", () => {
  test("empty outcome → no gates, no dimensions, default threshold", () => {
    const n = normalizeOutcome({});
    expect(n.gates).toEqual([]);
    expect(n.dimensions).toEqual([]);
    expect(n.passThreshold).toBe(DEFAULT_PASS_THRESHOLD);
    expect(n.passThreshold).toBe(0.75);
  });

  test("v1 checks[] → gates[] preserving order; no dimensions", () => {
    const a = check("a");
    const b = check("b");
    const c = check("c");
    const n = normalizeOutcome({ checks: [a, b, c] });
    expect(n.gates).toEqual([a, b, c]);
    expect(n.gates.map((g) => g.name)).toEqual(["a", "b", "c"]);
    expect(n.dimensions).toEqual([]);
  });

  test("v1 llmJudge → single correctness dimension weight 1 (non-agentic)", () => {
    const n = normalizeOutcome({
      llmJudge: { rubric: "is it correct?", model: "some-model" },
    });
    expect(n.dimensions).toEqual([
      {
        name: "correctness",
        weight: 1,
        judge: { rubric: "is it correct?", model: "some-model", agentic: false },
      },
    ]);
    expect(n.gates).toEqual([]);
  });

  test("v1 agenticJudge → single correctness dimension weight 1 (agentic)", () => {
    const n = normalizeOutcome({
      agenticJudge: { rubric: "verify it", model: "judge-x", maxSteps: 12 },
    });
    expect(n.dimensions).toEqual([
      {
        name: "correctness",
        weight: 1,
        judge: { rubric: "verify it", model: "judge-x", agentic: true, maxSteps: 12 },
      },
    ]);
  });

  test("both v1 judges set → prefers the agentic judge", () => {
    const n = normalizeOutcome({
      llmJudge: { rubric: "llm rubric" },
      agenticJudge: { rubric: "agentic rubric" },
    });
    expect(n.dimensions).toHaveLength(1);
    expect(n.dimensions[0]?.name).toBe("correctness");
    expect(n.dimensions[0]?.judge?.agentic).toBe(true);
    expect(n.dimensions[0]?.judge?.rubric).toBe("agentic rubric");
  });

  test("custom passThreshold overrides the default", () => {
    expect(normalizeOutcome({ passThreshold: 0.6 }).passThreshold).toBe(0.6);
    // 0 is a legitimate explicit threshold and must survive the ?? default.
    expect(normalizeOutcome({ passThreshold: 0 }).passThreshold).toBe(0);
  });
});

describe("normalizeOutcome — native v2 passthrough (v8.0)", () => {
  test("v2 gates + dimensions pass through unchanged", () => {
    const g0 = check("gate-0");
    const dim: DimensionSpec = {
      name: "correctness",
      weight: 2,
      checks: [check("d0", 3)],
    };
    const spec: OutcomeSpec = { gates: [g0], dimensions: [dim] };
    const n = normalizeOutcome(spec);
    expect(n.gates).toEqual([g0]);
    expect(n.dimensions).toEqual([dim]);
  });

  test("v2 dimension with a judge passes through", () => {
    const dim: DimensionSpec = {
      name: "communication",
      weight: 1,
      judge: { rubric: "graded by judge", agentic: true },
    };
    const n = normalizeOutcome({ dimensions: [dim] });
    expect(n.dimensions).toEqual([dim]);
  });

  test("native v2 ignores v1 judges when dimensions are present", () => {
    const dim: DimensionSpec = { name: "completeness", weight: 1, checks: [check("x")] };
    const n = normalizeOutcome({
      dimensions: [dim],
      // A v1 judge alongside explicit dimensions must NOT spawn a second
      // correctness dimension — explicit dimensions win.
      llmJudge: { rubric: "ignored" },
    });
    expect(n.dimensions).toEqual([dim]);
  });
});

describe("normalizeOutcome — mixed v1/v2 (v8.0)", () => {
  test("v1 checks concatenated AFTER v2 gates", () => {
    const g0 = check("gate");
    const c0 = check("legacy-check");
    const n = normalizeOutcome({ gates: [g0], checks: [c0] });
    expect(n.gates).toEqual([g0, c0]);
    expect(n.gates.map((g) => g.name)).toEqual(["gate", "legacy-check"]);
  });

  test("mixed: v2 dimensions win, v1 checks still become gates", () => {
    const c0 = check("legacy");
    const dim: DimensionSpec = { name: "correctness", weight: 1, checks: [check("d")] };
    const n = normalizeOutcome({ checks: [c0], dimensions: [dim] });
    expect(n.gates.map((g) => g.name)).toEqual(["legacy"]);
    expect(n.dimensions).toEqual([dim]);
  });

  test("does NOT prepend tasksCompletedCheck (that stays the runner's job)", () => {
    const n = normalizeOutcome({ checks: [check("only")] });
    expect(n.gates.map((g) => g.name)).toEqual(["only"]);
    expect(n.gates.some((g) => g.name.includes("tasks"))).toBe(false);
  });
});
