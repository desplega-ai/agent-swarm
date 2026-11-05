import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  getDbClient,
  initDb,
} from "../be/db";
import type { SavingsSql } from "../be/savings/compute";
import { readScheduleSavings, readScriptSavings, readWorkflowSavings } from "../be/savings/read";
import { resetSavingsRollupForTests, runSavingsRollupTick } from "../be/savings/rollup";
import { handleSavings } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-read.sqlite";
// The route reads the clock itself, so the fixture covers the 7 days ending today.
const NOW = Date.now();
const WEEK = Array.from({ length: 7 }, (_, i) =>
  new Date(NOW - (6 - i) * 86_400_000).toISOString().slice(0, 10),
);
// Runs start at 00:00, one a minute: three a day stay before "now" at any time but just after midnight UTC.
const RUNS_PER_DAY = 3;
const DEFINITION = { nodes: [{ id: "hello", type: "notify", config: {} }] };

const inProcessSql: SavingsSql = (sql, params) => getDbClient().query(sql, params);

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function workflowRuns(workflowId: string, day: string, count: number) {
  await getDbClient().run(
    `INSERT INTO workflow_runs (id, workflowId, triggerType, status, startedAt)
     WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ? - 1)
     SELECT ? || '-' || ? || '-' || i, ?, 'schedule', 'completed',
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes') FROM seq`,
    [count, workflowId, day, workflowId, `${day}T00:00:00.000Z`],
  );
  await getDbClient().run(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt)
     SELECT id || '-s', id, 'hello', 'notify', 'completed', startedAt, startedAt
     FROM workflow_runs WHERE workflowId=? AND startedAt>=? AND startedAt<?`,
    [workflowId, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`],
  );
}

