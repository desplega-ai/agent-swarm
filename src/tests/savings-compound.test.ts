import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  initDb,
  recordInlineScriptRun,
  upsertSwarmConfig,
} from "../be/db";
import type { SavingsSql } from "../be/savings/compute";
import {
  CURVE,
  type CurveSet,
  MODEL_VERSION,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
} from "../be/savings/model";
import {
  readScriptSavings,
  readWorkflowComponents,
  readWorkflowSavings,
  resetSavingsReadCache,
} from "../be/savings/read";
import { resetSavingsRollupForTests, runSavingsRollupTick } from "../be/savings/rollup";
import { mintScriptRunToken, resolveSessionToken } from "../be/users";
import { clearCalibrationCache, handleSavings, resetSavingsRefreshCache } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-savings-compound.sqlite";
// The route reads the window ending at the real clock, so the fixture lives two days back.
const NOW = Date.now();
const DAY = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
const at = (sec: number) => new Date(Date.parse(`${DAY}T10:00:00.000Z`) + sec * 1000).toISOString();

// The route's refresh path reads the DB file from a child process, so this
// file opts out of the in-memory template (as savings-rollup.test.ts does).
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedCompoundTemplate?: Uint8Array;
};

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

async function run(
  id: string,
  workflowId: string,
  trigger: string,
  startedAt: string,
  extra: { parentStepId?: string; sourceStepId?: string } = {},
) {
  await getDbClient().run(
    `INSERT INTO workflow_runs (id, workflowId, triggerType, status, startedAt, parentStepId, parentStepAttempt, sourceStepId)
     VALUES (?, ?, ?, 'completed', ?, ?, 0, ?)`,
    [id, workflowId, trigger, startedAt, extra.parentStepId ?? null, extra.sourceStepId ?? null],
  );
}

async function step(
  id: string,
  runId: string,
  nodeId: string,
  nodeType: string,
  startedAt: string,
  output: unknown = null,
) {
  await getDbClient().run(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt, output)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
    [
      id,
      runId,
      nodeId,
      nodeType,
      startedAt,
      new Date(Date.parse(startedAt) + 2000).toISOString(),
      output === null ? null : JSON.stringify(output),
    ],
  );
}

