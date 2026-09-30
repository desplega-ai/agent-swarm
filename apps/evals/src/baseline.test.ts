import { describe, expect, test } from "bun:test";
import { scenarios } from "../scenarios/index.ts";
import { soloVariant } from "../scenarios/orchestration-utils.ts";
import {
  type BaselineAttempt,
  baselinePairs,
  compareSwarmSolo,
  formatComparison,
  sharedDimensionScore,
  soloVariantId,
} from "./baseline.ts";
import { validateBaselinePairs } from "./registry.ts";
import type { Scenario } from "./types.ts";

function attempt(opts: {
  status?: "passed" | "failed" | "error";
  dims: Record<string, [number, number]>;
  tokens?: number;
  tasksMs?: number;
}): BaselineAttempt {
  return {
    attempt: {
      status: opts.status ?? "passed",
      tokens:
        opts.tokens === undefined
          ? null
          : {
              model: null,
              inputTokens: opts.tokens,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
      timings:
        opts.tasksMs === undefined
          ? null
          : {
              bootMs: null,
              seedMs: null,
              tasksMs: opts.tasksMs,
              perTask: [],
              logCaptureMs: null,
              costMs: null,
              checksMs: null,
              llmJudgeMs: null,
              agenticJudgeMs: null,
              artifactsMs: null,
            },
    },
    judgments: [
      // A gate row: no dimension, ignored.
      { dimension: null, weight: null, score: 1 },
      ...Object.entries(opts.dims).map(([dimension, [weight, score]]) => ({
        dimension,
        weight,
        score,
      })),
    ],
  };
}

const PAIR = { swarmId: "x", soloId: "x-solo", dimensions: ["correctness", "communication"] };

describe("sharedDimensionScore", () => {
  test("re-weights over the shared dimensions only", () => {
    const a = attempt({
      dims: { delegation: [5, 0], correctness: [3, 1], communication: [1, 0], efficiency: [1, 0] },
    });
    expect(sharedDimensionScore(a.judgments, PAIR.dimensions)).toBeCloseTo(0.75, 5);
  });

  test("is null when no shared dimension was scored", () => {
    expect(
      sharedDimensionScore([{ dimension: "delegation", weight: 5, score: 1 }], ["x"]),
    ).toBeNull();
  });
});

describe("compareSwarmSolo", () => {
  test("Δscore, token multiple and Δagent time, skipping unscored attempts", () => {
    const swarm = [
      attempt({
        dims: { correctness: [3, 1], communication: [1, 1] },
        tokens: 3000,
        tasksMs: 200_000,
      }),
      attempt({
        dims: { correctness: [3, 1], communication: [1, 0] },
        tokens: 5000,
        tasksMs: 240_000,
      }),
      attempt({ status: "error", dims: {}, tokens: 99_999 }),
    ];
    const solo = [
      attempt({
        dims: { correctness: [3, 0.5], communication: [1, 1] },
        tokens: 1000,
        tasksMs: 300_000,
      }),
      attempt({
        dims: { correctness: [3, 0.5], communication: [1, 0] },
        tokens: 1000,
        tasksMs: 300_000,
      }),
    ];
    const c = compareSwarmSolo(PAIR, "claude-opus-5.5", swarm, solo);
    expect(c.swarm.n).toBe(2);
    expect(c.swarm.meanScore).toBeCloseTo((1 + 0.75) / 2, 5);
    expect(c.solo.meanScore).toBeCloseTo((0.625 + 0.375) / 2, 5);
    expect(c.deltaScore?.diff).toBeCloseTo(0.375, 5);
    expect(c.tokenMultiple).toBeCloseTo(4, 5);
    expect(c.deltaAgentMs).toBe(-80_000);
    expect(formatComparison(c)).toMatch(
      /^claude-opus-5\.5: Δscore \+0\.38 \[.*\].* · tokens ×4\.0 · Δagent time -80s \(n 2\/2\)$/,
    );
  });

  test("an empty side reads n/a instead of a fake zero", () => {
    const c = compareSwarmSolo(PAIR, "c", [], [attempt({ dims: { correctness: [3, 1] } })]);
    expect(c.deltaScore).toBeNull();
    expect(c.tokenMultiple).toBeNull();
    expect(formatComparison(c)).toBe("c: Δscore n/a · tokens n/a · Δagent time n/a (n 0/1)");
  });
});

describe("registered baselines", () => {
  test("every swarm scenario from Phases 7-8 but capability-routing has a solo baseline, compared on quality dimensions", () => {
    expect(baselinePairs(scenarios)).toEqual([
      {
        swarmId: "fanout-research",
        soloId: "fanout-research-solo",
        dimensions: ["correctness", "communication"],
      },
      {
        swarmId: "worker-recovery",
        soloId: "worker-recovery-solo",
        dimensions: ["correctness", "communication"],
      },
      { swarmId: "implement-review", soloId: "implement-review-solo", dimensions: ["tests"] },
      {
        swarmId: "human-in-loop",
        soloId: "human-in-loop-solo",
        dimensions: ["question-quality", "correctness"],
      },
    ]);
  });

  test("the registry's pairs validate", () => {
    expect(validateBaselinePairs(scenarios)).toEqual([]);
  });
});

describe("validateBaselinePairs", () => {
  const swarm: Scenario = {
    id: "swarm-x",
    version: 2,
    name: "Swarm X",
    workers: 2,
    lead: { name: "Lead" },
    tasks: [{ title: "t", description: "d", worker: "lead" }],
    outcome: {
      dimensions: [
        {
          name: "delegation",
          weight: 5,
          checks: [{ name: "c", fn: async () => ({ pass: true }) }],
        },
        {
          name: "correctness",
          weight: 3,
          checks: [{ name: "c", fn: async () => ({ pass: true }) }],
        },
      ],
    },
    timeoutMs: 60_000,
    budgetUsd: 0.5,
    seed: { workerFailures: [{ worker: 1, commands: ["rm -rf /x"] }] },
  };
  const good = soloVariant(swarm, {
    task: { title: "t", description: "d" },
    outcome: {
      dimensions: [
        {
          name: "correctness",
          weight: 3,
          checks: [{ name: "c", fn: async () => ({ pass: true }) }],
        },
      ],
    },
  });

  test("soloVariant derives a valid pair and drops the failure injection", () => {
    expect(good.id).toBe(soloVariantId("swarm-x"));
    expect(good.seed).toBeUndefined();
    expect(validateBaselinePairs([swarm, good])).toEqual([]);
  });

  test.each<[string, Partial<Scenario>, RegExp]>([
    ["a different budget", { budgetUsd: 1 }, /budgetUsd 1 differs/],
    ["a different timeout", { timeoutMs: 1 }, /timeoutMs 1 differs/],
    ["a different version", { version: 3 }, /version 3 differs/],
    ["a lead", { lead: {} }, /must not have a lead/],
    ["two workers", { workers: 2 }, /exactly 1 worker/],
    [
      "a worker failure",
      { seed: { workerFailures: [{ worker: 0, commands: [] }] } },
      /worker failures/,
    ],
    ["a wrong id", { id: "swarm-x-baseline" }, /must be named "swarm-x-solo"/],
    ["an unknown swarm id", { baselineOf: "nope" }, /not a registered scenario/],
    [
      "a dimension the swarm lacks",
      { outcome: { dimensions: [{ name: "speed", weight: 1, checks: [] }] } },
      /"speed" does not exist/,
    ],
    [
      "a re-weighted dimension",
      { outcome: { dimensions: [{ name: "correctness", weight: 1, checks: [] }] } },
      /weight 1 differs/,
    ],
  ])("rejects %s", (_label, override, message) => {
    const errors = validateBaselinePairs([swarm, { ...good, ...override }]);
    expect(errors.join("\n")).toMatch(message);
  });

  test("rejects a baseline of a scenario that has no lead", () => {
    const { lead: _lead, ...leadless } = swarm;
    expect(validateBaselinePairs([leadless, good]).join("\n")).toMatch(/has no lead/);
  });
});
