import { describe, expect, test } from "bun:test";
import { formatShowCell } from "./cli.ts";
import type { CellSummary } from "./results.ts";

/**
 * Synthetic-render coverage for the `show` matrix cell (Phase 3 QA item).
 *
 * No prior local eval run DB exists (the active `evals-replica.db` has no `runs`
 * table, and the only other local DB is the API's agent-swarm-db.sqlite — not an
 * evals run DB). So instead of `bun src/cli.ts show <runId>`, we drive the
 * cell-rendering function directly with synthetic multi-attempt CellSummaries and
 * assert the `mean ±halfCI` + pass-rate + ✓/~/✗ threshold-vs-CI output.
 */
const PASS_THRESHOLD = 0.75;

function cell(partial: Partial<CellSummary>): CellSummary {
  return {
    scenarioId: "delegation-probe",
    configId: "claude-opus-4.8",
    attempts: 5,
    finished: 5,
    passedAny: true,
    passedFirst: true,
    bestScore: 0.92,
    avgScore: 0.78,
    meanScore: 0.78,
    scoreCI: { lo: 0.72, hi: 0.84, method: "bootstrap" },
    passRate: 0.8,
    passRateCI: { lo: 0.38, hi: 0.96 },
    totalCostUsd: 1.2,
    avgDurationMs: 60_000,
    errors: 0,
    passed: 4,
    pricedAttempts: 5,
    avgCostUsd: 0.24,
    ...partial,
  };
}

describe("formatShowCell — Phase 3 mean±CI render", () => {
  test("renders `mean ±halfCI · pass-rate%` headline", () => {
    const out = formatShowCell(cell({}), PASS_THRESHOLD, false);
    // mean 0.78, halfCI = (0.84-0.72)/2 = 0.06, pass-rate 80%.
    expect(out).toContain("0.78 ±0.06");
    expect(out).toContain("80%");
  });

  test("✓ when scoreCI.lo ≥ passThreshold", () => {
    const out = formatShowCell(
      cell({ scoreCI: { lo: 0.76, hi: 0.9, method: "bootstrap" }, meanScore: 0.83 }),
      PASS_THRESHOLD,
      false,
    );
    expect(out.startsWith("✓")).toBe(true);
  });

  test("~ when the CI straddles the threshold", () => {
    const out = formatShowCell(
      cell({ scoreCI: { lo: 0.72, hi: 0.84, method: "bootstrap" }, meanScore: 0.78 }),
      PASS_THRESHOLD,
      false,
    );
    expect(out.startsWith("~")).toBe(true);
  });

  test("✗ when scoreCI.hi < passThreshold", () => {
    const out = formatShowCell(
      cell({ scoreCI: { lo: 0.3, hi: 0.5, method: "bootstrap" }, meanScore: 0.4, passRate: 0.2 }),
      PASS_THRESHOLD,
      false,
    );
    expect(out.startsWith("✗")).toBe(true);
  });

  test("--detail appends best@n / pass@1 (hidden by default)", () => {
    const plain = formatShowCell(cell({}), PASS_THRESHOLD, false);
    const detailed = formatShowCell(cell({}), PASS_THRESHOLD, true);
    expect(plain).not.toContain("best");
    expect(detailed).toContain("best 0.92");
    expect(detailed).toContain("@1 ✓");
  });

  test("no scored attempts → `· n/a` with error count", () => {
    const out = formatShowCell(
      cell({ meanScore: null, scoreCI: null, passRate: null, passRateCI: null, errors: 2 }),
      PASS_THRESHOLD,
      false,
    );
    expect(out).toContain("n/a");
    expect(out).toContain("E2");
  });
});
