import { describe, expect, test } from "bun:test";
import { SUITE_VERSION } from "../../scenarios/suite.ts";
import { MAX_PASS_K } from "./suite-analytics.ts";
import {
  DEFAULT_MAX_K,
  mapSuitesResponse,
  parseSuiteQuery,
  runSuiteAnalytics,
} from "./suite-analytics-routes.ts";

const qs = (s: string) => new URLSearchParams(s);

describe("parseSuiteQuery", () => {
  test("defaults to the current suite with no filter", () => {
    const parsed = parseSuiteQuery("frontier", qs(""));
    expect(parsed).toEqual({
      ok: true,
      query: {
        suiteVersion: SUITE_VERSION,
        filter: { harnesses: [], configIds: [], efforts: [] },
        k: 3,
        maxK: DEFAULT_MAX_K,
        a: null,
        b: null,
      },
    });
  });

  test("reads suite and the CSV filters like /api/analytics", () => {
    const parsed = parseSuiteQuery(
      "heatmap",
      qs("suite=2.1&harnesses=pi, claude&configs=a,,b,a&efforts=high"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.suiteVersion).toBe("2.1");
    expect(parsed.query.filter).toEqual({
      harnesses: ["pi", "claude"],
      configIds: ["a", "b"],
      efforts: ["high"],
    });
  });

  test("rejects a suite that is not a plain version string", () => {
    for (const bad of ["../x", "1.0;drop", "a b", "-1", "x".repeat(40)]) {
      const parsed = parseSuiteQuery("frontier", new URLSearchParams({ suite: bad }));
      expect(parsed.ok).toBe(false);
    }
    expect(parseSuiteQuery("frontier", qs("suite=1.0-rc.1")).ok).toBe(true);
  });

  test("k is a leaderboard-only integer in 1..MAX_PASS_K", () => {
    const ok = parseSuiteQuery("leaderboard", qs("k=5"));
    expect(ok.ok && ok.query.k).toBe(5);
    for (const bad of ["0", "1.5", "abc", String(MAX_PASS_K + 1), "-2"]) {
      expect(parseSuiteQuery("leaderboard", new URLSearchParams({ k: bad })).ok).toBe(false);
    }
    // Other views ignore k rather than reject it.
    expect(parseSuiteQuery("frontier", qs("k=0")).ok).toBe(true);
  });

  test("maxK is a reliability-only integer in 1..MAX_PASS_K", () => {
    const ok = parseSuiteQuery("reliability", qs("maxK=8"));
    expect(ok.ok && ok.query.maxK).toBe(8);
    expect(parseSuiteQuery("reliability", qs("maxK=11")).ok).toBe(false);
  });

  test("compare needs two different config ids", () => {
    expect(parseSuiteQuery("compare", qs("a=x")).ok).toBe(false);
    expect(parseSuiteQuery("compare", qs("b=x")).ok).toBe(false);
    expect(parseSuiteQuery("compare", qs("a=x&b=x")).ok).toBe(false);
    const ok = parseSuiteQuery("compare", qs("a=x&b=y"));
    expect(ok.ok && [ok.query.a, ok.query.b]).toEqual(["x", "y"]);
  });
});

describe("runSuiteAnalytics", () => {
  test("dispatches each kind to its aggregator with the query's suite and filter", () => {
    const registry = { scenarios: new Map(), configs: new Map() };
    const run = (kind: Parameters<typeof runSuiteAnalytics>[0], q: string) => {
      const parsed = parseSuiteQuery(kind, qs(q));
      if (!parsed.ok) throw new Error(parsed.error);
      return runSuiteAnalytics(kind, parsed.query, { rows: [], registry }) as Record<
        string,
        unknown
      >;
    };
    expect(run("frontier", "suite=9.9")).toMatchObject({ suiteVersion: "9.9", status: "empty" });
    expect(run("leaderboard", "k=4")).toMatchObject({ k: 4 });
    expect(run("heatmap", "")).toMatchObject({ cells: [] });
    expect(run("reliability", "maxK=2")).toMatchObject({ maxK: 2, configs: [] });
    expect(run("compare", "a=x&b=y")).toMatchObject({ comparable: false });
  });
});

describe("mapSuitesResponse", () => {
  test("maps SQL rows and reports the code's current suite", () => {
    const res = mapSuitesResponse([
      {
        suite_version: "1.0",
        attempts: 12,
        runs: 2,
        configs: 3,
        first_run_at: "a",
        last_run_at: "b",
      },
    ]);
    expect(res).toEqual({
      current: SUITE_VERSION,
      suites: [
        { suiteVersion: "1.0", attempts: 12, runs: 2, configs: 3, firstRunAt: "a", lastRunAt: "b" },
      ],
    });
    expect(mapSuitesResponse([]).suites).toEqual([]);
  });
});
