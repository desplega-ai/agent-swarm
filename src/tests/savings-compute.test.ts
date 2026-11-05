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
} from "../be/db";
import { computeWorkflowWindow, LIVE_MAX_RUNS } from "../be/savings/compute";
import { DEFAULT_OPS } from "../be/savings/model";
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
  });

  test("negative control: an unknown workflow id has no runs", async () => {
    const out = await computeWorkflowWindow({ id: "no-such-workflow", definition: {} }, WINDOW);
    expect(out).toEqual({ status: "ok", facts: expect.objectContaining({ runs: 0 }) });
  });

  test("a workflow above the live limit is refused before any step scan", async () => {
    const out = await computeWorkflowWindow({ id: busyWorkflowId, definition: DEFINITION }, WINDOW);
    expect(out).toEqual({ status: "too-many-runs", runs: LIVE_MAX_RUNS + 1 });
  });

  describe("GET /api/savings/jobs", () => {
    const get = async (query: string) => {
      resetSavingsCache();
      const res = await fetch(`http://127.0.0.1:${port}/api/savings/jobs?${query}`);
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
    });

    test("unknown workflow is 404; bad tier, days or a missing id is 400", async () => {
      expect((await get("workflowId=nope")).status).toBe(404);
      expect((await get(`workflowId=${workflowId}&tier=huge`)).status).toBe(400);
      expect((await get(`workflowId=${workflowId}&days=12`)).status).toBe(400);
      expect((await get("")).status).toBe(400);
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
    });
  });
});
