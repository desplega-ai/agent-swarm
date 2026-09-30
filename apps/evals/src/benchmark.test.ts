import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenarios } from "../scenarios/index.ts";
import {
  HELD_OUT_SCENARIO_IDS,
  isHeldOut,
  publicSuiteScenarioIds,
  SUITE_SCENARIO_VERSIONS,
  SUITE_VERSION,
} from "../scenarios/suite.ts";
import type { AnalyticsSourceRow } from "./api/analytics.ts";
import { baselinePairs } from "./baseline.ts";
import {
  BENCHMARK_CANARY_GUID,
  type BenchmarkAttempt,
  buildSnapshot,
  bundleFiles,
  heldOutLeaks,
  MIN_ATTEMPTS_PER_CELL,
  type PublishInput,
  publishRefusals,
} from "./benchmark.ts";
import { graderValidationFailures, publishBenchmark } from "./benchmark-publish.ts";
import { getDb, initDb, resetDbForTests } from "./db/client.ts";
import { createRun, setRunStatus } from "./db/queries.ts";
import { loadRegistry } from "./registry.ts";
import type { AttemptRow, EvalRunRow, JudgmentRow } from "./types.ts";

const registry = loadRegistry();
const CONFIGS = ["claude-opus-5.5", "codex-6-luna"];
const RUN_ID = "run-matrix-test";
const SUITE_IDS = Object.keys(SUITE_SCENARIO_VERSIONS);
const SECRET_KEY = "swarm-key-must-not-leak";
const SECRET_URL = "https://sandbox-must-not-leak.e2b.example";

function run(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: RUN_ID,
    name: "weekly-matrix",
    status: "done",
    scenarioIds: [...SUITE_IDS],
    configIds: [...CONFIGS],
    attemptsPerCell: MIN_ATTEMPTS_PER_CELL,
    concurrency: 2,
    judgeModel: null,
    efforts: {},
    createdAt: "2026-09-30T00:00:00.000Z",
    finishedAt: "2026-09-30T06:00:00.000Z",
    ...overrides,
  };
}

function row(
  scenarioId: string,
  configId: string,
  i: number,
  over: Partial<AnalyticsSourceRow> = {},
): AnalyticsSourceRow {
  const score = configId === CONFIGS[0] ? 0.9 - i * 0.01 : 0.6 + i * 0.01;
  return {
    runId: RUN_ID,
    scenarioId,
    configId,
    status: score >= 0.75 ? "passed" : "failed",
    exclusion: null,
    score,
    costUsd: configId === CONFIGS[0] ? 0.4 : 0.1,
    costSource: "pricing",
    judgeCostUsd: 0.01,
    durationMs: 120_000,
    agentMs: 90_000 + i * 1000,
    resolvedModel: configId === CONFIGS[0] ? "claude-opus-5-5" : "gpt-6-luna",
    pinnedModel: null,
    reasoningEffort: null,
    tokenModel: null,
    tokenInput: 1000,
    tokenOutput: 500,
    tokenCacheRead: 0,
    tokenCacheWrite: 0,
    suiteVersion: SUITE_VERSION,
    apiVersion: "1.90.0",
    workerVersion: "1.90.0",
    runName: "weekly-matrix",
    runCreatedAt: "2026-09-30T00:00:00.000Z",
    ...over,
  };
}

function fullRows(n = MIN_ATTEMPTS_PER_CELL): AnalyticsSourceRow[] {
  return SUITE_IDS.flatMap((s) =>
    CONFIGS.flatMap((c) => Array.from({ length: n }, (_, i) => row(s, c, i))),
  );
}