/** Run `fn` with the request auth of a script run's token carrying `provenance`. */
async function asScriptRun<T>(
  agentId: string,
  provenance: { sourceStepId?: string | null; sourceScriptRunId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  return await Promise.resolve().then(async () => {
    beginRequestAuthScope();
    setRequestAuth({} as IncomingMessage, {
      kind: "agent",
      tokenKind: "agent",
      agentId,
      taskId: null,
      runtimeId: null,
      tokenId: "t",
      expiresAt: "9999-12-31T00:00:00.000Z",
      ...provenance,
    });
    return await fn();
  });
}

describe("savings with components", () => {
  let agentId: string;
  let root: string;
  let child: string;
  let grandchild: string;
  let other: string;
  let leaf: string;
  let server: Server;
  let port: number;

  async function cost(taskId: string, usd: number) {
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId,
      agentId,
      totalCostUsd: usd,
      durationMs: 60_000,
      numTurns: 3,
      model: "claude-opus-5-5",
    });
  }

  async function task(createdAt: string, opts: Parameters<typeof createTaskExtended>[1]) {
    const t = await createTaskExtended(`compound fixture ${createdAt}`, { agentId, ...opts });
    await getDbClient().run("UPDATE agent_tasks SET createdAt=? WHERE id=?", [createdAt, t.id]);
    return t.id;
  }

  const get = async (query: string) => {
    resetSavingsRefreshCache();
    const res = await fetch(`http://127.0.0.1:${port}/api/savings/jobs?${query}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    testGlobals.__savedCompoundTemplate = testGlobals.__testMigrationTemplate;
    testGlobals.__testMigrationTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    await resetSavingsRollupForTests();
    agentId = (await createAgent({ name: "compound-agent", isLead: false, status: "idle" })).id;
    for (const [name, source] of [
      ["compound-starter", "await ctx.swarm.workflow_trigger({}); await ctx.swarm.task_send({});"],
      ["compound-helper", "await a(); await b(); await c();"],
    ] as const) {
      await getDbClient().run(
        `INSERT INTO scripts (id, name, scope, source, description, intent, signatureJson, contentHash)
         VALUES (?, ?, 'global', ?, 'savings fixture', 'fixture', '{}', ?)`,
        [
          crypto.randomUUID(),
          name,
          `export default async function (args, ctx) { ${source} }`,
          crypto.randomUUID(),
        ],
      );
    }
    const notify = { nodes: [{ id: "hello", type: "notify", config: {} }] };
    root = (
      await createWorkflow({
        name: "compound-root",
        definition: { nodes: [{ id: "dispatch", type: "sub-workflow", config: {} }] },
      })
    ).id;
    const starter = {
      nodes: [
        { id: "start", type: "swarm-script", config: { scriptName: "compound-starter" } },
        { id: "work", type: "agent-task", config: {} },
        { id: "back", type: "sub-workflow", config: {} },
      ],
    };
    child = (await createWorkflow({ name: "compound-child", definition: starter })).id;
    other = (await createWorkflow({ name: "compound-other", definition: starter })).id;
    grandchild = (await createWorkflow({ name: "compound-grandchild", definition: notify })).id;
    leaf = (await createWorkflow({ name: "compound-leaf", definition: notify })).id;

    // root -> child: four sub-workflow runs. Each child run's script step
    // starts a grandchild run named in its output (unstamped, 2 s in).
    for (let i = 1; i <= 4; i++) {
      await run(`r${i}`, root, "manual", at(i * 60));
      await step(`r${i}-dispatch`, `r${i}`, "dispatch", "sub-workflow", at(i * 60));
      await run(`c${i}`, child, "manual", at(i * 60 + 1), { parentStepId: `r${i}-dispatch` });
      await step(`c${i}-start`, `c${i}`, "start", "swarm-script", at(i * 60 + 1), {
        result: { started: `00000000-0000-4000-8000-00000000000${i}` },
      });
      await run(`00000000-0000-4000-8000-00000000000${i}`, grandchild, "api", at(i * 60 + 2));
    }
    // A cycle: one child run starts a root run as its sub-workflow.
    await step("c4-back", "c4", "back", "sub-workflow", at(4 * 60 + 1));
    await run("r5", root, "manual", at(4 * 60 + 2), { parentStepId: "c4-back" });
    // Stamped wins: c1's output also names this grandchild run, but its run
    // token said compound-other's step started it.
    await run("x1", other, "manual", at(30));
    await step("x1-start", "x1", "start", "swarm-script", at(30), {});
    await getDbClient().run("UPDATE workflow_run_steps SET output=? WHERE id='c1-start'", [
      JSON.stringify({
        result: {
          started: "00000000-0000-4000-8000-000000000001",
          seen: "00000000-0000-4000-8000-000000000009",
        },
      }),
    ]);
    await run("00000000-0000-4000-8000-000000000009", grandchild, "api", at(61), {
      sourceStepId: "x1-start",
    });
    // child's agent-task node task ($0.50) with a descendant ($2), and a task
    // its script step created ($1), named in the step output.
    const nodeTask = await task(at(62), { source: "workflow", workflowRunId: "c1" });
    await cost(nodeTask, 0.5);
    const below = await task(at(63), { parentTaskId: nodeTask });
    await cost(below, 2);
    const fromStep = await task(at(3 * 60 + 2), {});
    await cost(fromStep, 1);
    await getDbClient().run("UPDATE workflow_run_steps SET output=? WHERE id='c3-start'", [
      JSON.stringify({
        result: { started: "00000000-0000-4000-8000-000000000003", task: fromStep },
      }),
    ]);
    // A nested script run made under c2's step token.
    await getDbClient().run(
      `INSERT INTO script_runs (id, agentId, scriptName, source, args, kind, status, startedAt, finishedAt, sourceStepId)
       VALUES ('nested-1', ?, 'compound-helper', '', 'null', 'inline', 'completed', ?, ?, 'c2-start')`,
      [agentId, at(2 * 60 + 1), at(2 * 60 + 2)],
    );
    // That nested run created a task through its own token: an exact effect
    // link, though compound-helper's source cannot dispatch.
    await getDbClient().run("UPDATE agent_tasks SET sourceScriptRunId='nested-1' WHERE id=?", [
      await task(at(2 * 60 + 2), {}),
    ]);
    // A leaf workflow with nothing below it.
    for (let i = 1; i <= 3; i++) {
      await run(`l${i}`, leaf, "manual", at(600 + i));
      await step(`l${i}-hello`, `l${i}`, "hello", "notify", at(600 + i));
    }

    const stats = await runSavingsRollupTick(inProcessSql, { now: NOW });
    expect(stats.lastError).toBeNull();

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
    testGlobals.__testMigrationTemplate = testGlobals.__savedCompoundTemplate;
    testGlobals.__savedCompoundTemplate = undefined;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("the rollup writes one link row per parent, child and kind", async () => {
    const links = await getDbClient().query<Record<string, unknown>>(
      "SELECT parentJobId, childKind, childJobId, linkKind, n, actualUsd FROM automation_savings_links WHERE day=? ORDER BY 1,2,3,4",
      [DAY],
    );
    const named = links.map((l) => ({ ...l, actualUsd: Number(l.actualUsd) }));
    expect(named).toEqual(
      expect.arrayContaining([
        {
          parentJobId: root,
          childKind: "workflow",
          childJobId: child,
          linkKind: "sub-workflow",
          n: 4,
          actualUsd: 0,
        },
        {
          parentJobId: child,
          childKind: "workflow",
          childJobId: root,
          linkKind: "sub-workflow",
          n: 1,
          actualUsd: 0,
        },
        {
          parentJobId: child,
          childKind: "workflow",
          childJobId: grandchild,
          linkKind: "step-workflow",
          n: 4,
          actualUsd: 0,
        },
        {
          parentJobId: other,
          childKind: "workflow",
          childJobId: grandchild,
          linkKind: "step-workflow",
          n: 1,
          actualUsd: 0,
        },
        {
          parentJobId: child,
          childKind: "script",
          childJobId: "compound-helper",
          linkKind: "step-script",
          n: 1,
          actualUsd: 0,
        },
        {
          parentJobId: child,
          childKind: "task",
          childJobId: "",
          linkKind: "step-task",
          n: 1,
          actualUsd: 1,
        },
        {
          parentJobId: child,
          childKind: "task",
          childJobId: "",
          linkKind: "descendant-task",
          n: 1,
          actualUsd: 2,
        },
      ]),
    );
    expect(links).toHaveLength(7);
  });

  test("a task stamped with its script run is that run's effect", async () => {
    const bucket = await getDbClient().get<{ effectRuns: number }>(
      "SELECT effectRuns FROM automation_savings_daily WHERE day=? AND jobKind='script' AND jobId='compound-helper'",
      [DAY],
    );
    expect(bucket?.effectRuns).toBe(1);
  });

  test("stamped rows win over the output-id link", async () => {
    const { body } = await get(`workflowId=${other}&components=true&days=7`);
    expect(body.components).toEqual([
      expect.objectContaining({ kind: "workflow", workflowId: grandchild, runs: 1, depth: 1 }),
    ]);
  });

  test("the tree equals the sum of the rows it reaches", async () => {
    const { status, body } = await get(`workflowId=${root}&components=true&days=7`);
    expect(status).toBe(200);
    const workflows = await readWorkflowSavings({ days: 7, tier: "smart", now: Date.now() });
    const scripts = await readScriptSavings({ days: 7, tier: "smart", now: Date.now() });
    const row = (id: string) => workflows.rows.find((r) => r.workflowId === id)!;
    const helper = scripts.rows.find((r) => r.scriptName === "compound-helper")!;
    // child: 4 of its 4 runs; grandchild: 4 of its 5 runs; helper: 1 of 1. The
    // cycle back to the root and the child's own tasks add nothing.
    const expected =
      row(root).savingUsd.p50 +
      row(child).savingUsd.p50 +
      (row(grandchild).savingUsd.p50 * 4) / 5 +
      helper.savingUsd.p50;
    expect(body.withComponents.savingUsd.p50).toBeCloseTo(expected, 1);
    expect(body.rows[0].savingUsd.p50).toBeCloseTo(row(root).savingUsd.p50, 2);
    expect(body.components.map((c: any) => [c.kind, c.name, c.depth, c.runs])).toEqual(
      expect.arrayContaining([
        ["workflow", "compound-child", 1, 4],
        ["workflow", "compound-grandchild", 2, 4],
        ["script", "compound-helper", 2, 1],
      ]),
    );
    expect(body.components).toHaveLength(3);
  });

  test("a stored deployment curve prices the components as it prices the root", async () => {
    const deployed = Object.fromEntries(
      SAVINGS_TIERS.map((t) => [
        t,
        { usd: CURVE[t].usd.map((v, i) => v * 3 + i * 0.01), hrs: CURVE[t].hrs },
      ]),
    ) as CurveSet;
    const expectedTree = async (set?: CurveSet) => {
      const now = Date.now();
      const workflows = await readWorkflowSavings({ days: 7, tier: "smart", now, curve: set });
      const scripts = await readScriptSavings({ days: 7, tier: "smart", now, curve: set });
      const row = (id: string) => workflows.rows.find((r) => r.workflowId === id)!;
      const helper = scripts.rows.find((r) => r.scriptName === "compound-helper")!;
      return (
        row(root).savingUsd.p50 +
        row(child).savingUsd.p50 +
        (row(grandchild).savingUsd.p50 * 4) / 5 +
        helper.savingUsd.p50
      );
    };
    try {
      await upsertSwarmConfig({
        scope: "global",
        key: SAVINGS_CALIBRATION_KEY,
        value: JSON.stringify({
          calibratedAt: "2026-12-01",
          model: "claude-opus-5-5",
          curve: deployed,
        }),
      });
      clearCalibrationCache();
      resetSavingsRefreshCache();
      const { body } = await get(`workflowId=${root}&components=true&days=7`);
      expect(body.calibrationSource).toBe("deployment");
      const shipped = await expectedTree();
      const withCurve = await expectedTree(deployed);
      expect(withCurve).toBeGreaterThan(shipped * 2);
      expect(body.withComponents.savingUsd.p50).toBeCloseTo(withCurve, 1);
    } finally {
      await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", [SAVINGS_CALIBRATION_KEY]);
      clearCalibrationCache();
      resetSavingsRefreshCache();
    }
  });

  test("unowned tasks show on their workflow and count in its own row", async () => {
    const { body } = await get(`workflowId=${child}&components=true&days=7`);
    const tasks = body.components.filter((c: any) => c.kind === "task");
    expect(tasks.map((t: any) => [t.linkKind, t.runs, t.actualUsd, t.inOwnRow])).toEqual(
      expect.arrayContaining([
        ["step-task", 1, 1, true],
        ["descendant-task", 1, 2, true],
      ]),
    );
    // $0.50 node task + $2 descendant + $1 step task, all measured on the own row.
    expect(body.rows[0].measuredUsd).toBeCloseTo(3.5, 2);
  });

  test("a leaf workflow has no components and equals its own runs", async () => {
    const { body } = await get(`workflowId=${leaf}&components=true&days=7`);
    expect(body.components).toEqual([]);
    expect(body.withComponents.savingUsd).toEqual(body.total.savingUsd);
  });

  test("lists stay own runs only", async () => {
    const before = await get("kind=workflow&days=7");
    await get(`workflowId=${root}&components=true&days=7`);
    const after = await get("kind=workflow&days=7");
    expect(after.body.total).toEqual(before.body.total);
    const own = before.body.rows.reduce((s: number, r: any) => s + r.savingUsd.p50, 0);
    expect(before.body.total.savingUsd.p50).toBeCloseTo(own, 1);
    expect(before.body.components).toBeUndefined();
    expect((await get("kind=workflow&components=true")).status).toBe(400);
    expect((await get("scriptName=compound-helper&components=true")).status).toBe(400);
  });

  test("a burst of component reads shares one tree for a minute", async () => {
    const read = async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/savings/jobs?workflowId=${leaf}&components=true&days=7`,
      );
      return ((await res.json()) as Record<string, any>).components as unknown[];
    };
    resetSavingsRefreshCache();
    expect(await read()).toEqual([]);
    // A link the held tree has not seen: reads inside the minute keep the held tree.
    await getDbClient().run(
      `INSERT INTO automation_savings_links (day, parentJobId, childKind, childJobId, linkKind, n, actualUsd, keptUsd, modelVersion, computedAt)
       VALUES (?, ?, 'workflow', ?, 'step-workflow', 1, 0, 0, ?, ?)`,
      [DAY, leaf, child, MODEL_VERSION, new Date().toISOString()],
    );
    try {
      expect(await Promise.all([read(), read()])).toEqual([[], []]);
      resetSavingsRefreshCache();
      expect(await read()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "workflow", workflowId: child, depth: 1 }),
        ]),
      );
    } finally {
      await getDbClient().run("DELETE FROM automation_savings_links WHERE parentJobId=?", [leaf]);
    }
  });
});

