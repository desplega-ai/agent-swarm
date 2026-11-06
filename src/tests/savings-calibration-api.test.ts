import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createWorkflow, getDbClient, initDb } from "../be/db";
import { TIER_MODEL } from "../be/savings/calibrate";
import { SAVINGS_CALIBRATION_KEY, SAVINGS_TIERS } from "../be/savings/model";
import { handleSavings } from "../http/savings";
import { handleSavingsCalibration, setCalibrationDeadlineMs } from "../http/savings-calibration";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-calibration-api.sqlite";
const PER_TURN = 6; // sessions per turn count; MIN_SESSIONS_PER_TURN is 5

// The preload swaps file DBs for an in-memory template copy; the route's
// bounded executor reads the DB file from a child process, so opt out here.
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedCalibrationTemplate?: Uint8Array;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

describe("savings calibration API", () => {
  let agentId: string;
  let workflowId: string;
  let server: Server;
  let port: number;

  /** Opus sessions of 1..61 turns, `PER_TURN` each, whose tokens (so cost) scale with `k` and the turn count. */
  let currentK = 1;
  async function seed(k: number) {
    currentK = k;
    await getDbClient().run("DELETE FROM session_costs");
    await getDbClient().run(
      `INSERT INTO session_costs (id, sessionId, agentId, totalCostUsd, durationMs, numTurns, model, createdAt, modelBreakdown)
       WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT 'cal-' || i, 'cal-' || i, ?, 1, 3000 * (i / ? + 1), i / ? + 1, 'claude-opus-5-5',
         strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),
         json_array(json_object('model','claude-opus-5-5','inputTokens',10,
           'outputTokens', CAST(? * 300 * (i / ? + 1) AS INTEGER),
           'cacheReadTokens', CAST(? * 20000 * (i / ? + 1) AS INTEGER),
           'cacheWriteTokens', CAST(? * (5000 + 100 * (i / ? + 1)) AS INTEGER), 'costUsd', 1))
       FROM n`,
      [61 * PER_TURN - 1, agentId, PER_TURN, PER_TURN, k, PER_TURN, k, PER_TURN, k, PER_TURN],
    );
  }

  /** Reseed so the derived smart mean cost is `target` times the shipped one. */
  async function scaleTo(target: number) {
    const ratio = (await post({})).body.meanRatio as number;
    await seed((currentK * target) / ratio);
  }
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url("/api/savings/calibration"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const get = async () => (await (await fetch(url("/api/savings/calibration"))).json()) as any;
  const storedRows = async () =>
    getDbClient().query("SELECT value FROM swarm_config WHERE key = ?", [SAVINGS_CALIBRATION_KEY]);

  beforeAll(async () => {
    testGlobals.__savedCalibrationTemplate = testGlobals.__testMigrationTemplate;
    testGlobals.__testMigrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    agentId = (await createAgent({ name: "calibration-agent", isLead: false, status: "idle" })).id;
    workflowId = (await createWorkflow({ name: "calibration-wf", definition: { nodes: [] } })).id;
    server = createHttpServer(async (req, res) => {
      // The real server authenticates before routing; a guest header stands in for a denied caller.
      setRequestAuth(
        req,
        req.headers["x-test-guest"]
          ? { kind: "guest" }
          : { kind: "operator", fingerprint: "test-key" },
      );
      const segs = getPathSegments(req.url || "");
      const query = parseQueryParams(req.url || "");
      const handled =
        (await handleSavingsCalibration(req, res, segs, query)) ||
        (await handleSavings(req, res, segs, query));
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    port = await listenOnFreePort(server);
    for (const model of Object.values(TIER_MODEL)) {
      for (const [tokenClass, price] of [
        ["input", 4],
        ["output", 20],
        ["cached_input", 0.2],
        ["cache_write_1h", 8],
      ] as const) {
        await getDbClient().run(
          `INSERT INTO pricing (provider, model, token_class, effective_from, price_per_million_usd, createdAt, lastUpdatedAt)
           VALUES ('claude', ?, ?, 0, ?, 0, 0)`,
          [model, tokenClass, price],
        );
      }
    }
    // Tokens scale linearly with k, so one dry run gives the k that matches the shipped mean cost.
    await seed(1);
  });

  afterAll(async () => {
    server?.close();
    closeDb();
    testGlobals.__testMigrationTemplate = testGlobals.__savedCalibrationTemplate;
    testGlobals.__savedCalibrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("a dry run derives and compares but stores nothing", async () => {
    const { status, body } = await post({});
    expect(status).toBe(200);
    expect(body).toMatchObject({
      applied: false,
      refusals: [],
      sessions: 61 * PER_TURN,
    });
    expect(body.window.days).toBe(30);
    expect(body.calibration.curve.smart.usd).toHaveLength(61);
    expect(body.gaps).toHaveLength(SAVINGS_TIERS.length * 2);
    expect(body.meanRatio).toBeGreaterThan(0);
    expect(await storedRows()).toHaveLength(0);
    expect(await get()).toMatchObject({ source: "shipped", stored: null });
  });

  test("apply stores the curve, GET reports it, and the savings endpoints see it at once", async () => {
    await scaleTo(1);
    const jobs = async () => {
      const res = await fetch(url(`/api/savings/jobs?workflowId=${workflowId}`));
      return (await res.json()) as any;
    };
    expect((await jobs()).calibrationSource).toBe("shipped"); // fills the 60 s curve cache

    const { status, body } = await post({ apply: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: true, refusals: [] });
    const row = JSON.parse(((await storedRows())[0] as { value: string }).value);
    expect(row.curve.smart.usd).toEqual(body.calibration.curve.smart.usd);

    expect(await get()).toMatchObject({
      source: "deployment",
      stored: { valid: true, window: { sessions: 366 } },
    });
    expect((await jobs()).calibrationSource).toBe("deployment");
  });

  test("a derived curve far from the shipped one is returned but never applied", async () => {
    await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [SAVINGS_CALIBRATION_KEY]);
    await scaleTo(4); // 4x the shipped mean
    const { body } = await post({ apply: true });
    expect(body.calibration).not.toBeNull();
    expect(body.applied).toBe(false);
    expect(body.refusals[0]).toMatch(/not applied: derived smart curve is [\d.]+x the shipped one/);
    expect(await storedRows()).toHaveLength(0);
  });

  test("too few sessions: refused, nothing derived, nothing stored", async () => {
    await getDbClient().run("DELETE FROM session_costs");
    const { status, body } = await post({ apply: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: false, calibration: null, gaps: [], sessions: 0 });
    expect(body.refusals[0]).toMatch(/only 0 opus sessions/);
    expect(await storedRows()).toHaveLength(0);
  });

  test("a malformed stored row is reported invalid, served as shipped, and replaced by apply", async () => {
    await seed(1);
    await scaleTo(1);
    await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [SAVINGS_CALIBRATION_KEY]);
    await getDbClient().run(
      "INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, createdAt, lastUpdatedAt) VALUES (?, 'global', NULL, ?, '{not json', 0, 'now', 'now')",
      [crypto.randomUUID(), SAVINGS_CALIBRATION_KEY],
    );
    expect(await get()).toMatchObject({ source: "shipped", stored: { valid: false } });
    expect((await post({ apply: true })).body.applied).toBe(true);
    expect(await get()).toMatchObject({ source: "deployment", stored: { valid: true } });
  });

  test("a second concurrent run gets 409", async () => {
    const statuses = (await Promise.all([post({}), post({})])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect((await post({})).status).toBe(200); // the lock is released afterwards
  });

  test("a run past the deadline is a 504 and releases the lock", async () => {
    setCalibrationDeadlineMs(1);
    try {
      const { status, body } = await post({});
      expect(status).toBe(504);
      expect(body.error).toMatch(/deadline/);
    } finally {
      setCalibrationDeadlineMs(null);
    }
    expect((await post({})).status).toBe(200);
  });

  test("apply needs config write access; a dry run does not", async () => {
    await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [SAVINGS_CALIBRATION_KEY]);
    const guest = { "x-test-guest": "1" };
    expect((await post({ apply: true }, guest)).status).toBe(403);
    expect(await storedRows()).toHaveLength(0);
    expect((await post({}, guest)).status).toBe(200);
  });

  test("invalid input is a 400", async () => {
    expect((await post({ days: 0 })).status).toBe(400);
    expect((await post({ days: 91 })).status).toBe(400);
    expect((await post({ end: "yesterday" })).status).toBe(400);
    expect((await post({ apply: "yes" })).status).toBe(400);
  });
});