async function scriptRuns(agentId: string, name: string, day: string, count: number) {
  await getDbClient().run(
    `INSERT INTO script_runs (id, agentId, scriptName, source, status, startedAt, finishedAt)
     WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ? - 1)
     SELECT ? || '-' || ? || '-' || i, ?, ?, 'x', 'completed',
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes'),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || i || ' minutes', '+30 seconds') FROM seq`,
    [count, name, day, agentId, name, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`],
  );
}

describe("savings read for schedules", () => {
  let agentId: string;
  let server: Server;
  let port: number;
  const ids: Record<string, string> = {};

  const get = async (query: string) => {
    const res = await fetch(`http://localhost:${port}/api/savings/jobs?${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    await resetSavingsRollupForTests();
    agentId = (await createAgent({ name: "savings-read-agent", isLead: false, status: "idle" })).id;
    const wf = await createWorkflow({ name: "sched-wf", definition: DEFINITION });
    const wfOff = await createWorkflow({ name: "sched-wf-off", definition: DEFINITION });
    await getDbClient().run(
      `INSERT INTO scripts (id, name, scope, source, description, intent, signatureJson, contentHash)
       VALUES (?, 'sched-script', 'global', 'await a(); await b();', 'fixture', 'fixture', '{}', ?)`,
      [crypto.randomUUID(), crypto.randomUUID()],
    );
    for (const day of WEEK) {
      await workflowRuns(wf.id, day, RUNS_PER_DAY);
      await workflowRuns(wfOff.id, day, RUNS_PER_DAY);
      await scriptRuns(agentId, "sched-script", day, RUNS_PER_DAY);
    }
    const base = { intervalMs: 3_600_000 } as const;
    ids.workflow = (
      await createScheduledTask({
        ...base,
        name: "wf-schedule",
        targetType: "workflow",
        workflowId: wf.id,
      })
    ).id;
    // Two schedules of one workflow share its row.
    ids.workflowTwin = (
      await createScheduledTask({
        ...base,
        name: "wf-schedule-twin",
        targetType: "workflow",
        workflowId: wf.id,
      })
    ).id;
    ids.disabled = (
      await createScheduledTask({
        ...base,
        name: "wf-schedule-off",
        targetType: "workflow",
        workflowId: wfOff.id,
        enabled: false,
      })
    ).id;
    ids.script = (
      await createScheduledTask({
        ...base,
        name: "script-schedule",
        targetType: "script",
        scriptName: "sched-script",
      })
    ).id;
    ids.missingScript = (
      await createScheduledTask({
        ...base,
        name: "ghost-script-schedule",
        targetType: "script",
        scriptName: "ghost-script",
      })
    ).id;
    ids.missingWorkflow = (
      await createScheduledTask({
        ...base,
        name: "ghost-workflow-schedule",
        targetType: "workflow",
        workflowId: crypto.randomUUID(),
      })
    ).id;
    ids.agentTask = (
      await createScheduledTask({ ...base, name: "agent-schedule", taskTemplate: "do the thing" })
    ).id;
    ids.agentTaskIdle = (
      await createScheduledTask({ ...base, name: "idle-agent-schedule", taskTemplate: "nothing" })
    ).id;
    for (const [i, usd] of [0.4, 0.6].entries()) {
      const task = await createTaskExtended(`scheduled task ${i}`, {
        agentId,
        scheduleId: ids.agentTask,
      });
      await getDbClient().run("UPDATE agent_tasks SET createdAt=? WHERE id=?", [
        `${WEEK[3]}T0${i}:00:00.000Z`,
        task.id,
      ]);
      await createSessionCost({
        sessionId: crypto.randomUUID(),
        taskId: task.id,
        agentId,
        totalCostUsd: usd,
        durationMs: 1_800_000,
        numTurns: 3,
        model: "claude-opus-5-5",
      });
    }
    // Outside the 7-day window: not counted.
    const old = await createTaskExtended("old scheduled task", {
      agentId,
      scheduleId: ids.agentTask,
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt=? WHERE id=?", [
      "2026-09-01T00:00:00.000Z",
      old.id,
    ]);

    await runSavingsRollupTick(inProcessSql, { now: NOW });

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
    await resetSavingsRollupForTests();
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("a workflow target returns the workflow's own row", async () => {
    const read = await readScheduleSavings({
      days: 7,
      tier: "smart",
      now: NOW,
      scheduleId: ids.workflow,
    });
    const direct = await readWorkflowSavings({ days: 7, tier: "smart", now: NOW });
    expect(read?.complete).toBe(true);
    expect(read?.rows).toHaveLength(1);
    const [row] = read?.rows ?? [];
    expect(row).toMatchObject({
      basis: "modelled",
      scheduleId: ids.workflow,
      scheduleName: "wf-schedule",
      scheduleEnabled: true,
      name: "sched-wf",
      runs: 7 * RUNS_PER_DAY,
    });
    expect(row?.basis === "modelled" && row.savingUsd.p50).toBe(
      direct.rows.find((r) => r.name === "sched-wf")?.savingUsd.p50 ?? -1,
    );
    expect(row?.basis === "modelled" && row.savingUsd.p50).toBeGreaterThan(0);
  });

  test("a script target returns the scheduled script's row", async () => {
    const read = await readScheduleSavings({
      days: 7,
      tier: "smart",
      now: NOW,
      scheduleId: ids.script,
    });
    const direct = await readScriptSavings({
      days: 7,
      tier: "smart",
      now: NOW,
      scriptName: "sched-script",
    });
    expect(read?.rows).toHaveLength(1);
    expect(read?.rows[0]).toMatchObject({
      basis: "modelled",
      kind: "script-scheduled",
      scriptName: "sched-script",
      runs: 7 * RUNS_PER_DAY,
    });
    const row = read?.rows[0];
    expect(row?.basis === "modelled" && row.savingUsd.p50).toBe(
      direct.rows[0]?.savingUsd.p50 ?? -1,
    );
  });

  test("an agent-task target shows measured spend and no saving", async () => {
    const { status, body } = await get(`scheduleId=${ids.agentTask}&days=7`);
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.total).toBeNull();
    expect(body.rows).toEqual([
      {
        kind: "agent-task-schedule",
        scheduleId: ids.agentTask,
        scheduleName: "agent-schedule",
        scheduleEnabled: true,
        name: "agent-schedule",
        basis: "measured",
        runs: 2,
        actualUsd: 1,
        actualHours: 1,
        savingUsd: null,
      },
    ]);
  });

  test("an agent-task schedule with no tasks in the window has no row", async () => {
    const { body } = await get(`scheduleId=${ids.agentTaskIdle}&days=7`);
    expect(body).toMatchObject({ valid: false, reason: "no-runs", rows: [] });
  });

  test("a disabled schedule is priced from its target's runs and flagged", async () => {
    const { body } = await get(`scheduleId=${ids.disabled}&days=7`);
    expect(body.valid).toBe(true);
    expect(body.rows[0]).toMatchObject({
      scheduleId: ids.disabled,
      scheduleEnabled: false,
      name: "sched-wf-off",
      scope: "target-job",
      runs: 7 * RUNS_PER_DAY,
    });
  });

  test("a missing target is reported, not priced as $0", async () => {
    for (const id of [ids.missingScript, ids.missingWorkflow]) {
      const { status, body } = await get(`scheduleId=${id}&days=7`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ valid: false, reason: "target-missing", rows: [], total: null });
    }
  });

  test("an unknown schedule is a 404 and a second target parameter a 400", async () => {
    expect((await get("scheduleId=nope&days=7")).status).toBe(404);
    expect((await get(`scheduleId=${ids.script}&kind=schedule`)).status).toBe(400);
  });

  test("kind=schedule lists every schedule with a row; schedules of one target share it", async () => {
    const { status, body } = await get("kind=schedule&days=7");
    expect(status).toBe(200);
    expect(body.total).toBeNull();
    const byName = Object.fromEntries(
      body.rows.map((r: { scheduleName: string }) => [r.scheduleName, r]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "agent-schedule",
      "script-schedule",
      "wf-schedule",
      "wf-schedule-off",
      "wf-schedule-twin",
    ]);
    expect(byName["wf-schedule-twin"].savingUsd).toEqual(byName["wf-schedule"].savingUsd);
    // Modelled rows first, by saving; measured rows last.
    expect(body.rows.at(-1).basis).toBe("measured");
  });

  test("before the first tick the schedule window is not computed", async () => {
    await getDbClient().run("DELETE FROM automation_savings_days");
    const read = await readScheduleSavings({ days: 7, tier: "smart", now: NOW });
    expect(read?.complete).toBe(false);
    const { body } = await get("kind=schedule&days=7");
    expect(body).toMatchObject({ valid: false, reason: "not-computed", rows: [] });
  });
});
