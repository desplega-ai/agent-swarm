import { describe, expect, test } from "bun:test";
import {
  buildFrontierDots,
  defaultHarness,
  effortShape,
  effortsByConfig,
  type FrontierResponse,
  frontierLine,
  frontierPicks,
  type LeaderboardResponse,
  logTicks,
  rankSortValue,
  scoreDomain,
  timeTicks,
  trackConfigIds,
} from "../ui/src/lib/suite-analytics.ts";
import type { AnalyticsSourceRow } from "./api/analytics.ts";
import { buildFrontier, buildLeaderboard } from "./api/suite-analytics.ts";
import type { Registry } from "./runner/index.ts";

const registry: Registry = {
  scenarios: new Map(),
  configs: new Map([
    ["claude-cheap", { id: "claude-cheap", provider: "claude", model: "claude-haiku-4-5" }],
    ["claude-best", { id: "claude-best", provider: "claude", model: "claude-opus-5-5" }],
    ["claude-bad", { id: "claude-bad", provider: "claude", model: "claude-sonnet-5-5" }],
    ["codex-part", { id: "codex-part", provider: "codex", model: "gpt-6-luna" }],
  ]),
};

const SCENARIOS = ["s1", "s2", "s3"];

function rows(
  configId: string,
  o: { score: number; cost: number | null; agentMs: number | null; effort?: string; n?: number },
  scenarios = SCENARIOS,
): AnalyticsSourceRow[] {
  return scenarios.flatMap((scenarioId) =>
    Array.from({ length: o.n ?? 3 }, (_, i) => ({
      runId: "run-1",
      scenarioId,
      configId,
      status: o.score >= 0.7 ? "passed" : "failed",
      exclusion: null,
      // spread the scores a little so the bootstrap interval has a width
      score: Math.min(1, o.score + (i - 1) * 0.02),
      costUsd: o.cost,
      costSource: null,
      judgeCostUsd: 0.01,
      durationMs: 100_000,
      agentMs: o.agentMs,
      resolvedModel: null,
      reasoningEffort: o.effort ?? null,
      suiteVersion: "1.0",
      tokenModel: null,
      tokenInput: 1000,
      tokenOutput: 0,
      tokenCacheRead: 0,
      tokenCacheWrite: 0,
      apiVersion: null,
      workerVersion: null,
      runName: "run-1",
      runCreatedAt: "2026-09-30T00:00:00Z",
    })),
  );
}

const ALL_ROWS = [
  ...rows("claude-cheap", { score: 0.8, cost: 0.02, agentMs: 30_000 }),
  ...rows("claude-best", { score: 0.95, cost: 0.4, agentMs: 90_000, effort: "high" }),
  // dominated: costs more and scores less than claude-best... and is slower
  ...rows("claude-bad", { score: 0.7, cost: 0.5, agentMs: 120_000, effort: "low" }),
  // partial coverage: one scenario only
  ...rows("codex-part", { score: 0.99, cost: 0.01, agentMs: 10_000 }, ["s1"]),
];

const input = {
  rows: ALL_ROWS,
  registry,
  suiteVersion: "1.0",
  expectedScenarioIds: SCENARIOS,
  generatedAt: "2026-09-30T12:00:00.000Z",
};

// Assigning the server payloads to the UI's mirrored types is the drift guard: a field
// renamed or retyped server-side stops compiling here (`bun run tsc:check`).
const frontier: FrontierResponse = buildFrontier(input);
const board: LeaderboardResponse = buildLeaderboard(input, 3);

describe("effortShape", () => {
  test("one shape per effort band, circle for default and mixed", () => {
    expect(effortShape([])).toBe("circle");
    expect(effortShape(["default"])).toBe("circle");
    expect(effortShape(["default", "high"])).toBe("circle");
    expect(effortShape(["low"])).toBe("triangle");
    expect(effortShape(["medium"])).toBe("square");
    expect(effortShape(["high"])).toBe("diamond");
    expect(effortShape(["xhigh"])).toBe("diamond");
  });
});

