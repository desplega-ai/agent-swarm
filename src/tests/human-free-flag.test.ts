import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createSessionCost,
  createTaskExtended,
  createUser,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  getSessionCostSummary,
  initDb,
} from "../be/db";
import { createTask } from "../be/db/tasks/write";
import { expectFlagsMatchLegacy, legacyHumanFreeIds, storedFlags } from "./human-free-oracle";

const TEST_DB_PATH = "./test-human-free-flag.sqlite";

describe("agent_tasks.isHumanFree", () => {
  const named: Record<string, string> = {};

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);

    const user = await createUser({ name: "Flag Requester" });
    const otherUser = await createUser({ name: "Flag Other Requester" });
    const remember = async (name: string, task: Promise<{ id: string }>) => {
      named[name] = (await task).id;
    };

    // Root rules.
    await remember("human", createTaskExtended("Human work", { requestedByUserId: user.id }));
    await remember("heartbeat", createTaskExtended("hb", { taskType: "heartbeat" }));
    await remember("checklist", createTaskExtended("hb", { taskType: "heartbeat-checklist" }));
    await remember("bootTriage", createTaskExtended("bt", { taskType: "boot-triage" }));
    await remember(
      "staleRequesterHeartbeat",
      createTaskExtended("hb", { taskType: "heartbeat", requestedByUserId: user.id }),
    );
    await remember("tagHeartbeat", createTaskExtended("tag", { tags: ["heartbeat"] }));
    // LIKE is case-insensitive, so the stored flag must be too.
    await remember("tagHeartbeatCase", createTaskExtended("tag", { tags: ["Heartbeat"] }));
    await remember("tagLookalike", createTaskExtended("tag", { tags: ["heartbeat-ish"] }));
    await remember("schedule", createTaskExtended("sched", { source: "schedule" }));
    await remember(
      "humanSchedule",
      createTaskExtended("sched", { source: "schedule", requestedByUserId: user.id }),
    );

    // Propagation below a human-free root.
    await remember(
      "scheduleChild",
      createTaskExtended("child", { parentTaskId: named.schedule as string }),
    );
    await remember(
      "scheduleGrandchild",
      createTaskExtended("grandchild", { parentTaskId: named.scheduleChild as string }),
    );
    await remember(
      "handoff",
      createTaskExtended("handoff", {
        parentTaskId: named.schedule as string,
        requestedByUserId: user.id,
      }),
    );
    await remember(
      "handoffChild",
      createTaskExtended("below a handoff", { parentTaskId: named.handoff as string }),
    );
    // A requester copied from a stale-attributed heartbeat does not stop propagation.
    await remember(
      "inheritedChild",
      createTaskExtended("inherited", { parentTaskId: named.staleRequesterHeartbeat as string }),
    );
    await remember(
      "explicitBelowStale",
      createTaskExtended("explicit", {
        parentTaskId: named.staleRequesterHeartbeat as string,
        requestedByUserId: otherUser.id,
      }),
    );

    // `source = system`: free only when the parent has no requester.
    await remember(
      "systemUnderHuman",
      createTaskExtended("sys", { source: "system", parentTaskId: named.human as string }),
    );
    await remember(
      "systemUnderFree",
      createTaskExtended("sys", { source: "system", parentTaskId: named.schedule as string }),
    );
    const requesterless = await createTaskExtended("requesterless root");
    named.requesterless = requesterless.id;
    await remember(
      "systemUnderRequesterless",
      createTaskExtended("sys", { source: "system", parentTaskId: requesterless.id }),
    );
    await remember("systemRoot", createTaskExtended("sys", { source: "system" }));

    // Workflow roots follow the run's trigger and creator, not the task's own fields.
    const workflow = await createWorkflow({
      name: `human-free-flag-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const freeSchedule = await createScheduledTask({
      name: `flag-free-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: workflow.id,
    });
    const humanSchedule = await createScheduledTask({
      name: `flag-human-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: workflow.id,
      createdBy: user.id,
    });
    const freeRun = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerType: "schedule",
      triggerData: { scheduleId: freeSchedule.id },
    });
    const humanRun = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerType: "schedule",
      triggerData: { scheduleId: humanSchedule.id },
      createdBy: user.id,
    });
    const manualRun = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerData: { triggerType: "schedule", scheduleId: freeSchedule.id },
    });
    await remember(
      "workflowFreeRoot",
      createTaskExtended("wf", { source: "workflow", workflowRunId: freeRun.id }),
    );
    await remember(
      "workflowFreeChild",
      createTaskExtended("wf child", {
        source: "workflow",
        workflowRunId: freeRun.id,
        parentTaskId: named.workflowFreeRoot as string,
      }),
    );
    await remember(
      "workflowHumanRoot",
      createTaskExtended("wf", {
        source: "workflow",
        workflowRunId: humanRun.id,
        requestedByUserId: user.id,
      }),
    );
    await remember(
      "workflowManualRoot",
      createTaskExtended("wf", { source: "workflow", workflowRunId: manualRun.id }),
    );

    // The minimal insert path.
    named.minimalDefault = (await createTask("agent-flag", "minimal")).id;
    named.minimalSchedule = (await createTask("agent-flag", "minimal", { source: "schedule" })).id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("is set at creation to exactly what the recursive CTE selected", async () => {
    const flags = await storedFlags();
    const legacy = await legacyHumanFreeIds();

    // The matrix must exercise both outcomes, or the comparison proves nothing.
    expect(legacy.size).toBeGreaterThan(8);
    expect(flags.size - legacy.size).toBeGreaterThan(5);
    expectFlagsMatchLegacy(flags, legacy);
  });

  test("classifies each rule and propagation case", async () => {
    const flags = await storedFlags();
    const expected: Record<string, boolean> = {
      human: false,
      heartbeat: true,
      checklist: true,
      bootTriage: true,
      staleRequesterHeartbeat: true,
      tagHeartbeat: true,
      tagHeartbeatCase: true,
      tagLookalike: false,
      schedule: true,
      humanSchedule: false,
      scheduleChild: true,
      scheduleGrandchild: true,
      handoff: false,
      handoffChild: false,
      inheritedChild: true,
      explicitBelowStale: false,
      systemUnderHuman: false,
      systemUnderFree: true,
      requesterless: false,
      systemUnderRequesterless: true,
      systemRoot: false,
      workflowFreeRoot: true,
      workflowFreeChild: true,
      workflowHumanRoot: false,
      workflowManualRoot: false,
      minimalDefault: false,
      minimalSchedule: true,
    };
    const actual = Object.fromEntries(
      Object.keys(expected).map((name) => [name, flags.get(named[name] as string)]),
    );
    expect(actual).toEqual(expected);
  });

  test("migration 182 backfill selects the same tasks as creation-time classification", async () => {
    const before = await storedFlags();
    const sql = await Bun.file("src/be/migrations/182_task_human_free_flag.sql").text();
    const start = sql.indexOf("WITH RECURSIVE");
    const endMarker = "WHERE id IN (SELECT id FROM human_free_tasks);";
    const end = sql.indexOf(endMarker) + endMarker.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(endMarker.length);

    await getDbClient().run("UPDATE agent_tasks SET isHumanFree = 0");
    await getDbClient().run(sql.slice(start, end));

    expect(await storedFlags()).toEqual(before);
  });

  test("summary splits human-free and attributed spend from the stored flag", async () => {
    const agent = await createAgent({ name: "Flag Agent", isLead: false, status: "idle" });
    for (const [name, cost] of [
      ["human", 1],
      ["heartbeat", 2],
      ["scheduleChild", 4],
      ["handoff", 8],
    ] as const) {
      await createSessionCost({
        sessionId: `flag-${name}`,
        taskId: named[name] as string,
        agentId: agent.id,
        totalCostUsd: cost,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
    }
    // A session whose task row is gone is not human-free.
    await createSessionCost({
      sessionId: "flag-no-task",
      agentId: agent.id,
      totalCostUsd: 16,
      durationMs: 1000,
      numTurns: 1,
      model: "opus",
    });

    const { totals } = await getSessionCostSummary({ agentId: agent.id, groupBy: "day" });
    expect(totals.totalCostUsd).toBe(31);
    expect(totals.excludedCostUsd).toBe(6);
    expect(totals.excludedTaskCount).toBe(2);
    expect(totals.attributableCostUsd).toBe(25);
    expect(totals.attributedCostUsd).toBe(9);
  });
});
