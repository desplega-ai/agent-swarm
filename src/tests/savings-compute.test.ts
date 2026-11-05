import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { computeWorkflowWindow, LIVE_MAX_RUNS } from "../be/savings/compute";
import { CURVE, DEFAULT_OPS, SAVINGS_CALIBRATION_KEY, SAVINGS_TIERS } from "../be/savings/model";
import { handleSavings, resetSavingsCache } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-compute.sqlite";
const WINDOW = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" };
const DEFINITION = {
  nodes: [
    { id: "fetch", type: "script", config: { script: "await a(); await b(); await c();" } },
    { id: "ping", type: "notify", config: {} },
    { id: "sw", type: "swarm-script", config: { scriptName: "not-in-catalog" } },
    { id: "agent", type: "agent-task", config: {} },
  ],
};

// The preload swaps file DBs for an in-memory template copy; the route's
// bounded executor reads the DB file from a child process, so opt out here.
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedSavingsTemplate?: Uint8Array;
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

describe("savings compute", () => {
  let agentId: string;
  let workflowId: string;
  let emptyWorkflowId: string;
  let busyWorkflowId: string;
  let server: Server;
  let port: number;

  async function run(opts: {
    trigger: "schedule" | "manual";
    status: string;
    startedAt: string;
    steps: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    await createWorkflowRun({ id, workflowId, triggerType: opts.trigger });
    await getDbClient().run("UPDATE workflow_runs SET status=?, startedAt=? WHERE id=?", [
      opts.status,
      opts.startedAt,
      id,
    ]);
    for (const nodeId of opts.steps) {
      const node = DEFINITION.nodes.find((n) => n.id === nodeId);
      const stepId = crypto.randomUUID();
      await createWorkflowRunStep({ id: stepId, runId: id, nodeId, nodeType: node?.type ?? "" });
      // Every step lasts 2 s, except the agent step (10 s, which is not compute time).
      const secs = nodeId === "agent" ? 10 : 2;
      const finished = new Date(Date.parse(opts.startedAt) + secs * 1000).toISOString();
      await getDbClient().run(
        "UPDATE workflow_run_steps SET status='completed', startedAt=?, finishedAt=? WHERE id=?",
        [opts.startedAt, finished, stepId],
      );
    }
    return id;
  }

  async function agentTask(runId: string, usd: number, ms: number): Promise<string> {
    const task = await createTaskExtended(`savings fixture ${usd}`, {
      agentId,
      source: "workflow",
      workflowRunId: runId,
    });
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: task.id,
      agentId,
      totalCostUsd: usd,
      durationMs: ms,
      numTurns: 3,
      model: "claude-opus-5-5",
    });
    return task.id;
  }

  beforeAll(async () => {
    testGlobals.__savedSavingsTemplate = testGlobals.__testMigrationTemplate;
    testGlobals.__testMigrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    agentId = (await createAgent({ name: "savings-agent", isLead: false, status: "idle" })).id;
    workflowId = (await createWorkflow({ name: "savings-fixture", definition: DEFINITION })).id;
    emptyWorkflowId = (await createWorkflow({ name: "savings-empty", definition: DEFINITION })).id;
    busyWorkflowId = (await createWorkflow({ name: "savings-busy", definition: DEFINITION })).id;

    // Three scheduled runs; the first created an agent task (an effect run).
    const s1 = await run({
      trigger: "schedule",
      status: "completed",
      startedAt: "2026-10-02T10:00:00.000Z",
      steps: ["fetch", "ping"],
    });
    await agentTask(s1, 1, 1_800_000);
    for (const startedAt of ["2026-10-03T10:00:00.000Z", "2026-10-04T10:00:00.000Z"]) {
      await run({ trigger: "schedule", status: "completed", startedAt, steps: ["fetch", "ping"] });
    }
    // One manual run with an agent node, its session and a lead follow-up review.
    const m = await run({
      trigger: "manual",
      status: "completed",
      startedAt: "2026-10-05T10:00:00.000Z",
      steps: ["fetch", "sw", "agent"],
    });
    const worker = await agentTask(m, 2, 3_600_000);
    const followUp = await createTaskExtended("Worker task completed: savings fixture", {
      agentId,
      parentTaskId: worker,
    });
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: followUp.id,
      agentId,
      totalCostUsd: 0.5,
      durationMs: 60_000,
      numTurns: 1,
      model: "claude-opus-5-5",
    });
    // A skipped run counts as a run but substitutes nothing.
    await run({
      trigger: "schedule",
      status: "skipped",
      startedAt: "2026-10-06T10:00:00.000Z",
      steps: [],
    });
    // Outside the window: ignored.
    await run({
      trigger: "manual",
      status: "completed",
      startedAt: "2026-09-20T10:00:00.000Z",
      steps: ["fetch"],
    });

    // More runs than the live path handles.
    await getDbClient().run(
      `INSERT INTO workflow_runs (id, workflowId, triggerType, startedAt)
       WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
       SELECT 'busy-' || i, ?, 'event', '2026-10-10T00:00:00.000Z' FROM seq`,
      [LIVE_MAX_RUNS + 1, busyWorkflowId],
    );

    server = createHttpServer(async (req, res) => {
      const handled = await handleSavings(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
      );
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    server?.close();
    closeDb();
    testGlobals.__testMigrationTemplate = testGlobals.__savedSavingsTemplate;
    testGlobals.__savedSavingsTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("facts match the hand-computed fixture", async () => {
    const out = await computeWorkflowWindow({ id: workflowId, definition: DEFINITION }, WINDOW);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.facts).toEqual({
      runs: 5,
      countedRuns: 4,
      schedRuns: 3,
      schedEffectRuns: 1,
      // 3 scheduled runs x (fetch 3 + ping 1) + manual (fetch 3 + sw DEFAULT_OPS + agent 0)
      opsSum: 3 * 4 + 3 + DEFAULT_OPS,
      agentTasks: 2,
      agentUsd: 3,
      agentMs: 5_400_000,
      followupUsd: 0.5,
      recordedLlmUsd: 0,
      estimatedLlmUsd: 0,
      // 6 scheduled steps + fetch + sw, 2 s each; the agent step is excluded.
      computeSecs: expect.closeTo(16, 3) as unknown as number,
    });
    // One bucket per UTC start day; the skipped run still counts as a run.
    expect(out.byDay.map((d) => [d.day, d.runs, d.countedRuns, d.schedEffectRuns])).toEqual([
      ["2026-10-02", 1, 1, 1],
      ["2026-10-03", 1, 1, 0],
      ["2026-10-04", 1, 1, 0],
      ["2026-10-05", 1, 1, 0],
      ["2026-10-06", 1, 0, 0],
    ]);
    expect(out.byDay[0]).toMatchObject({ agentTasks: 1, agentUsd: 1, opsSum: 4 });
    expect(out.byDay[3]).toMatchObject({ agentTasks: 1, agentUsd: 2, followupUsd: 0.5 });
  });

  test("negative control: an unknown workflow id has no runs", async () => {
    const out = await computeWorkflowWindow({ id: "no-such-workflow", definition: {} }, WINDOW);
    expect(out).toEqual({ status: "ok", facts: expect.objectContaining({ runs: 0 }), byDay: [] });
  });

  test("a workflow above the live limit is refused before any step scan", async () => {
    const out = await computeWorkflowWindow({ id: busyWorkflowId, definition: DEFINITION }, WINDOW);
    expect(out).toEqual({ status: "too-many-runs", runs: LIVE_MAX_RUNS + 1 });
  });

  describe("GET /api/savings/jobs and /api/savings/daily", () => {
    const get = async (query: string, path = "jobs") => {
      resetSavingsCache();
      const res = await fetch(`http://127.0.0.1:${port}/api/savings/${path}?${query}`);
      return { status: res.status, body: (await res.json().catch(() => null)) as never };
    };

    test("a workflow with no runs in the window is not valid", async () => {
      const { status, body } = await get(`workflowId=${emptyWorkflowId}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        valid: false,
        reason: "no-runs",
        rows: [],
        tier: "smart",
        calibrationModel: "claude-opus-5-5",
        window: { days: 30 },
      });
    });

    test("too many runs is reported, never as $0", async () => {
      const { body } = await get(`workflowId=${busyWorkflowId}&days=90`);
      expect(body).toMatchObject({ valid: false, reason: "too-many-runs", rows: [] });
      const daily = await get(`workflowId=${busyWorkflowId}&days=90`, "daily");
      expect(daily.body).toMatchObject({ valid: false, reason: "too-many-runs", points: [] });
      const idle = await get(`workflowId=${emptyWorkflowId}`, "daily");
      expect(idle.body).toMatchObject({ valid: false, reason: "no-runs", points: [] });
    });

    test("unknown workflow is 404; bad tier, days or a missing id is 400", async () => {
      expect((await get("workflowId=nope")).status).toBe(404);
      expect((await get(`workflowId=${workflowId}&tier=huge`)).status).toBe(400);
      expect((await get(`workflowId=${workflowId}&days=12`)).status).toBe(400);
      expect((await get("")).status).toBe(400);
      expect((await get("workflowId=nope", "daily")).status).toBe(404);
      expect((await get(`workflowId=${workflowId}&tier=huge`, "daily")).status).toBe(400);
    });

    test("scans run in the bounded executor: a spent budget is a 408, not a blocked API", async () => {
      const saved = process.env.DB_QUERY_HTTP_BUDGET_MS;
      process.env.DB_QUERY_HTTP_BUDGET_MS = "1";
      try {
        expect((await get(`workflowId=${workflowId}`)).status).toBe(408);
      } finally {
        if (saved === undefined) delete process.env.DB_QUERY_HTTP_BUDGET_MS;
        else process.env.DB_QUERY_HTTP_BUDGET_MS = saved;
      }
    });

    test("a workflow with runs returns one priced row", async () => {
      // The fixture runs are in October 2026; the route window ends now, so
      // shift them into the last 7 days for this check.
      await getDbClient().run(
        "UPDATE workflow_runs SET startedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE workflowId=? AND startedAt>=?",
        [workflowId, WINDOW.start],
      );
      const { status, body } = await get(`workflowId=${workflowId}&days=7&tier=smol`);
      expect(status).toBe(200);
      const b = body as {
        valid: boolean;
        tier: string;
        rows: { substitutedRuns: number; savingUsd: { p10: number; p50: number; p90: number } }[];
      };
      expect(b.valid).toBe(true);
      expect(b.tier).toBe("smol");
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0]?.substitutedRuns).toBe(4);
      const band = b.rows[0]?.savingUsd;
      expect(band && band.p10 < band.p50 && band.p50 < band.p90).toBe(true);
      expect((body as { calibrationSource: string }).calibrationSource).toBe("shipped");
    });

    describe("deployment calibration", () => {
      const store = (value: string) =>
        upsertSwarmConfig({ scope: "global", key: SAVINGS_CALIBRATION_KEY, value });
      const p50 = async () =>
        (
          (await get(`workflowId=${workflowId}&days=7&tier=smart`)).body as {
            rows: { agentOnlyUsd: { p50: number } }[];
          }
        ).rows[0]?.agentOnlyUsd.p50 as number;
      const doubled = JSON.stringify({
        calibratedAt: "2026-12-01",
        model: "claude-opus-5-5",
        curve: Object.fromEntries(
          SAVINGS_TIERS.map((t) => [t, { usd: CURVE[t].usd.map((v) => v * 2), hrs: CURVE[t].hrs }]),
        ),
      });

      afterAll(async () => {
        await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [
          SAVINGS_CALIBRATION_KEY,
        ]);
      });

      test("a stored curve prices the response and is named as the source", async () => {
        const shipped = await p50();
        await store(doubled);
        const { body } = await get(`workflowId=${workflowId}&days=7&tier=smart`);
        expect(body).toMatchObject({ calibrationSource: "deployment", calibratedAt: "2026-12-01" });
        expect(await p50()).toBeGreaterThan(shipped * 1.2);
      });

      test("a malformed stored curve falls back to the shipped one", async () => {
        await store("{not json");
        const { body } = await get(`workflowId=${workflowId}&days=7&tier=smart`);
        expect(body).toMatchObject({ calibrationSource: "shipped", calibratedAt: "2026-11-05" });
      });
    });

    test("the daily points sum to the header saving", async () => {
      // Runs over several days; the previous test moved them all to yesterday.
      // An hour back keeps every run clear of the window end (`now` at request time).
      await getDbClient().run(
        "UPDATE workflow_runs SET startedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || (rowid % 6) || ' days','-1 hour') WHERE workflowId=?",
        [workflowId],
      );
      const jobs = (await get(`workflowId=${workflowId}&days=7`)).body as {
        rows: { savingUsd: { p50: number }; actualUsd: number }[];
      };
      const { status, body } = await get(`workflowId=${workflowId}&days=7`, "daily");
      expect(status).toBe(200);
      const daily = body as {
        valid: boolean;
        tier: string;
        points: { day: string; savingUsd: number; actualUsd: number }[];
      };
      expect(daily.valid).toBe(true);
      expect(daily.tier).toBe("smart");
      // A 7-day window touches 8 UTC days; every one has a point.
      expect(daily.points).toHaveLength(8);
      const cents = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100);
      expect(cents(daily.points.map((p) => p.savingUsd))).toBe(
        Math.round((jobs.rows[0]?.savingUsd.p50 ?? Number.NaN) * 100),
      );
      expect(cents(daily.points.map((p) => p.actualUsd))).toBe(
        Math.round((jobs.rows[0]?.actualUsd ?? Number.NaN) * 100),
      );
      expect(daily.points.filter((p) => p.savingUsd !== 0).length).toBeGreaterThan(0);
    });
  });
});