describe("buildFrontierDots (server payload in, chart dots out)", () => {
  const dots = (axis: "cost" | "time", visible: Set<string> | null = null) =>
    buildFrontierDots(frontier, axis, effortsByConfig(board), visible);

  test("frontier members are flagged and the dominated config is not", () => {
    const { dots: d } = dots("cost");
    const onFrontier = d.filter((x) => x.onFrontier).map((x) => x.configId);
    expect(onFrontier).toContain("claude-best");
    expect(onFrontier).toContain("claude-cheap");
    expect(onFrontier).not.toContain("claude-bad");
    expect(onFrontier).not.toContain("codex-part");
  });

  test("a partial-coverage config is plotted but hollow, with the reason", () => {
    const part = dots("cost").dots.find((x) => x.configId === "codex-part");
    expect(part?.hollow).toBe(true);
    expect(part?.hollowReasons.join(" ")).toContain("1 of 3 scenarios");
  });

  test("full-coverage configs with enough attempts are solid", () => {
    const best = dots("cost").dots.find((x) => x.configId === "claude-best");
    expect(best?.hollow).toBe(false);
    expect(best?.ciLo).not.toBeNull();
    expect(best?.shape).toBe("diamond");
  });

  test("a collapsed interval draws no whisker", () => {
    const flat: FrontierResponse = {
      ...frontier,
      points: frontier.points.map((p) => ({ ...p, scoreCi: { lo: p.score, hi: p.score } })),
    };
    for (const d of buildFrontierDots(flat, "cost", new Map(), null).dots) {
      expect(d.ciLo).toBeNull();
      expect(d.ciHi).toBeNull();
    }
  });

  test("a config with no reading on the axis is listed, not plotted", () => {
    const missing: FrontierResponse = {
      ...frontier,
      points: frontier.points.map((p) =>
        p.configId === "claude-cheap" ? { ...p, avgCostUsd: null } : p,
      ),
    };
    const out = buildFrontierDots(missing, "cost", new Map(), null);
    expect(out.unplotted).toEqual(["claude-cheap"]);
    expect(out.dots.some((d) => d.configId === "claude-cheap")).toBe(false);
    // the time axis still has it
    expect(buildFrontierDots(missing, "time", new Map(), null).unplotted).toEqual([]);
  });

  test("dots outside the visible track are dimmed", () => {
    const out = dots("cost", new Set(["claude-best"]));
    expect(out.dots.find((d) => d.configId === "claude-best")?.dim).toBe(false);
    expect(out.dots.find((d) => d.configId === "claude-cheap")?.dim).toBe(true);
  });

  test("the line is the frontier left to right", () => {
    const { dots: d } = dots("cost");
    const line = frontierLine(d, frontier.frontier.cost);
    expect(line.map((x) => x.configId)).toEqual(["claude-cheap", "claude-best"]);
    expect(line[0]?.x).toBeLessThan(line[1]?.x ?? 0);
  });
});

describe("leaderboard helpers", () => {
  test("track membership follows the selected track", () => {
    expect(trackConfigIds(board, "fixed", "claude")).toEqual(
      new Set(["claude-cheap", "claude-best", "claude-bad"]),
    );
    expect(trackConfigIds(board, "fixed", "nope").size).toBe(0);
    // best-harness-per-model has one row per model
    expect(trackConfigIds(board, "free", null).size).toBe(
      board.tracks.bestHarnessPerModel.rows.length,
    );
  });

  test("the fixed-harness table opens on the harness with the best score", () => {
    // codex-part has the highest raw score but a claude config ranks; best score wins.
    expect(defaultHarness(board)).toBe("codex");
    expect(defaultHarness({ ...board, tracks: { ...board.tracks, fixedHarness: [] } })).toBeNull();
  });

  test("ranked rows sort before unranked, unranked by score", () => {
    const all = board.tracks.fixedHarness.flatMap((g) => g.rows);
    const ranked = all.filter((r) => r.rank !== null);
    const unranked = all.filter((r) => r.rank === null);
    expect(ranked.length).toBeGreaterThan(0);
    expect(unranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      for (const u of unranked) expect(rankSortValue(r)).toBeLessThan(rankSortValue(u));
    }
  });
});

describe("frontierPicks", () => {
  test("names the best score, the cheapest and the fastest frontier config", () => {
    const picks = frontierPicks(frontier);
    expect(picks.map((p) => p.label)).toEqual([
      "Highest score",
      "Cheapest on the frontier",
      "Fastest on the frontier",
    ]);
    expect(picks[0]?.configId).toBe("claude-best");
    expect(picks[1]?.configId).toBe("claude-cheap");
    expect(picks[2]?.configId).toBe("claude-cheap");
  });

  test("no frontier, no picks (partial data never names a best setup)", () => {
    const partial = buildFrontier({
      ...input,
      rows: rows("codex-part", { score: 0.9, cost: 0.1, agentMs: 1000 }, ["s1"]),
    });
    expect(partial.status).toBe("no-full-coverage");
    expect(frontierPicks(partial)).toEqual([]);
  });
});

describe("axis helpers", () => {
  test("logTicks puts 1, 2 and 5 per decade inside the range", () => {
    expect(logTicks(0.03, 0.6)).toEqual([0.05, 0.1, 0.2, 0.5]);
    expect(logTicks(0, 1)).toEqual([]);
  });

  test("timeTicks use round durations and fall back to log ticks", () => {
    expect(timeTicks(8_000, 70_000)).toEqual([10_000, 15_000, 30_000, 45_000, 60_000]);
    expect(timeTicks(11_000, 14_000)).toEqual(logTicks(11_000, 14_000));
  });

  test("scoreDomain zooms to the data on 0.05 steps and stays inside 0..1", () => {
    const d = (y: number, lo: number | null = null, hi: number | null = null) =>
      ({ y, ciLo: lo, ciHi: hi }) as Parameters<typeof scoreDomain>[0][number];
    expect(scoreDomain([])).toEqual({ lo: 0, hi: 1 });
    expect(scoreDomain([d(0.88, 0.85, 0.9), d(0.95)])).toEqual({ lo: 0.8, hi: 1 });
    const one = scoreDomain([d(0.5)]);
    expect(one.hi - one.lo).toBeGreaterThanOrEqual(0.1);
    expect(one.lo).toBeGreaterThanOrEqual(0);
    expect(scoreDomain([d(1, 0.99, 1)]).hi).toBe(1);
  });
});