function attempt(scenarioId: string, configId: string, i: number, score: number): BenchmarkAttempt {
  const pair = baselinePairs(scenarios).find(
    (p) => p.swarmId === scenarioId || p.soloId === scenarioId,
  );
  const judgments: Pick<JudgmentRow, "dimension" | "weight" | "score">[] = (
    pair?.dimensions ?? []
  ).map((dimension) => ({ dimension, weight: 1, score }));
  const a: AttemptRow = {
    id: `${RUN_ID}_${scenarioId}_${configId}_${i}`,
    runId: RUN_ID,
    scenarioId,
    configId,
    attemptIndex: i,
    status: score >= 0.75 ? "passed" : "failed",
    scenarioVersion: SUITE_SCENARIO_VERSIONS[scenarioId] ?? null,
    suiteVersion: SUITE_VERSION,
    exclusion: null,
    retries: 0,
    sandboxId: "sbx-must-not-leak",
    apiUrl: SECRET_URL,
    taskIds: [],
    score,
    passed: score >= 0.75,
    error: null,
    costUsd: 0.1,
    costSource: null,
    judgeCostUsd: 0.01,
    tokens: null,
    sandbox: {
      v: 2,
      apiSandboxId: "sbx-must-not-leak",
      apiTemplate: "swarm-api-template",
      apiUrl: SECRET_URL,
      swarmKey: SECRET_KEY,
      domain: null,
      apiStartedAt: null,
      apiVersion: "1.90.0",
      workers: [
        {
          index: 0,
          sandboxId: "sbx-worker-must-not-leak",
          template: "swarm-worker-template",
          agentId: "agent-0",
          startedAt: null,
          expiresAt: null,
          version: "1.90.0",
        },
      ],
    },
    timings: null,
    durationMs: 120_000,
    startedAt: null,
    finishedAt: null,
  };
  return { attempt: a, judgments };
}

function fullAttempts(): BenchmarkAttempt[] {
  return SUITE_IDS.flatMap((s) =>
    CONFIGS.flatMap((c) =>
      Array.from({ length: MIN_ATTEMPTS_PER_CELL }, (_, i) =>
        attempt(s, c, i, s.endsWith("-solo") ? 0.6 : 0.85),
      ),
    ),
  );
}

function input(over: Partial<PublishInput> = {}): PublishInput {
  return {
    suiteVersion: SUITE_VERSION,
    run: run(),
    rows: fullRows(),
    attempts: fullAttempts(),
    registry,
    aliasMap: {},
    graderFailures: [],
    methodology: "# methodology\n",
    harnessCommit: "0123456789abcdef0123456789abcdef01234567",
    publishedAt: "2026-09-30T07:00:00.000Z",
    ...over,
  };
}

describe("suite held-out set", () => {
  test("holds out exactly 2 manifest scenarios, and publishes the rest", () => {
    expect(HELD_OUT_SCENARIO_IDS.length).toBe(2);
    for (const id of HELD_OUT_SCENARIO_IDS) expect(SUITE_IDS).toContain(id);
    const published = publicSuiteScenarioIds();
    for (const id of HELD_OUT_SCENARIO_IDS) expect(published).not.toContain(id);
    expect(published.length).toBe(SUITE_IDS.length - SUITE_IDS.filter(isHeldOut).length);
  });

  test("a held-out swarm scenario's -solo baseline is held out with it", () => {
    expect(isHeldOut(`${HELD_OUT_SCENARIO_IDS[0]}-solo`)).toBe(true);
    expect(isHeldOut("fanout-research-solo")).toBe(false);
  });
});

