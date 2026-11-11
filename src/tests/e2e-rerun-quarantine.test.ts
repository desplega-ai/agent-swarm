import { describe, expect, test } from "bun:test";
import { computeCoverage, EMPTY_MANIFEST } from "../../scripts/e2e/coverage";
import type { ApiClient } from "../../scripts/e2e/http";
import {
  loadQuarantine,
  parseQuarantine,
  QUARANTINE_PATH,
  quarantineProblems,
} from "../../scripts/e2e/quarantine";
import {
  type E2eResult,
  failsRun,
  markdownSummary,
  type ScenarioResult,
  statusLabel,
} from "../../scripts/e2e/report";
import { rerunPlan, settleRerun } from "../../scripts/e2e/rerun";

const entry = {
  scenario: "auth",
  owner: "picateclas",
  reason: "socket race",
  expires: "2026-11-20",
};

describe("quarantine file", () => {
  test("ships empty", async () => {
    expect(await loadQuarantine(QUARANTINE_PATH)).toEqual([]);
  });

  test("parses a valid entry and rejects malformed ones", () => {
    expect(parseQuarantine([entry])).toEqual([entry]);
    expect(() => parseQuarantine({})).toThrow("JSON array");
    expect(() => parseQuarantine([{ ...entry, owner: "" }])).toThrow('"owner"');
    expect(() => parseQuarantine([{ ...entry, expires: "next week" }])).toThrow("YYYY-MM-DD");
    expect(() => parseQuarantine([{ ...entry, expires: "2026-13-45" }])).toThrow("YYYY-MM-DD");
  });

  test("an expired, unknown or duplicate entry fails the run", () => {
    const known = new Set(["auth", "tasks"]);
    expect(quarantineProblems([entry], known, "2026-11-20")).toEqual([]);
    expect(quarantineProblems([entry], known, "2026-11-21")).toEqual([
      "quarantine for auth expired on 2026-11-20 (owner picateclas): fix the scenario or extend the entry",
    ]);
    expect(quarantineProblems([{ ...entry, scenario: "atuh" }], known, "2026-11-01")).toEqual([
      "quarantine entry atuh matches no scenario",
    ]);
    expect(quarantineProblems([entry, entry], known, "2026-11-01")).toEqual([
      "quarantine lists auth twice",
    ]);
  });
});

describe("rerun", () => {
  const all = [
    { name: "a", order: 10 },
    { name: "b", order: 20, needs: ["a"] },
    { name: "c", order: 30 },
    { name: "d", order: 40, needs: ["b"] },
  ];

  test("plan replays declared needs transitively, in run order, then the scenario", () => {
    expect(rerunPlan(all[3]!, all).map((s) => s.name)).toEqual(["a", "b", "d"]);
    expect(rerunPlan(all[2]!, all).map((s) => s.name)).toEqual(["c"]);
    expect(() => rerunPlan({ name: "x", order: 50, needs: ["zz"] }, all)).toThrow("unknown");
  });

  const first: ScenarioResult = { name: "a", status: "fail", durationMs: 1000, error: "timeout" };

  test("pass on rerun is flaky and keeps the first error", () => {
    const settled = settleRerun(first, { name: "a", status: "pass", durationMs: 500 });
    expect(settled.status).toBe("flaky");
    expect(settled.error).toBe("timeout");
    expect(settled.durationMs).toBe(1500);
    expect(settled.attempts?.map((a) => a.status)).toEqual(["fail", "pass"]);
    expect(failsRun(settled)).toBe(false);
  });

  test("fail or skip on rerun stays fail with the rerun error", () => {
    for (const status of ["fail", "skip"] as const) {
      const settled = settleRerun(first, { name: "a", status, durationMs: 5, error: "again" });
      expect(settled.status).toBe("fail");
      expect(settled.error).toBe("again");
      expect(failsRun(settled)).toBe(true);
    }
  });

  test("a rerun that could not boot keeps the first failure", () => {
    const settled = settleRerun(first, { error: "API did not boot" });
    expect(settled.status).toBe("fail");
    expect(settled.error).toBe("timeout; rerun did not run: API did not boot");
    expect(settled.attempts).toHaveLength(2);
  });

  test("a quarantined failure does not fail the run", () => {
    const quarantined = {
      ...first,
      quarantine: { owner: "o", reason: "r", expires: "2026-12-01" },
    };
    expect(failsRun(quarantined)).toBe(false);
    expect(statusLabel(quarantined)).toBe("FAIL (quarantined)");
    expect(statusLabel({ ...quarantined, status: "pass" })).toBe("PASS");
  });
});

describe("reports and flows", () => {
  const fakeApi: ApiClient = async (_method, path) => {
    const json = path === "/openapi.json" ? { paths: {} } : { executorTypes: [] };
    return { status: 200, json, text: JSON.stringify(json), headers: new Headers() };
  };

  async function flowStatus(scenarios: ScenarioResult[]) {
    const coverage = await computeCoverage(fakeApi, {
      calls: [],
      toolUniverse: new Set(),
      calledTools: new Set(),
      observedNodeTypes: new Set(),
      scenarios,
      knownScenarios: new Set(scenarios.map((s) => s.name)),
      queryValues: () => [],
      manifest: { ...EMPTY_MANIFEST, flows: { f: { description: "f", scenarios: ["a"] } } },
    });
    return coverage.flows[0]?.status;
  }

  test("a flaky or quarantined scenario does not fail its flow; a plain failure does", async () => {
    expect(await flowStatus([{ name: "a", status: "flaky", durationMs: 1 }])).toBe("pass");
    expect(
      await flowStatus([
        {
          name: "a",
          status: "fail",
          durationMs: 1,
          quarantine: { owner: "o", reason: "r", expires: "2026-12-01" },
        },
      ]),
    ).toBe("pass");
    expect(await flowStatus([{ name: "a", status: "fail", durationMs: 1 }])).toBe("fail");
  });

  test("summary shows FLAKY, attempts and quarantine problems", () => {
    const empty = { total: 0, covered: 0, excluded: 0, percent: 100, uncovered: [] };
    const result: E2eResult = {
      startedAt: "2026-11-11T00:00:00.000Z",
      durationMs: 1,
      sut: { port: 1, dbPath: "/tmp/x", logPath: "/tmp/y" },
      scenarios: [
        {
          ...settleRerun(
            { name: "a", status: "fail", durationMs: 1, error: "boom" },
            { name: "a", status: "pass", durationMs: 1 },
          ),
        },
      ],
      harness: [],
      coverage: {
        engines: [],
        routes: { ...empty, byGroup: {}, unknown: [] },
        mcpTools: { ...empty },
        nodeTypes: { ...empty },
        stateSurfaces: [],
        flows: [],
        scenariosWithoutFlow: [],
        staleExclusions: [],
        deadExclusions: [],
        unknownFlowScenarios: [],
        latency: { byGroup: {}, overall: { count: 0, p50: 0, p95: 0, max: 0 } },
      },
      quarantine: { entries: [], problems: ["quarantine for b expired on 2026-11-01"] },
      gates: { minRouteCoverage: 0, minToolCoverage: 0, strict: false, failures: [], passed: true },
      ok: false,
    };
    const markdown = markdownSummary(result);
    expect(markdown).toContain("| a | FLAKY | 2 |");
    expect(markdown).toContain("Flaky (passed on rerun): a");
    expect(markdown).toContain("- quarantine for b expired on 2026-11-01");
  });
});
