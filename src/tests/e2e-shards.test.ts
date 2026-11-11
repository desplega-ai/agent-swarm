import { describe, expect, test } from "bun:test";
import { EMPTY_MANIFEST, emptyCoverage } from "../../scripts/e2e/coverage";
import { mergeShardResults, type ShardFile } from "../../scripts/e2e/merge";
import { type E2eResult, markdownSummary, parseOptions } from "../../scripts/e2e/report";
import { bandOf, bandProblems, type Observations, parseShard } from "../../scripts/e2e/shard";

describe("shard bands", () => {
  test("cuts at 130 and 140", () => {
    expect([10, 126, 129.5, 130, 136.5, 139, 140, 690].map(bandOf)).toEqual([
      1, 1, 1, 2, 2, 2, 3, 3,
    ]);
  });

  test("--shard takes i/3 only", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, total: 3 });
    for (const bad of ["0/3", "4/3", "1/2", "1", "a/3"]) expect(() => parseShard(bad)).toThrow();
  });

  test("a shard cannot gate coverage or run harness legs", () => {
    expect(() => parseOptions(["--shard", "1/3", "--strict"], [])).toThrow();
    expect(() => parseOptions(["--shard", "1/3", "--min-route-coverage", "5"], [])).toThrow();
    expect(() => parseOptions(["--shard", "1/3", "--harness", "pi"], [])).toThrow();
    expect(parseOptions([], []).shard).toBeUndefined();
  });

  test("a need across a cut is reported", () => {
    const scenarios = [
      { name: "a", order: 120 },
      { name: "b", order: 135, needs: ["a"] },
      { name: "c", order: 136, needs: ["b"] },
    ];
    expect(bandProblems(scenarios)).toHaveLength(1);
    expect(bandProblems(scenarios)[0]).toContain("b (shard 2) needs a (shard 1)");
  });
});

const universe = { routes: ["GET /api/a", "GET /api/b"], nodeTypes: ["script"] };

function shard(index: number, observed: Partial<Observations>, ok = true): ShardFile {
  const result: E2eResult = {
    startedAt: `2026-11-11T00:00:0${index}.000Z`,
    durationMs: index * 1000,
    scenarios: [{ name: `s${index}`, status: index === 2 ? "flaky" : "pass", durationMs: 1 }],
    harness: [],
    coverage: emptyCoverage(),
    gates: { minRouteCoverage: 0, minToolCoverage: 0, strict: false, failures: [], passed: true },
    shard: {
      index,
      total: 3,
      observations: {
        universe,
        knownScenarios: ["s1", "s2", "s3"],
        calls: [],
        toolUniverse: ["t1", "t2"],
        calledTools: [],
        nodeTypes: [],
        stateValues: {},
        ...observed,
      },
    },
    ok,
  };
  return { path: `shard-${index}.json`, result };
}

const call = (path: string) => ({ method: "GET", path, status: 200, durationMs: 1 });
const strict = { strict: true, minRouteCoverage: 100, minToolCoverage: 100 };

describe("merge", () => {
  const shards = [
    shard(1, { calls: [call("/api/a")], calledTools: ["t1"] }),
    shard(2, { calls: [call("/api/b")], nodeTypes: ["script"] }),
    shard(3, { calledTools: ["t2"] }),
  ];

  test("strict passes on the union when no shard covers everything alone", () => {
    const merged = mergeShardResults(shards, EMPTY_MANIFEST, [], "2026-11-11", strict);
    expect(merged.mergeProblems).toEqual([]);
    expect(merged.gates.failures).toEqual([]);
    expect(merged.ok).toBe(true);
    expect(merged.coverage.routes.covered).toBe(2);
    expect(merged.coverage.mcpTools.covered).toBe(2);
    expect(merged.durationMs).toBe(3000);
    expect(merged.scenarios.map((s) => s.status)).toEqual(["pass", "flaky", "pass"]);
    expect(markdownSummary(merged)).toContain("| 2/3 | PASS | 1 | 2.0s |");
  });

  test("a missing, duplicate or failed shard fails the merge", () => {
    const missing = mergeShardResults(
      [shards[0]!, shards[1]!, { path: "shard-3.json", error: "missing" }],
      EMPTY_MANIFEST,
      [],
      "2026-11-11",
      strict,
    );
    expect(missing.ok).toBe(false);
    expect(missing.mergeProblems).toContain("shard 3/3: 0 results, want 1");
    expect(missing.gates.failures.join("\n")).toContain("t2");

    const duplicate = mergeShardResults(
      [shards[0]!, shards[0]!, shards[1]!, shards[2]!],
      EMPTY_MANIFEST,
      [],
      "2026-11-11",
      strict,
    );
    expect(duplicate.mergeProblems).toContain("shard 1/3: 2 results, want 1");

    const failed = mergeShardResults(
      [shards[0]!, shards[1]!, shard(3, { calledTools: ["t2"] }, false)],
      EMPTY_MANIFEST,
      [],
      "2026-11-11",
      strict,
    );
    expect(failed.ok).toBe(false);
    expect(failed.mergeProblems).toContain("shard 3/3 failed");
  });

  test("an expired quarantine entry fails the merged run", () => {
    const merged = mergeShardResults(
      shards,
      EMPTY_MANIFEST,
      [{ scenario: "s1", owner: "o", reason: "r", expires: "2026-11-01" }],
      "2026-11-11",
      strict,
    );
    expect(merged.ok).toBe(false);
    expect(merged.quarantine?.problems[0]).toContain("expired");
  });
});
