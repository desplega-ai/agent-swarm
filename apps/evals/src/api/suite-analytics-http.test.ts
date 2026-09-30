import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SUITE_SCENARIO_VERSIONS, SUITE_VERSION } from "../../scenarios/suite.ts";
import { getDb, resetDbForTests } from "../db/client.ts";
import { createRun } from "../db/queries.ts";
import { resetActiveRunsForTests, startServer } from "./server.ts";

/**
 * The /api/analytics suite endpoints end to end: an in-memory DB seeded with one
 * full-suite matrix, the real server, real HTTP. Two configs over every scenario
 * of the current suite, 3 attempts per cell:
 *   claude-opus-5.5  score 0.9, $1.00, 60s agent time
 *   codex-6-luna     score 0.8, $2.00, 90s agent time  (dominated on both axes)
 */

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(() => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});

afterEach(() => {
  resetActiveRunsForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const SCENARIOS = Object.keys(SUITE_SCENARIO_VERSIONS);
const CONFIGS = [
  { id: "claude-opus-5.5", score: 0.9, cost: 1, agentMs: 60_000 },
  { id: "codex-6-luna", score: 0.8, cost: 2, agentMs: 90_000 },
];

async function seed(): Promise<void> {
  const db = getDb();
  await createRun(db, {
    id: "run-1",
    name: "weekly",
    scenarioIds: SCENARIOS,
    configIds: CONFIGS.map((c) => c.id),
    attemptsPerCell: 3,
    concurrency: 1,
  });
  const insert = (
    id: string,
    scenario: string,
    config: string,
    index: number,
    o: {
      status: string;
      score: number | null;
      cost: number | null;
      agentMs: number | null;
      suite: string | null;
      exclusion?: string | null;
    },
  ) =>
    db.execute({
      sql: `INSERT INTO attempts
              (id, run_id, scenario_id, config_id, attempt_index, status, score, cost_usd,
               timings_json, suite_version, exclusion, resolved_model)
            VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        scenario,
        config,
        index,
        o.status,
        o.score,
        o.cost,
        o.agentMs === null ? null : JSON.stringify({ tasksMs: o.agentMs }),
        o.suite,
        o.exclusion ?? null,
        `model-of-${config}`,
      ],
    });
  for (const c of CONFIGS) {
    for (const s of SCENARIOS) {
      for (let i = 0; i < 3; i++) {
        await insert(`${c.id}-${s}-${i}`, s, c.id, i, {
          status: "passed",
          score: c.score,
          cost: c.cost,
          agentMs: c.agentMs,
          suite: SUITE_VERSION,
        });
      }
    }
  }
  // Noise the endpoints must ignore: an off-suite attempt, another suite, and a cancelled one.
  await insert("off-suite", SCENARIOS[0] as string, "claude-opus-5.5", 10, {
    status: "failed",
    score: 0,
    cost: 50,
    agentMs: 1,
    suite: null,
  });
  await insert("old-suite", SCENARIOS[0] as string, "claude-opus-5.5", 11, {
    status: "failed",
    score: 0,
    cost: 50,
    agentMs: 1,
    suite: "0.1",
  });
  await insert("cancelled", SCENARIOS[0] as string, "claude-opus-5.5", 12, {
    status: "error",
    score: null,
    cost: null,
    agentMs: null,
    suite: SUITE_VERSION,
    exclusion: "cancelled",
  });
}

async function withServer(fn: (get: (path: string) => Promise<Response>) => Promise<void>) {
  const server = await startServer(0);
  try {
    if (server.port === undefined) throw new Error("no port");
    const base = `http://127.0.0.1:${server.port}`;
    await fn((path) => fetch(`${base}${path}`));
  } finally {
    server.stop(true);
  }
}

describe("GET /api/analytics suite endpoints", () => {
  test("frontier: the dominated config is off the frontier, noise rows are ignored", async () => {
    await withServer(async (get) => {
      await seed();
      const res = await get("/api/analytics/frontier");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.suiteVersion).toBe(SUITE_VERSION);
      expect(body.status).toBe("ok");
      expect(body.frontier.cost).toEqual(["claude-opus-5.5"]);
      expect(body.frontier.time).toEqual(["claude-opus-5.5"]);
      const opus = body.points.find((p: any) => p.configId === "claude-opus-5.5");
      expect(opus.attempts).toBe(6 * 3);
      expect(opus.avgCostUsd).toBeCloseTo(1, 12);
      expect(opus.medianAgentMs).toBe(60_000);
      expect(opus.harness).toBe("claude");
      expect(body.scenarios).toHaveLength(SCENARIOS.length);
    });
  });

  test("an unknown suite has no data and no frontier", async () => {
    await withServer(async (get) => {
      await seed();
      const body = (await (await get("/api/analytics/frontier?suite=9.9")).json()) as Record<
        string,
        any
      >;
      expect(body.status).toBe("empty");
      expect(body.points).toEqual([]);
      const old = (await (await get("/api/analytics/frontier?suite=0.1")).json()) as Record<
        string,
        any
      >;
      // A retired suite defines "full" by what it saw: one attempt in one scenario.
      expect(old.points).toHaveLength(1);
      expect(old.status).toBe("low-n");
      expect(old.frontier).toEqual({ cost: [], time: [] });
    });
  });

  test("leaderboard: ranks, both tracks, the k parameter", async () => {
    await withServer(async (get) => {
      await seed();
      const body = (await (await get("/api/analytics/leaderboard?k=2")).json()) as Record<
        string,
        any
      >;
      expect(body.k).toBe(2);
      const groups = body.tracks.fixedHarness.map((g: any) => g.harness);
      expect(groups).toEqual(["claude", "codex"]);
      const rows = body.tracks.bestHarnessPerModel.rows;
      expect(rows.map((r: any) => r.configId).sort()).toEqual(["claude-opus-5.5", "codex-6-luna"]);
      const claude = body.tracks.fixedHarness[0].rows[0];
      expect(claude.rank).toBe(1);
      expect(claude.passAt1).toBe(1);
      expect(claude.passPowK).toBe(1);
      expect(claude.scenarios).toEqual({ covered: SCENARIOS.length, expected: SCENARIOS.length });
    });
  });

  test("heatmap, reliability and compare answer with the seeded matrix", async () => {
    await withServer(async (get) => {
      await seed();
      const heat = (await (await get("/api/analytics/heatmap")).json()) as Record<string, any>;
      expect(heat.cells).toHaveLength(SCENARIOS.length * CONFIGS.length);
      expect(heat.anyConfig).toHaveLength(SCENARIOS.length);
      expect(heat.anyConfig[0]).toMatchObject({ graded: 6, passed: 6, configsPassing: 2 });

      const rel = (await (await get("/api/analytics/reliability?maxK=3")).json()) as Record<
        string,
        any
      >;
      expect(rel.maxK).toBe(3);
      expect(rel.configs[0].curve).toHaveLength(3);
      expect(rel.configs[0].trend).toHaveLength(1);
      expect(rel.configs[0].trend[0]).toMatchObject({ runId: "run-1", runName: "weekly" });

      const cmp = (await (
        await get("/api/analytics/compare?a=claude-opus-5.5&b=codex-6-luna")
      ).json()) as Record<string, any>;
      expect(cmp.comparable).toBe(true);
      expect(cmp.score.diff).toBeCloseTo(0.1, 12);
      expect(cmp.score.significant).toBe(true);
      expect(cmp.score.wins).toBe(SCENARIOS.length);
    });
  });

  test("filters narrow the rows", async () => {
    await withServer(async (get) => {
      await seed();
      const body = (await (await get("/api/analytics/frontier?harnesses=codex")).json()) as Record<
        string,
        any
      >;
      expect(body.points.map((p: any) => p.configId)).toEqual(["codex-6-luna"]);
    });
  });

  test("suites lists what has recorded attempts, without cancelled ones", async () => {
    await withServer(async (get) => {
      await seed();
      const body = (await (await get("/api/analytics/suites")).json()) as Record<string, any>;
      expect(body.current).toBe(SUITE_VERSION);
      const cur = body.suites.find((s: any) => s.suiteVersion === SUITE_VERSION);
      expect(cur).toMatchObject({
        attempts: SCENARIOS.length * CONFIGS.length * 3,
        runs: 1,
        configs: 2,
      });
      expect(body.suites.find((s: any) => s.suiteVersion === "0.1")?.attempts).toBe(1);
      expect(body.suites.map((s: any) => s.suiteVersion)).not.toContain(null);
    });
  });

  test("bad query params answer 400 with a message", async () => {
    await withServer(async (get) => {
      for (const path of [
        "/api/analytics/leaderboard?k=0",
        "/api/analytics/reliability?maxK=99",
        "/api/analytics/compare?a=x",
        "/api/analytics/compare?a=x&b=x",
        "/api/analytics/frontier?suite=..%2Fetc",
      ]) {
        const res = await get(path);
        expect(res.status).toBe(400);
        expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
      }
    });
  });

  test("an empty database answers 200 with empty views, not an error", async () => {
    await withServer(async (get) => {
      for (const kind of ["frontier", "leaderboard", "heatmap", "reliability"]) {
        expect((await get(`/api/analytics/${kind}`)).status).toBe(200);
      }
      const suites = (await (await get("/api/analytics/suites")).json()) as Record<string, any>;
      expect(suites.suites).toEqual([]);
    });
  });

  test("the pre-existing /api/analytics is unchanged and still reads every suite", async () => {
    await withServer(async (get) => {
      await seed();
      const body = (await (await get("/api/analytics")).json()) as Record<string, any>;
      // The off-suite and old-suite attempts count here (no suite scoping); the cancelled one does not.
      const opus = body.matrix.filter((c: any) => c.configId === "claude-opus-5.5");
      const first = opus.find((c: any) => c.scenarioId === SCENARIOS[0]);
      expect(first.attempts).toBe(3 + 2);
    });
  });

  test("EVALS_API_KEY protects every suite endpoint", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    await withServer(async (get) => {
      for (const path of [
        "/api/analytics/frontier",
        "/api/analytics/leaderboard",
        "/api/analytics/heatmap",
        "/api/analytics/reliability",
        "/api/analytics/compare?a=x&b=y",
        "/api/analytics/suites",
      ]) {
        expect((await get(path)).status).toBe(401);
      }
    });
  });
});