describe("run provenance stamping", () => {
  let agentId: string;
  let workflowId: string;

  beforeAll(async () => {
    initDb(":memory:");
    agentId = (await createAgent({ name: "stamp-agent", isLead: false, status: "idle" })).id;
    workflowId = (await createWorkflow({ name: "stamp-wf", definition: { nodes: [] } })).id;
  });

  afterAll(() => closeDb());

  test("a script run token carries its step and run back to the request", async () => {
    const token = await mintScriptRunToken(agentId, 60_000, {
      sourceStepId: "step-1",
      sourceScriptRunId: "run-1",
    });
    const plain = await mintScriptRunToken(agentId, 60_000);
    expect(await resolveSessionToken(token.plaintext)).toMatchObject({
      kind: "agent",
      sourceStepId: "step-1",
      sourceScriptRunId: "run-1",
    });
    expect(await resolveSessionToken(plain.plaintext)).not.toHaveProperty("sourceStepId");
  });

  test("rows a script run creates are stamped; rows a workflow owns are not", async () => {
    const ownerRun = await createWorkflowRun({ id: crypto.randomUUID(), workflowId });
    const stamped = await asScriptRun(
      agentId,
      { sourceStepId: "step-1", sourceScriptRunId: "run-1" },
      async () => {
        const task = await createTaskExtended("made by a script", { agentId });
        const owned = await createTaskExtended("node task", {
          agentId,
          workflowRunId: ownerRun.id,
        });
        const manual = await createWorkflowRun({ id: crypto.randomUUID(), workflowId });
        const event = await createWorkflowRun({
          id: crypto.randomUUID(),
          workflowId,
          triggerType: "event",
        });
        const sub = await createWorkflowRun({
          id: crypto.randomUUID(),
          workflowId,
          parentStepId: "parent-step",
        });
        const nested = await recordInlineScriptRun({
          id: crypto.randomUUID(),
          agentId,
          source: "",
          args: null,
          scriptName: "nested",
          status: "completed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return { task, owned, manual, event, sub, nested };
      },
    );
    const col = async (table: string, id: string, column: string) =>
      (
        await getDbClient().get<Record<string, unknown>>(
          `SELECT ${column} v FROM ${table} WHERE id=?`,
          [id],
        )
      )?.v;
    expect(await col("agent_tasks", stamped.task.id, "sourceStepId")).toBe("step-1");
    expect(await col("agent_tasks", stamped.task.id, "sourceScriptRunId")).toBe("run-1");
    expect(await col("agent_tasks", stamped.owned.id, "sourceStepId")).toBeNull();
    expect(await col("workflow_runs", stamped.manual.id, "sourceStepId")).toBe("step-1");
    expect(await col("workflow_runs", stamped.event.id, "sourceStepId")).toBeNull();
    expect(await col("workflow_runs", stamped.sub.id, "sourceStepId")).toBeNull();
    expect(await col("script_runs", stamped.nested.id, "sourceStepId")).toBe("step-1");
    expect(await col("script_runs", stamped.nested.id, "parentScriptRunId")).toBe("run-1");

    // Outside a script run's request nothing is stamped.
    const plain = await createTaskExtended("made by hand", { agentId });
    expect(await col("agent_tasks", plain.id, "sourceStepId")).toBeNull();
  });
});

describe("each task counts under one root", () => {
  let agentId: string;
  let chained: string;
  let nodeOwned: string;
  let crossDay: string;
  const chain: string[] = [];
  // Two closed days: D1 then D2.
  const D1 = new Date(NOW - 3 * 86_400_000).toISOString().slice(0, 10);
  const D2 = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
  const on = (day: string, sec: number) =>
    new Date(Date.parse(`${day}T10:00:00.000Z`) + sec * 1000).toISOString();

  async function task(
    createdAt: string,
    usd: number,
    opts: { parentTaskId?: string; workflowRunId?: string; sourceStepId?: string } = {},
  ) {
    const t = await createTaskExtended(`root fixture ${createdAt}`, {
      agentId,
      ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
      ...(opts.workflowRunId ? { source: "workflow", workflowRunId: opts.workflowRunId } : {}),
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt=?, sourceStepId=? WHERE id=?", [
      createdAt,
      opts.sourceStepId ?? null,
      t.id,
    ]);
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: t.id,
      agentId,
      totalCostUsd: usd,
      durationMs: 60_000,
      numTurns: 3,
      model: "claude-opus-5-5",
    });
    return t.id;
  }

  const childTaskUsd = async (day: string, workflowId: string) =>
    Number(
      (
        await getDbClient().get<{ v: number }>(
          "SELECT childTaskUsd v FROM automation_savings_daily WHERE day=? AND jobKind='workflow' AND jobId=?",
          [day, workflowId],
        )
      )?.v,
    );

  beforeAll(async () => {
    initDb(":memory:");
    await resetSavingsRollupForTests();
    agentId = (await createAgent({ name: "roots-agent", isLead: false, status: "idle" })).id;
    const scripted = {
      nodes: [
        { id: "start", type: "swarm-script", config: { scriptName: "roots-helper" } },
        { id: "work", type: "agent-task", config: {} },
      ],
    };
    chained = (await createWorkflow({ name: "roots-chained", definition: scripted })).id;
    nodeOwned = (await createWorkflow({ name: "roots-node", definition: scripted })).id;
    crossDay = (await createWorkflow({ name: "roots-cross-day", definition: scripted })).id;

    // Step task A ($1) and step task B ($2) below it: 3, not 5.
    await run("ca", chained, "manual", on(D1, 0));
    await step("ca-start", "ca", "start", "swarm-script", on(D1, 0));
    const a = await task(on(D1, 1), 1, { sourceStepId: "ca-start" });
    await task(on(D1, 2), 2, { sourceStepId: "ca-start", parentTaskId: a });

    // Node task N ($0.50, its own row) with a stamped child B ($2): 2, not 4.
    await run("na", nodeOwned, "manual", on(D1, 10));
    await step("na-start", "na", "start", "swarm-script", on(D1, 10));
    const n = await task(on(D1, 11), 0.5, { workflowRunId: "na" });
    await task(on(D1, 12), 2, { sourceStepId: "na-start", parentTaskId: n });

    // Across midnight: step task A on D1 ($1), its unstamped child C on D2
    // ($4, A's), and a stamped child B on D2 ($2, D2's own root).
    await run("xa", crossDay, "manual", on(D1, 20));
    await step("xa-start", "xa", "start", "swarm-script", on(D1, 20));
    await run("xb", crossDay, "manual", on(D2, 20));
    await step("xb-start", "xb", "start", "swarm-script", on(D2, 20));
    const x = await task(on(D1, 21), 1, { sourceStepId: "xa-start" });
    await task(on(D2, 22), 4, { parentTaskId: x });
    await task(on(D2, 23), 2, { sourceStepId: "xb-start", parentTaskId: x });

    // A chain of 12 workflows, each run starting the next as a sub-workflow.
    for (let i = 0; i < 12; i++) {
      chain.push(
        (
          await createWorkflow({
            name: `roots-chain-${i}`,
            definition: { nodes: [{ id: "next", type: "sub-workflow", config: {} }] },
          })
        ).id,
      );
      await run(`q${i}`, chain[i] as string, "manual", on(D1, 100 + i), {
        ...(i > 0 ? { parentStepId: `q${i - 1}-next` } : {}),
      });
      await step(`q${i}-next`, `q${i}`, "next", "sub-workflow", on(D1, 100 + i));
    }

    for (let i = 0; i < 5; i++) {
      const stats = await runSavingsRollupTick(inProcessSql, { now: NOW, budgetMs: 60_000 });
      expect(stats.lastError).toBeNull();
      if (stats.daysPending === 0) break;
    }
  });

  afterAll(async () => {
    await resetSavingsRollupForTests();
    closeDb();
  });

  test("a step task below another step task counts once", async () => {
    expect(await childTaskUsd(D1, chained)).toBeCloseTo(3, 6);
  });

  test("a stamped task below a node task counts under its own step", async () => {
    expect(await childTaskUsd(D1, nodeOwned)).toBeCloseTo(2, 6);
  });

  test("a chain across midnight splits at the stamped task", async () => {
    expect(await childTaskUsd(D1, crossDay)).toBeCloseTo(5, 6);
    expect(await childTaskUsd(D2, crossDay)).toBeCloseTo(2, 6);
  });

  test("the kept spend moves measured spend, not the saving", async () => {
    const read = async () =>
      (await readWorkflowSavings({ days: 7, tier: "smart", now: NOW })).rows.find(
        (r) => r.workflowId === chained,
      )!;
    const counted = await read();
    await getDbClient().run(
      "UPDATE automation_savings_daily SET childTaskUsd=0, childTaskMs=0 WHERE jobKind='workflow' AND jobId=?",
      [chained],
    );
    // A raw UPDATE bypasses the rollup writers, so drop the cached fleet read by hand.
    resetSavingsReadCache();
    const without = await read();
    expect(counted.measuredUsd - without.measuredUsd).toBeCloseTo(3, 6);
    expect(counted.savingUsd.p50).toBeGreaterThan(0);
    for (const q of ["p10", "p50", "p90"] as const) {
      expect(counted.savingUsd[q]).toBeCloseTo(without.savingUsd[q], 9);
    }
  });

  test("the component tree stops at depth 10", async () => {
    const own = (await readWorkflowSavings({ days: 7, tier: "smart", now: NOW })).rows.find(
      (r) => r.workflowId === chain[0],
    )!;
    const tree = await readWorkflowComponents({
      days: 7,
      tier: "smart",
      now: NOW,
      workflowId: chain[0] as string,
      own,
    });
    const depthOf = new Map(tree.components.map((c) => [c.workflowId, c.depth]));
    expect(Math.max(...depthOf.values())).toBe(10);
    expect(depthOf.get(chain[10])).toBe(10);
    expect(depthOf.has(chain[11])).toBe(false);
    expect(tree.components).toHaveLength(10);
  });

  test("links on the window's partial first day count by the share inside it", async () => {
    const own = (await readWorkflowSavings({ days: 7, tier: "smart", now: NOW })).rows.find(
      (r) => r.workflowId === chain[0],
    )!;
    const parent = "boundary-root";
    // 7 x 24h ending 06:00 starts at 06:00 on the first day: 18 of its 24 hours count.
    const now = Date.parse("2030-01-08T06:00:00.000Z");
    const link = (day: string, n: number) =>
      getDbClient().run(
        `INSERT INTO automation_savings_links (day, parentJobId, childKind, childJobId, linkKind, n, actualUsd, keptUsd, modelVersion, computedAt)
         VALUES (?, ?, 'workflow', 'boundary-child', 'step-workflow', ?, 0, 0, ?, ?)`,
        [day, parent, n, MODEL_VERSION, new Date().toISOString()],
      );
    await link("2029-12-31", 2);
    await link("2030-01-01", 4);
    await link("2030-01-05", 1);
    try {
      const tree = await readWorkflowComponents({
        days: 7,
        tier: "smart",
        now,
        workflowId: parent,
        own: { ...own, workflowId: parent },
      });
      expect(tree.components).toHaveLength(1);
      expect(tree.components[0]!.runs).toBeCloseTo(4 * 0.75 + 1, 9);
    } finally {
      await getDbClient().run("DELETE FROM automation_savings_links WHERE parentJobId=?", [parent]);
    }
  });
});
