import { describe, expect, test } from "bun:test";
import {
  buildNightlyReport,
  DEFAULT_PROVIDERS,
  type NightlyReport,
  nightlyMarkdown,
} from "../../scripts/e2e/nightly-report";
import type { E2eResult, HarnessResult } from "../../scripts/e2e/report";

const coverage: E2eResult["coverage"] = {
  routes: { total: 352, covered: 16, percent: 4.5, byGroup: {}, uncovered: [], unknown: [] },
  mcpTools: { total: 114, covered: 4, percent: 3.5, uncovered: [] },
};

function contractResult(ok = true): E2eResult {
  return {
    startedAt: "2026-09-04T03:23:00.000Z",
    durationMs: 5_000,
    sut: { port: 1, dbPath: "/tmp/db", logPath: "/tmp/log" },
    scenarios: [
      { name: "health", status: "pass", durationMs: 2 },
      {
        name: "auth",
        status: ok ? "pass" : "fail",
        durationMs: 17,
        error: ok ? undefined : "boom",
      },
    ],
    harness: [],
    coverage,
    gates: { minRouteCoverage: 3, minToolCoverage: 2, passed: true },
    ok,
  };
}

function leg(provider: string, overrides: Partial<HarnessResult> = {}): HarnessResult {
  const cost = {
    records: 1,
    totalUsd: 0.0123,
    inputTokens: 1000,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costSource: "harness",
  };
  return {
    provider,
    model: `${provider}-model`,
    status: "pass",
    durationMs: 9_000,
    attempts: [{ status: "pass", durationMs: 9_000, cost }],
    cost,
    totalCostUsd: cost.totalUsd,
    ...overrides,
  };
}

function harnessResult(legs: HarnessResult[]): E2eResult {
  return {
    ...contractResult(),
    scenarios: [{ name: "health", status: "pass", durationMs: 2 }],
    harness: legs,
  };
}

const base = {
  providers: DEFAULT_PROVIDERS,
  previous: [] as NightlyReport[],
  runId: "42",
  runUrl: "https://example.test/runs/42",
  sha: "abcdef1234567890",
  generatedAt: "2026-09-04T03:30:00.000Z",
  credentialWarnDays: 3,
};

describe("nightly report", () => {
  test("passes when the contract and every leg pass", () => {
    const report = buildNightlyReport({
      ...base,
      results: [
        contractResult(),
        ...DEFAULT_PROVIDERS.map((provider) => harnessResult([leg(provider)])),
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.missingLegs).toEqual([]);
    expect(report.totalCostUsd).toBeCloseTo(0.0492, 6);
    expect(report.warnings).toEqual([]);
    const markdown = nightlyMarkdown(report, [], DEFAULT_PROVIDERS);
    expect(markdown).toContain("## Nightly E2E: PASS");
    expect(markdown).toContain("4/4 harness legs passed");
    expect(markdown).toContain("| claude | claude-model | PASS | 1 |");
    expect(markdown).not.toContain("### Warnings");
  });

  test("fails on a missing leg and on a failed leg, with the log tail in details", () => {
    const failed = leg("codex", {
      status: "fail",
      error: "codex task finished with status failed",
      failureKind: "task",
      attempts: [
        {
          status: "fail",
          durationMs: 3_000,
          error: "codex task finished with status failed",
          failureKind: "task",
          logTail: "EACCES: permission denied, open 'AGENTS.md'",
        },
        {
          status: "fail",
          durationMs: 3_000,
          error: "codex task finished with status failed",
          failureKind: "task",
          logTail: "EACCES again",
        },
      ],
      cost: undefined,
      totalCostUsd: 0,
    });
    const report = buildNightlyReport({
      ...base,
      results: [contractResult(), harnessResult([leg("claude")]), harnessResult([failed])],
    });
    expect(report.ok).toBe(false);
    expect(report.missingLegs).toEqual(["pi", "opencode"]);
    expect(report.warnings).toContain("pi: no result file from the leg.");
    expect(report.warnings).toContain("codex: needed 2 attempts.");
    const markdown = nightlyMarkdown(report, [], DEFAULT_PROVIDERS);
    expect(markdown).toContain("## Nightly E2E: FAIL");
    expect(markdown).toContain("| codex | codex-model | FAIL | 2 |");
    expect(markdown).toContain("| pi | | MISSING |");
    expect(markdown).toContain("codex attempt 1: codex task finished with status failed (task)");
    expect(markdown).toContain("EACCES: permission denied");
  });

  test("warns on a missing cost record, an expiring credential, and a failed contract", () => {
    const codex = leg("codex", { credentialExpiresAt: "2026-09-06T00:00:00.000Z" });
    const opencode = leg("opencode", {
      cost: { ...leg("opencode").cost!, records: 0, totalUsd: 0 },
      totalCostUsd: 0,
    });
    const report = buildNightlyReport({
      ...base,
      results: [contractResult(false), harnessResult([leg("claude"), codex, leg("pi"), opencode])],
    });
    expect(report.ok).toBe(false);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("codex: the seeded OAuth access token expires in 1.9 days"),
    );
    expect(report.warnings).toContain(
      "opencode: the task passed but the API stored no cost record.",
    );
    const markdown = nightlyMarkdown(report, [], DEFAULT_PROVIDERS);
    expect(markdown).toContain("| auth | FAIL | boom |");
    expect(markdown).toContain("| opencode | opencode-model | PASS | 1 | 9.0s | no record |");
  });

  test("normalizes a legacy leg without attempts and orders the trend newest first", () => {
    const legacy = {
      provider: "claude",
      model: "m",
      status: "pass",
      durationMs: 1,
    } as HarnessResult;
    const older: NightlyReport = {
      ...buildNightlyReport({
        ...base,
        results: [contractResult(), harnessResult([leg("claude")])],
      }),
      runId: "41",
      runUrl: "https://example.test/runs/41",
      generatedAt: "2026-09-03T03:30:00.000Z",
    };
    const report = buildNightlyReport({
      ...base,
      previous: [older],
      results: [contractResult(), harnessResult([legacy])],
    });
    expect(report.harness[0]?.attempts).toHaveLength(1);
    expect(report.harness[0]?.totalCostUsd).toBe(0);
    const markdown = nightlyMarkdown(report, [older], DEFAULT_PROVIDERS);
    const rows = markdown.split("\n").filter((line) => line.startsWith("| [2026-09-0"));
    expect(rows[0]).toContain("[2026-09-04](https://example.test/runs/42)");
    expect(rows[1]).toContain("[2026-09-03](https://example.test/runs/41)");
    expect(rows[1]).toContain("$0.0123");
  });
});
