/**
 * Failure-injection primitive (swarm-mechanics evals): `ScenarioSeed.workerFailures`.
 *
 * The actual injection loop lives INLINE in runAttempt() (src/runner/index.ts §3,
 * after the seed.exec block) and is not separately exported — exercising it
 * end-to-end would require heavy E2B mocking (Sandbox.connect + commands.run).
 * These tests therefore cover the parts we CAN assert honestly and cheaply:
 *
 *   1. the field's documented TYPE shape compiles ({ worker; commands; label? }[]);
 *   2. back-compat — validateScenario() accepts a scenario carrying it (the field
 *      is optional + ignored by the validator, so existing scenarios are
 *      unaffected and absent workerFailures => zero behavior change);
 *   3. a PURE REPLICA of the runner's inline worker-resolution guard, asserting
 *      the core semantic: a worker that is out-of-range OR is the lead is
 *      SKIPPED (logged), never thrown — the rest run best-effort.
 *
 * (3) is a replica, not the real loop; if the inline guard in index.ts changes,
 * update this mirror too. It exists to lock the skip-not-throw contract the
 * failure-scenario authors rely on.
 */
import { describe, expect, test } from "bun:test";
import { validateScenario } from "../registry.ts";
import type { Scenario, ScenarioSeed } from "../types.ts";

describe("ScenarioSeed.workerFailures — type shape", () => {
  test("compiles with worker + commands (+ optional label)", () => {
    const seed: ScenarioSeed = {
      workerFailures: [
        { worker: 0, commands: ["rm -f /workspace/input.json"], label: "delete-input" },
        { worker: 1, commands: ["echo WRONG > /workspace/result.txt"] },
      ],
    };
    expect(seed.workerFailures).toHaveLength(2);
    expect(seed.workerFailures?.[0]?.worker).toBe(0);
    expect(seed.workerFailures?.[0]?.label).toBe("delete-input");
    // label is optional — second entry omits it.
    expect(seed.workerFailures?.[1]?.label).toBeUndefined();
  });
});

describe("validateScenario — workerFailures back-compat", () => {
  const base: Scenario = {
    id: "wf-test",
    name: "wf test",
    tasks: [{ title: "t0", description: "d0" }],
    outcome: {},
  };

  test("a scenario carrying workerFailures still validates clean", () => {
    const errors = validateScenario({
      ...base,
      workers: 2,
      seed: {
        exec: ["true"],
        workerFailures: [{ worker: 1, commands: ["rm -f /workspace/seed.txt"] }],
      },
    });
    expect(errors).toEqual([]);
  });

  test("absent workerFailures changes nothing", () => {
    expect(validateScenario({ ...base, seed: { exec: ["true"] } })).toEqual([]);
  });
});

/**
 * Pure replica of the runner's inline guard
 *   `if (!w || w.member.role !== "worker") { skip+log; continue }`.
 * Returns "skipped" or "injected" instead of throwing, proving the best-effort
 * out-of-range / lead-index handling never errors the attempt.
 */
function resolveFailureTarget(
  members: { role: "lead" | "worker" }[],
  workerIndex: number,
): "skipped" | "injected" {
  const w = members[workerIndex];
  if (!w || w.role !== "worker") return "skipped";
  return "injected";
}

describe("worker-failure target resolution (inline-guard replica)", () => {
  const roster = [
    { role: "worker" as const },
    { role: "worker" as const },
    { role: "lead" as const },
  ];

  test("in-range worker index injects", () => {
    expect(resolveFailureTarget(roster, 0)).toBe("injected");
    expect(resolveFailureTarget(roster, 1)).toBe("injected");
  });

  test("out-of-range index is skipped (not thrown)", () => {
    expect(() => resolveFailureTarget(roster, 5)).not.toThrow();
    expect(resolveFailureTarget(roster, 5)).toBe("skipped");
    expect(resolveFailureTarget(roster, -1)).toBe("skipped");
  });

  test("lead index is skipped — a failure may only target a real worker", () => {
    expect(resolveFailureTarget(roster, 2)).toBe("skipped");
  });
});