describe("publish refusal rules", () => {
  test("a finished run with full coverage and n >= 5 everywhere is publishable", () => {
    expect(publishRefusals(input())).toEqual([]);
  });

  test("refuses when any public cell has fewer than 5 graded attempts", () => {
    const [scenario] = publicSuiteScenarioIds();
    const rows = fullRows().filter(
      (r) =>
        !(
          r.scenarioId === scenario &&
          r.configId === CONFIGS[1] &&
          r.score !== null &&
          r.agentMs === 94_000
        ),
    );
    const reasons = publishRefusals(input({ rows }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(`fewer than ${MIN_ATTEMPTS_PER_CELL} graded attempts`);
    expect(reasons[0]).toContain(`${scenario} x ${CONFIGS[1]} (n=4)`);
  });

  test("errored and cancelled attempts do not count toward n", () => {
    const [scenario] = publicSuiteScenarioIds();
    const rows = fullRows().map((r) =>
      r.scenarioId === scenario && r.configId === CONFIGS[0] && r.agentMs === 90_000
        ? { ...r, status: "error", exclusion: "harness-error" }
        : r,
    );
    expect(publishRefusals(input({ rows })).join("\n")).toContain(
      `${scenario} x ${CONFIGS[0]} (n=4)`,
    );
  });

  test("refuses partial coverage: a scenario missing from the run", () => {
    const missing = publicSuiteScenarioIds()[1] as string;
    const reasons = publishRefusals(
      input({ run: run({ scenarioIds: SUITE_IDS.filter((id) => id !== missing) }) }),
    );
    expect(reasons.join("\n")).toContain(`partial coverage: the run does not include ${missing}`);
  });

  test("refuses partial coverage: a cell with no graded attempt", () => {
    const [scenario] = publicSuiteScenarioIds();
    const rows = fullRows().filter(
      (r) => !(r.scenarioId === scenario && r.configId === CONFIGS[0]),
    );
    const reasons = publishRefusals(input({ rows }));
    expect(reasons.join("\n")).toContain(
      `partial coverage: no graded attempt in 1 cell(s): ${scenario} x ${CONFIGS[0]}`,
    );
  });

  test("a small held-out cell does not block publication", () => {
    const heldOut = HELD_OUT_SCENARIO_IDS[0] as string;
    const rows = fullRows().filter((r) => r.scenarioId !== heldOut || r.agentMs === 90_000);
    expect(publishRefusals(input({ rows }))).toEqual([]);
  });

  test("refuses when grader validation fails", () => {
    const reasons = publishRefusals(
      input({ graderFailures: ["sql-audit: reference solution does not pass"] }),
    );
    expect(reasons).toEqual([
      "grader validation failed: sql-audit: reference solution does not pass",
    ]);
  });

  test("refuses an unfinished run and a suite the code does not define", () => {
    const reasons = publishRefusals(
      input({ run: run({ status: "running" }), suiteVersion: "9.9" }),
    );
    expect(reasons.some((r) => r.includes("is running, not done"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("suite 9.9 is not the suite"))).toBe(true);
  });
});

describe("snapshot and disclosure bundle", () => {
  test("held-out scenarios never appear in the snapshot or any bundle file", () => {
    const snapshot = buildSnapshot(input());
    expect(snapshot.scenarios.map((s) => s.id)).toEqual(publicSuiteScenarioIds());
    expect(snapshot.frontier.expectedScenarios).toEqual(publicSuiteScenarioIds());
    expect(snapshot.heatmap.scenarioIds).toEqual(publicSuiteScenarioIds());
    expect(snapshot.heldOutCount).toBe(2);
    for (const [path, content] of Object.entries(bundleFiles(snapshot))) {
      expect({ path, leaks: heldOutLeaks(content) }).toEqual({ path, leaks: [] });
    }
  });

  test("every published scenario file carries the canary GUID", () => {
    const files = bundleFiles(buildSnapshot(input()));
    const scenarioFiles = Object.keys(files).filter((p) => p.startsWith("scenarios/"));
    expect(scenarioFiles.sort()).toEqual(
      publicSuiteScenarioIds()
        .map((id) => `scenarios/${id}.json`)
        .sort(),
    );
    for (const [path, content] of Object.entries(files)) {
      expect({ path, canary: content.includes(BENCHMARK_CANARY_GUID) }).toEqual({
        path,
        canary: true,
      });
    }
  });

  test("sandbox ids, URLs and swarm keys stay out; versions and templates are disclosed", () => {
    const snapshot = buildSnapshot(input());
    const all = Object.values(bundleFiles(snapshot)).join("\n");
    for (const secret of [SECRET_KEY, SECRET_URL, "must-not-leak"])
      expect(all).not.toContain(secret);
    const config = snapshot.configs.find((c) => c.configId === CONFIGS[0]);
    expect(config).toMatchObject({
      resolvedModels: ["claude-opus-5-5"],
      apiVersions: ["1.90.0"],
      workerVersions: ["1.90.0"],
      e2bTemplates: ["swarm-api-template", "swarm-worker-template"],
    });
    expect(snapshot.run.harnessCommit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(snapshot.run.judgeModel.length).toBeGreaterThan(0);
  });

  test("ranks and plots the run's configs, and reports swarm vs solo for every public pair", () => {
    const snapshot = buildSnapshot(input());
    expect(snapshot.frontier.status).toBe("ok");
    expect(snapshot.frontier.points.map((p) => p.configId)).toEqual(CONFIGS);
    const publicPairs = baselinePairs(scenarios).filter((p) => !isHeldOut(p.swarmId));
    expect(snapshot.swarmVsSolo.length).toBe(publicPairs.length * CONFIGS.length);
    for (const c of snapshot.swarmVsSolo) expect(c.deltaScore?.diff).toBeCloseTo(0.25, 5);
  });

  test("rows from other runs never enter the snapshot", () => {
    const other = fullRows().map((r) => ({ ...r, runId: "another-run", score: 0 }));
    const a = buildSnapshot(input());
    const b = buildSnapshot(input({ rows: [...fullRows(), ...other] }));
    expect(b.frontier.points.map((p) => p.score)).toEqual(a.frontier.points.map((p) => p.score));
  });
});

describe("grader validation at publish time", () => {
  test("passes for every registered scenario", async () => {
    expect(await graderValidationFailures(scenarios)).toEqual([]);
  });

  test("reports a scenario without a grader fixture", async () => {
    const orphan = { ...(scenarios[0] as (typeof scenarios)[number]), id: "no-such-fixture" };
    expect(await graderValidationFailures([orphan])).toEqual([
      "no-such-fixture: no grader fixture",
    ]);
  });
});

describe("publishBenchmark (DB)", () => {
  // The DB client prefers EVALS_DB_SYNC_URL (the Turso replica) over EVALS_DB_PATH:
  // clear it, or these tests write to the real evals DB.
  const DB_ENV = ["EVALS_DB_SYNC_URL", "EVALS_DB_AUTH_TOKEN", "EVALS_DB_PATH"] as const;
  const saved: Record<string, string | undefined> = {};
  let outDir: string;
  beforeEach(async () => {
    resetDbForTests();
    for (const key of DB_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.EVALS_DB_PATH = ":memory:";
    outDir = await mkdtemp(join(tmpdir(), "evals-benchmark-"));
  });
  afterEach(async () => {
    resetDbForTests();
    for (const key of DB_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(outDir, { recursive: true, force: true });
  });

  test("refuses an unknown run", async () => {
    await initDb();
    const result = await publishBenchmark(getDb(), {
      suiteVersion: SUITE_VERSION,
      runId: "nope",
      outDir,
    });
    expect(result).toEqual({ ok: false, refusals: ["run nope not found"] });
  });

  test("refuses a finished run with no graded attempts and writes nothing", async () => {
    await initDb();
    const db = getDb();
    await createRun(db, {
      id: RUN_ID,
      scenarioIds: SUITE_IDS,
      configIds: CONFIGS,
      attemptsPerCell: 5,
      concurrency: 1,
    });
    await setRunStatus(db, RUN_ID, "done");
    const result = await publishBenchmark(db, {
      suiteVersion: SUITE_VERSION,
      runId: RUN_ID,
      outDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.refusals.join("\n")).toContain("partial coverage: no graded attempt");
    expect(await readdir(outDir)).toEqual([]);
  });
});
