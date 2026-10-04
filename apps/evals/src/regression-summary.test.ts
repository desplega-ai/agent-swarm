import { describe, expect, test } from "bun:test";
import { evaluateRegression, type RegressionAttempt } from "./regression.ts";
import { formatRunFailureSummary, formatRunSummary, presetLabel } from "./regression-summary.ts";

const run = {
  id: "run-1",
  name: "Nightly 2026-10-01",
  preset: "nightly-canary",
  status: "done",
  maxMeteredUsd: 2,
  url: "https://evals.example.test/#/runs/run-1",
};

function attempt(
  runId: string,
  configId: string,
  scenarioId: string,
  status: "passed" | "failed" | "error",
  o: Partial<RegressionAttempt> = {},
): RegressionAttempt {
  return {
    runId,
    scenarioId,
    configId,
    status,
    exclusion: null,
    score: status === "error" ? null : status === "passed" ? 0.9 : 0.2,
    scenarioVersion: 1,
    resolvedModel: "m1",
    meteredUsd: 0.05,
    notionalUsd: 0.1,
    error: null,
    ...o,
  };
}

const cell = (
  runId: string,
  configId: string,
  scenarioId: string,
  results: Array<"passed" | "failed" | "error">,
  o: Partial<RegressionAttempt> = {},
) => results.map((r) => attempt(runId, configId, scenarioId, r, o));

const nights = (configId: string, scenarioId: string, n = 14) =>
  Array.from({ length: n }, (_, i) =>
    cell(`night-${i}`, configId, scenarioId, ["passed", "passed", "passed"]),
  ).flat();

describe("formatRunSummary", () => {
  test("a clean run: headline, run line with cost and cap, and a scenario x config table", () => {
    const report = evaluateRegression({
      current: [
        ...cell("r", "opus", "sql-audit", ["passed", "passed", "passed"]),
        ...cell("r", "luna", "sql-audit", ["passed", "passed", "passed"]),
        ...cell("r", "opus", "tool-routing", ["passed", "passed", "failed"]),
        ...cell("r", "luna", "tool-routing", ["passed", "passed", "passed"]),
      ],
      baseline: [
        ...nights("opus", "sql-audit"),
        ...nights("luna", "sql-audit"),
        ...nights("opus", "tool-routing"),
        ...nights("luna", "tool-routing"),
      ],
    });
    const text = formatRunSummary(run, report, ["sql-audit", "tool-routing"]);
    expect(text.split("\n")[0]).toBe(":white_check_mark: *Nightly canary: clean*");
    expect(text).toContain(
      "<https://evals.example.test/#/runs/run-1|Nightly 2026-10-01> · 12 attempts: 11 passed, 1 failed, 0 errored · $0.60 metered of $2.00 cap · $1.20 notional",
    );
    const lines = text.split("\n");
    const start = lines.indexOf("```");
    expect(lines.slice(start, start + 5)).toEqual([
      "```",
      "scenario      opus  luna",
      "sql-audit     3/3   3/3",
      "tool-routing  2/3   3/3",
      "```",
    ]);
    expect(text).not.toContain("*Flags*");
    expect(text).not.toContain("*Pages*");
  });

  test("a page lists the cell, cost drift, model changes and infra errors", () => {
    const report = evaluateRegression({
      current: [
        ...cell("r", "opus", "sql-audit", ["failed", "failed", "failed"]),
        ...cell("r", "luna", "sql-audit", ["passed", "passed", "passed"], {
          resolvedModel: "m2",
          meteredUsd: 9,
        }),
        attempt("r", "luna", "tool-routing", "error", {
          error: "429 rate limit",
          resolvedModel: "m2",
        }),
        attempt("r", "opus", "tool-routing", "error", {
          exclusion: "cancelled",
          error: "cost cap",
        }),
      ],
      baseline: [...nights("opus", "sql-audit"), ...nights("luna", "sql-audit")],
    });
    const text = formatRunSummary(run, report, ["sql-audit", "tool-routing"]);
    expect(text.split("\n")[0]).toBe(":rotating_light: *Nightly canary: PAGE*");
    expect(text).toContain(
      "*Pages*\n• sql-audit × opus: 0/3 passed vs 100% baseline: every attempt failed",
    );
    expect(text).toContain(
      "*Model changes*\n• luna: m1 → m2; the baseline restarts, nothing is compared",
    );
    expect(text).toContain("*Infra*");
    expect(text).toContain("luna: 1 of 4 attempts errored (1 read as rate limits)");
    expect(text).toContain("1 attempts were cancelled before they ran");
    expect(text).toContain("0/3 PAGE");
  });

  test("cost drift is called out per config", () => {
    const report = evaluateRegression({
      current: cell("r", "opus", "sql-audit", ["passed"], { meteredUsd: 5, notionalUsd: 5 }),
      baseline: Array.from({ length: 5 }, (_, i) =>
        attempt(`night-${i}`, "opus", "sql-audit", "passed", { meteredUsd: 1, notionalUsd: 1 }),
      ),
    });
    const text = formatRunSummary(run, report);
    expect(text).toContain("*Cost drift*");
    expect(text).toContain("opus: metered $5.00 vs $1.00 median (over 1.5x)");
    expect(text).toContain("opus: notional $5.00 vs $1.00 median (over 1.5x)");
    expect(text.split("\n")[0]).toBe(":warning: *Nightly canary: flags to look at*");
  });

  test("a young baseline says it is still building", () => {
    const report = evaluateRegression({
      current: cell("r", "opus", "sql-audit", ["passed", "passed", "passed"]),
      baseline: [],
    });
    expect(formatRunSummary(run, report)).toContain("_Baseline still building for 1 of 1 cells._");
  });
});

describe("formatRunFailureSummary and presetLabel", () => {
  test("names the state and says no check ran", () => {
    const text = formatRunFailureSummary(
      { ...run, status: "cancelled" },
      { attempts: 54, passed: 10, errors: 4, cancelled: 40 },
    );
    expect(text).toBe(
      [
        ":x: *Nightly canary: run cancelled*",
        "<https://evals.example.test/#/runs/run-1|Nightly 2026-10-01> · 54 attempts: 10 passed, 4 errored, 40 cancelled. No regression check ran.",
      ].join("\n"),
    );
  });

  test("labels known presets and passes others through", () => {
    expect(presetLabel("weekly-matrix")).toBe("Weekly matrix");
    expect(presetLabel("custom")).toBe("custom");
  });
});
