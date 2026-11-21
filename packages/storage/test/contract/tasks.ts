import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Storage,
  sql,
  sqlIdent,
  sqlJoin,
  sqlList,
  TASK_FTS_COMPLETE,
  type TaskRow,
  type TasksRepository,
} from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

type SeedValue = string | number | null;

/** Inserts an `agent_tasks` row: `id` plus any columns; defaults fill task/status/timestamps. */
export function seedTask(storage: Storage, t: { id: string } & Record<string, SeedValue>) {
  const createdAt = (t.createdAt as string | undefined) ?? T0;
  const row: Record<string, SeedValue> = {
    task: "t",
    status: "pending",
    createdAt,
    lastUpdatedAt: createdAt,
    ...t,
  };
  const columns = Object.keys(row);
  return storage.executor.run(sql`
    INSERT INTO agent_tasks (${sqlJoin(
      columns.map((c) => sql`${sqlIdent(c)}`),
      sql`, `,
    )}) VALUES (${sqlList(columns.map((c) => row[c] ?? null))})`);
}

export function tasksContract(engine: ContractEngine): void {
  describe(`tasks repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: TasksRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.tasks;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const taskRow = async (id: string) =>
      storage.executor.get<{
        task: string;
        status: string;
        lastUpdatedAt: string;
        slackParticipants: string | null;
      }>(
        sql`SELECT task, status, "lastUpdatedAt", "slackParticipants" FROM agent_tasks WHERE id = ${id}`,
      );

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const seedUsers = async (...userIds: string[]) => {
      for (const id of userIds) {
        await storage.executor.run(sql`INSERT INTO users (id, name) VALUES (${id}, ${id})`);
      }
    };

    test("findTaskById returns the stored value shape", async () => {
      await seedTask(storage, { id: "t1", tags: '["a"]', slackReplySent: 0 });
      const row = (await repo.findTaskById("t1")) as TaskRow;
      expect(row).toMatchObject({
        id: "t1",
        task: "t",
        status: "pending",
        tags: '["a"]',
        priority: 50,
        slackReplySent: 0,
        was_paused: 0,
        createdAt: T0,
        lastUpdatedAt: T0,
        agentId: null,
      });
      expect(await repo.findTaskById("missing")).toBeNull();
    });

    test("child lists order by createdAt with ties in insertion order", async () => {
      await seedTask(storage, { id: "p" });
      await seedTask(storage, { id: "c3", parentTaskId: "p", createdAt: T0 });
      await seedTask(storage, { id: "c1", parentTaskId: "p", createdAt: T0 });
      await seedTask(storage, {
        id: "c0",
        parentTaskId: "p",
        createdAt: "2026-11-21T09:00:00.000Z",
      });
      expect(ids(await repo.listChildTasks("p"))).toEqual(["c0", "c3", "c1"]);
      expect(await repo.hasOpenChildOfType("p", "resume")).toBe(false);
      await seedTask(storage, {
        id: "r1",
        parentTaskId: "p",
        taskType: "resume",
        status: "failed",
      });
      expect(await repo.hasOpenChildOfType("p", "resume")).toBe(false);
      await seedTask(storage, { id: "r2", parentTaskId: "p", taskType: "resume" });
      expect(await repo.hasOpenChildOfType("p", "resume")).toBe(true);
      expect(await repo.hasOpenChildOfType("p", "reroute-decision")).toBe(false);
    });

    test("superseded repair reads", async () => {
      const sup = (id: string, finishedAt: string, extra: Record<string, SeedValue> = {}) =>
        seedTask(storage, { id, status: "superseded", finishedAt, ...extra });
      await sup("s1", "2026-11-21T10:00:00.000Z");
      await sup("s2", "2026-11-21T09:00:00.000Z", { failureReason: "other" });
      await sup("s3", "2026-11-21T09:30:00.000Z", { failureReason: "wf" });
      await sup("s5", "2026-11-21T09:50:00.000Z");
      await seedTask(storage, { id: "s5r", parentTaskId: "s5", taskType: "resume" });
      await sup("old", "2026-11-01T00:00:00.000Z");
      expect(
        ids(await repo.listSupersededWithoutResume(T1, "2026-11-20T00:00:00.000Z", "wf")),
      ).toEqual(["s2", "s1"]);

      await seedTask(storage, {
        id: "s1r1",
        parentTaskId: "s1",
        taskType: "resume",
        createdAt: T0,
      });
      await seedTask(storage, {
        id: "s1r2",
        parentTaskId: "s1",
        taskType: "resume",
        createdAt: T1,
      });
      await seedTask(storage, { id: "dep1", dependsOn: '["s1"]', status: "pending" });
      await seedTask(storage, { id: "dep5", dependsOn: '["s5","x"]', status: "completed" });
      expect(
        await repo.listSupersededWithUnsettledDependents(T1, "2026-11-20T00:00:00.000Z", [
          "pending",
          "backlog",
        ]),
      ).toEqual([{ taskId: "s1", resumeTaskId: "s1r2" }]);
    });

    test("dispatched-from and agent lists", async () => {
      await seedTask(storage, { id: "a", agentId: "ag" });
      await seedTask(storage, { id: "b", dispatchedByTaskId: "a", createdAt: T1 });
      await seedTask(storage, { id: "c", dispatchedByTaskId: "a", createdAt: T0 });
      await seedTask(storage, { id: "d", dispatchedByTaskId: "a", createdAt: T0 });
      await seedTask(storage, { id: "e", dispatchedByTaskId: "b" });
      expect(ids(await repo.listTasksDispatchedFrom(["a", "b"]))).toEqual(["c", "d", "e"]);
      expect((await repo.listTasksDispatchedFrom(["a"]))[0]?.totalCostUsd).toBeNull();
      expect(await repo.listTasksDispatchedFrom([])).toEqual([]);
      expect(ids(await repo.listTasksByAgent("ag"))).toEqual(["a"]);
      expect(ids(await repo.listTasksByStatus("pending"))).toContain("e");
    });

    test("notified marks are conditional", async () => {
      await seedTask(storage, { id: "a" });
      await seedTask(storage, { id: "b", notifiedAt: T0 });
      expect(await repo.markTasksNotified(["a", "b"], T1)).toBe(1);
      expect((await repo.findTaskById("a"))?.notifiedAt).toBe(T1);
      expect((await repo.findTaskById("b"))?.notifiedAt).toBe(T0);
      expect(await repo.resetTasksNotified(["a", "b", "zz"])).toBe(2);
      expect(await repo.resetTasksNotified(["a"])).toBe(0);
      expect(await repo.markTasksNotified([], T1)).toBe(0);
    });

    test("finished worker tasks leave out leads", async () => {
      const agent = (id: string, isLead: boolean) =>
        storage.executor.run(sql`
          INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, ${isLead}, 'idle', ${T0}, ${T0})`);
      await agent("lead", true);
      await agent("worker", false);
      await seedTask(storage, { id: "w", agentId: "worker", status: "completed", finishedAt: T0 });
      await seedTask(storage, { id: "l", agentId: "lead", status: "completed", finishedAt: T1 });
      await seedTask(storage, { id: "n", status: "failed", finishedAt: T1 });
      await seedTask(storage, { id: "x", status: "failed", finishedAt: T1, notifiedAt: T1 });
      expect(ids(await repo.listUnnotifiedFinishedWorkerTasks())).toEqual(["n", "w"]);
      await seedTask(storage, {
        id: "s1",
        agentId: "lead",
        source: "slack",
        slackChannelId: "C",
        slackThreadTs: "1",
      });
      await seedTask(storage, {
        id: "s2",
        agentId: "worker",
        createdAt: "2026-11-21T09:00:00.000Z",
        source: "slack",
        slackChannelId: "C",
        slackThreadTs: "1",
      });
      expect((await repo.findLatestLeadSlackTaskInThread("C", "1"))?.id).toBe("s1");
      expect((await repo.findLatestActiveSlackTaskInThread("C", "1"))?.id).toBe("s1");
      expect((await repo.findLatestSlackIngressTaskInThread("C", "1"))?.id).toBe("s1");
      expect((await repo.findFirstTaskInThread("C", "1"))?.id).toBe("s2");
      expect((await repo.findMostRecentTaskInThread("C", "1"))?.id).toBe("s1");
    });

    test("contextKey lookups: requester filters, chat source and ranges", async () => {
      await seedUsers("u1");
      await seedTask(storage, { id: "a", contextKey: "k:1", requestedByUserId: "u1" });
      await seedTask(storage, { id: "b", contextKey: "k:1", createdAt: T1 });
      expect((await repo.findLatestTaskByContextKey("k:1", {}))?.id).toBe("b");
      expect((await repo.findLatestTaskByContextKey("k:1", { requestedByUserId: "u1" }))?.id).toBe(
        "a",
      );
      expect(
        (await repo.findLatestTaskByContextKey("k:1", { notRequestedByUserId: "u1" }))?.id,
      ).toBe("b");

      await seedTask(storage, { id: "c1", contextKey: "chat:x", source: "chat", agentId: "ag1" });
      await seedTask(storage, {
        id: "c2",
        contextKey: "chat:x",
        source: "schedule",
        taskType: "deferred",
        agentId: "ag2",
        status: "completed",
        finishedAt: T0,
      });
      expect(await repo.findLatestAgentIdOnContextKey("chat:x", "chat", null, ["completed"])).toBe(
        "ag2",
      );
      expect(await repo.findLatestAgentIdOnContextKey("chat:x", "chat", T1, ["completed"])).toBe(
        "ag1",
      );
      expect(await repo.findLatestAgentIdOnContextKey("chat:x", "slack", null, [])).toBeNull();
      expect((await repo.findLatestActiveTaskByContextKey("chat:x", "chat"))?.id).toBe("c1");
      expect(
        (
          await repo.findLatestTaskInContextKeyRange("chat:", "chat;", {
            source: null,
            activeOnly: false,
          })
        )?.id,
      ).toBe("c2");
      expect(
        (
          await repo.findLatestTaskInContextKeyRange("chat:", "chat;", {
            source: "chat",
            activeOnly: true,
          })
        )?.id,
      ).toBe("c1");
      expect(
        ids(await repo.listTasksByContextKey("chat:x", ["pending", "completed"])),
      ).toHaveLength(2);
      expect(await repo.listTasksByContextKey("chat:x", [])).toEqual([]);
    });

    test("tracker context work skips the delegating lineage", async () => {
      const key = "task:trackers:linear:1";
      await seedTask(storage, { id: "root", contextKey: key, status: "in_progress" });
      await seedTask(storage, { id: "kid", contextKey: key, parentTaskId: "root" });
      expect((await repo.findTrackerContextTask(key, null, "active"))?.id).toBeDefined();
      expect(await repo.findTrackerContextTask(key, "kid", "active")).toBeNull();
      await seedTask(storage, {
        id: "pr",
        contextKey: key,
        status: "completed",
        vcsProvider: "github",
        vcsRepo: "o/r",
        vcsNumber: 1,
        vcsUrl: "u",
      });
      expect((await repo.findTrackerContextTask(key, "kid", "linkedPr"))?.id).toBe("pr");
    });

    test("thread windows: completed paging, cancelled matching, dispatch counts", async () => {
      const th = { slackChannelId: "C", slackThreadTs: "1" };
      await seedTask(storage, { id: "a", ...th, status: "completed", lastUpdatedAt: T1 });
      await seedTask(storage, { id: "b", ...th, status: "completed", lastUpdatedAt: T1 });
      await seedTask(storage, { id: "c", ...th, status: "completed", lastUpdatedAt: T0 });
      await seedTask(storage, {
        id: "f",
        ...th,
        status: "completed",
        taskType: "follow-up",
        lastUpdatedAt: T1,
      });
      const since = "2026-11-21T00:00:00.000Z";
      expect(ids(await repo.listCompletedTasksInThread("C", "1", since, 10))).toEqual([
        "b",
        "a",
        "c",
      ]);
      expect(
        ids(
          await repo.listCompletedTasksInThread("C", "1", since, 10, {
            lastUpdatedAt: T1,
            id: "b",
          }),
        ),
      ).toEqual(["a", "c"]);
      await seedTask(storage, {
        id: "x",
        ...th,
        status: "failed",
        failureReason: "Exit 130 (sig)",
      });
      expect((await repo.findRecentFailedTaskInThread("C", "1", since))?.id).toBe("x");
      expect((await repo.findRecentCancelledTaskInThread("C", "1", since))?.id).toBe("x");
      expect(await repo.findRecentCancelledTaskInThread("C", "1", T1)).toBeNull();

      const d = { ...th, creatorAgentId: "lead", source: "mcp" };
      await seedTask(storage, { id: "d1", ...d, createdAt: T1 });
      await seedTask(storage, {
        id: "d2",
        ...d,
        taskType: "script-run-step",
        contextKey: "script-run:r1:s1",
        createdAt: T1,
      });
      await seedTask(storage, {
        id: "d3",
        ...d,
        taskType: "script-run-step",
        contextKey: "script-run:r1:s2",
        createdAt: T1,
      });
      await seedTask(storage, {
        id: "d4",
        ...d,
        taskType: "script-run-step",
        contextKey: "script-run:r0:s1",
        createdAt: "2026-11-20T00:00:00.000Z",
      });
      await seedTask(storage, {
        id: "d5",
        ...d,
        taskType: "script-run-step",
        contextKey: "script-run:r0:s2",
        createdAt: T1,
      });
      expect(await repo.countAgentDispatchesInThread("C", "1", "lead", since)).toBe(2);
      expect((await repo.findLatestScriptRunStepTask("script-run:r1:s2"))?.id).toBe("d3");
    });

    test("listTasks orders with ties, filters, and countTasks agrees", async () => {
      await seedTask(storage, { id: "a", lastUpdatedAt: T0, priority: 50, tags: '["x"]' });
      await seedTask(storage, { id: "b", lastUpdatedAt: T0, priority: 50, tags: "[]" });
      await seedTask(storage, { id: "c", lastUpdatedAt: T0, priority: 60, tags: "[]" });
      await seedTask(storage, { id: "d", lastUpdatedAt: T1, tags: "[]", status: "completed" });
      await seedTask(storage, { id: "h", lastUpdatedAt: T1, taskType: "heartbeat", tags: "[]" });
      const page = { limit: 25, offset: 0 };
      expect(ids((await repo.listTasks({}, page, "full")) as TaskRow[])).toEqual([
        "d",
        "c",
        "b",
        "a",
      ]);
      expect(await repo.countTasks({})).toBe(4);
      expect(await repo.countTasks({ includeHeartbeat: true })).toBe(5);
      expect(
        ids((await repo.listTasks({}, { ...page, orderBy: "createdAt" }, "slim")) as TaskRow[]),
      ).toEqual(["d", "c", "b", "a"]);
      expect(
        ids(
          (await repo.listTasks({ statuses: ["pending"], tags: ["x"] }, page, "full")) as TaskRow[],
        ),
      ).toEqual(["a"]);
      expect(await repo.countTasks({ statuses: ["pending", "completed"] })).toBe(4);
      const timeline = (await repo.listTasks({}, { ...page, limit: 1 }, "timeline"))[0];
      expect(timeline?.id).toBe("d");
      expect(timeline?.task).toBeInstanceOf(Uint8Array);
      expect(timeline?.totalCostUsd).toBeNull();
    });

    test("readable sessions hide other owners' roots and their descendants", async () => {
      await seedUsers("u1", "u2");
      await seedTask(storage, { id: "mine", requestedByUserId: "u1" });
      await seedTask(storage, { id: "theirs", requestedByUserId: "u2" });
      await seedTask(storage, { id: "theirs-kid", parentTaskId: "theirs" });
      await seedTask(storage, { id: "sched", requestedByUserId: "u2", scheduleId: "s" });
      await seedTask(storage, { id: "open" });
      const visible = async (userId: string | null) =>
        ids(
          (await repo.listTasks(
            { readableBy: { userId } },
            { limit: 25, offset: 0 },
            "full",
          )) as TaskRow[],
        ).sort();
      expect(await visible("u1")).toEqual(["mine", "open", "sched"]);
      expect(await visible(null)).toEqual(["open", "sched"]);
      expect(await repo.countTasks({ readableBy: { userId: "u1" } })).toBe(3);
      expect(ids(await repo.listTasksByAgent("nobody", { userId: "u1" }))).toEqual([]);
    });

    test("lineage walks up and down with caps", async () => {
      await seedTask(storage, { id: "r" });
      await seedTask(storage, { id: "m", parentTaskId: "r" });
      await seedTask(storage, { id: "l1", parentTaskId: "m", createdAt: T1 });
      await seedTask(storage, { id: "l2", parentTaskId: "m", createdAt: T0 });
      expect(await repo.listTaskAncestors("l1", 50)).toEqual([
        { id: "l1", parentTaskId: "m", hops: 0 },
        { id: "m", parentTaskId: "r", hops: 1 },
        { id: "r", parentTaskId: null, hops: 2 },
      ]);
      expect(await repo.listTaskAncestors("l1", 1)).toHaveLength(2);
      expect(await repo.listTaskAncestors("missing", 5)).toEqual([]);
      expect(ids(await repo.listTaskDescendants("r", 30, 100))).toEqual(["r", "m", "l2", "l1"]);
      expect(ids(await repo.listTaskDescendants("r", 1, 100))).toEqual(["r", "m"]);
      expect((await repo.listTaskLineageRows(["l1"]))[0]).toMatchObject({
        id: "l1",
        workflowRunId: null,
      });
      expect(await repo.hasChildOutside(["r", "m"])).toBe(true);
      expect(await repo.hasChildOutside(["r", "m", "l1", "l2"])).toBe(false);
    });

    test("insertSimpleTask stores flags as 0/1 and now timestamps", async () => {
      const row = await repo.insertSimpleTask({
        id: "n1",
        key: "shared/task:n1/",
        agentId: "ag",
        task: "do",
        status: "pending",
        source: "mcp",
        slackChannelId: null,
        slackThreadTs: null,
        slackUserId: null,
        swarmVersion: "1.0.0",
        isHumanFree: true,
      });
      expect(row).toMatchObject({
        id: "n1",
        key: "shared/task:n1/",
        status: "pending",
        swarmVersion: "1.0.0",
      });
      expect((row as unknown as { isHumanFree: number }).isHumanFree).toBe(1);
      expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row?.lastUpdatedAt).toBe(row?.createdAt as string);
    });

    test("terminal moves are conditional and compare-and-swap", async () => {
      await seedTask(storage, { id: "a", status: "in_progress", lastUpdatedAt: T0 });
      expect(
        await repo.finishTask("a", {
          status: "failed",
          statusKind: "error",
          failureReason: "boom",
          finishedAt: T1,
          expectedLastUpdatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toBeNull();
      const failed = await repo.finishTask("a", {
        status: "failed",
        statusKind: "error",
        failureReason: "boom",
        finishedAt: T1,
        expectedLastUpdatedAt: T0,
      });
      expect(failed).toMatchObject({
        status: "failed",
        statusKind: "error",
        failureReason: "boom",
      });
      expect(
        await repo.finishTask("a", { status: "completed", statusKind: null, finishedAt: T1 }),
      ).toBeNull();
      expect(await repo.overwriteTerminalResultText("a", "out", "boom")).toMatchObject({
        output: "out",
        failureReason: "boom",
      });
      await seedTask(storage, { id: "b", status: "pending" });
      expect(await repo.overwriteTerminalResultText("b", "out", null)).toBeNull();
      expect(await repo.markWorkflowStepTaskSuperseded("a", "other")).toBeNull();
      expect(await repo.markWorkflowStepTaskSuperseded("a", "boom")).toMatchObject({
        status: "superseded",
        statusKind: "workflow_retry",
      });
      expect(await repo.updateTaskProgress("b", "half")).toMatchObject({
        status: "in_progress",
        progress: "half",
      });
      expect(await repo.updateTaskProgress("a", "late")).toMatchObject({ status: "superseded" });
      expect(await repo.startTask("a")).toBeNull();
      expect(await repo.pauseTask("b")).toMatchObject({ status: "paused", was_paused: 1 });
      expect(await repo.pauseTask("b")).toBeNull();
      expect(await repo.resumePausedTask("b")).toMatchObject({ status: "in_progress" });
    });

    test("titles, tags, session columns and provider", async () => {
      await seedTask(storage, { id: "a", tags: '["x"]' });
      expect(await repo.setTaskTitleIfUnset("a", "first")).toMatchObject({ title: "first" });
      expect(await repo.setTaskTitleIfUnset("a", "second")).toBeNull();
      expect(await repo.setTaskTitle("a", null)).toMatchObject({ title: null, lastUpdatedAt: T0 });
      expect(await repo.findTaskTags("a")).toEqual({ tags: '["x"]' });
      expect(await repo.findTaskTags("missing")).toBeNull();
      expect(await repo.setTaskTags("a", '["y"]', false)).toMatchObject({
        tags: '["y"]',
        lastUpdatedAt: T0,
      });
      expect((await repo.setTaskTags("a", '["z"]', true))?.lastUpdatedAt).not.toBe(T0);
      expect(
        await repo.setTaskSessionColumns("a", { claudeSessionId: "s1", model: undefined }, T1),
      ).toMatchObject({ claudeSessionId: "s1", model: null, lastUpdatedAt: T1 });
      await repo.setTaskProviderIfUnset("a", "codex");
      await repo.setTaskProviderIfUnset("a", "claude");
      expect((await repo.findTaskById("a"))?.provider).toBe("codex");
    });

    test("assignUnassignedTask re-checks status, snapshots and capacity", async () => {
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, "isLead", status, "maxTasks", "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', ${false}, 'idle', 1, ${T0}, ${T0})`);
      await seedTask(storage, { id: "u1", status: "unassigned", lastUpdatedAt: T0 });
      await seedTask(storage, { id: "u2", status: "unassigned", lastUpdatedAt: T0 });
      const base = { agentId: "ag", now: T1, poolWakeAt: null };
      const snapshot = { taskLastUpdatedAt: T0, agentLastUpdatedAt: T0 };
      expect(
        await repo.assignUnassignedTask({
          ...base,
          taskId: "u1",
          guards: { snapshot: { ...snapshot, taskLastUpdatedAt: T1 } },
        }),
      ).toBeNull();
      expect(
        await repo.assignUnassignedTask({ ...base, taskId: "u1", guards: { snapshot } }),
      ).toMatchObject({ status: "pending", agentId: "ag", lastUpdatedAt: T1 });
      // The agent is now at capacity.
      expect(
        await repo.assignUnassignedTask({ ...base, taskId: "u2", guards: { snapshot } }),
      ).toBeNull();
      expect(await repo.assignUnassignedTask({ ...base, taskId: "u2", guards: {} })).toMatchObject({
        status: "pending",
      });
      expect(await repo.assignUnassignedTask({ ...base, taskId: "u2", guards: {} })).toBeNull();
    });

    test("dependents re-point to the resume, deduplicated in first position", async () => {
      await seedTask(storage, { id: "s" });
      await seedTask(storage, { id: "r" });
      await seedTask(storage, { id: "d1", dependsOn: '["x","s","r"]' });
      await seedTask(storage, { id: "d2", dependsOn: '["s"]', status: "in_progress" });
      const changed = await repo.repointDependents("s", "r", ["pending"]);
      expect(changed).toEqual([{ id: "d1", agentId: null }]);
      expect((await repo.findTaskById("d1"))?.dependsOn).toBe('["x","r"]');
      expect((await repo.findTaskById("d2"))?.dependsOn).toBe('["s"]');
    });

    test("agent lists: pending, paused, orphaned, cancelled; delete", async () => {
      await seedTask(storage, { id: "p1", agentId: "ag", priority: 10 });
      await seedTask(storage, { id: "p2", agentId: "ag", priority: 90 });
      expect(ids(await repo.listPendingTasksForAgent("ag"))).toEqual(["p2", "p1"]);
      await seedTask(storage, { id: "z2", agentId: "ag", status: "paused" });
      await seedTask(storage, { id: "z1", agentId: "ag", status: "paused" });
      expect(ids(await repo.listPausedTasksForAgent("ag"))).toEqual(["z2", "z1"]);
      await seedTask(storage, {
        id: "o1",
        agentId: "ag",
        status: "in_progress",
        lastUpdatedAt: T0,
      });
      await seedTask(storage, {
        id: "o2",
        agentId: "ag",
        status: "in_progress",
        lastUpdatedAt: T0,
        claudeSessionId: "s",
      });
      expect(ids(await repo.listOrphanedInProgressTasks("ag", T1))).toEqual(["o1"]);
      expect(ids(await repo.listOrphanedInProgressTasks("ag", T0))).toEqual([]);
      expect(ids(await repo.resetOrphanedInProgressTasks("ag", T1))).toEqual(["o1"]);
      expect((await repo.findTaskById("o1"))?.status).toBe("pending");
      await seedTask(storage, { id: "c1", agentId: "ag", status: "cancelled", finishedAt: T1 });
      await seedTask(storage, { id: "c0", agentId: "ag", status: "cancelled", finishedAt: T0 });
      expect(ids(await repo.listRecentlyCancelledTasks("ag", "2026-11-21T09:00:00.000Z"))).toEqual([
        "c1",
        "c0",
      ]);
      await seedTask(storage, { id: "kid", parentTaskId: "p1" });
      expect(await repo.listChildTaskIds("p1")).toEqual(["kid"]);
      expect(await repo.deleteTask("kid")).toBe(1);
      expect(await repo.deleteTask("kid")).toBe(0);
    });

    test("the FTS backfill indexes in batches up to the complete mark", async () => {
      await seedTask(storage, { id: "f1", task: "alpha" });
      await seedTask(storage, { id: "f2", task: "beta" });
      await seedTask(storage, { id: "f3", task: "gamma" });
      await storage.executor.run(
        sql`INSERT INTO agent_tasks_fts(agent_tasks_fts) VALUES ('delete-all')`,
      );
      await storage.executor.run(
        sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = 0 WHERE id = 1`,
      );
      expect(await repo.getTaskFtsIndexedThrough()).toBe(0);
      expect(await storage.transaction(() => repo.indexTaskFtsBatch(2))).toEqual({
        changes: 2,
        done: false,
      });
      expect(await storage.transaction(() => repo.indexTaskFtsBatch(2))).toEqual({
        changes: 1,
        done: true,
      });
      expect(await repo.getTaskFtsIndexedThrough()).toBe(TASK_FTS_COMPLETE);
      expect(await repo.indexTaskFtsBatch(2)).toEqual({ changes: 0, done: true });
      expect(
        ids(
          (await repo.listTasks({ search: "gamma" }, { limit: 5, offset: 0 }, "full")) as TaskRow[],
        ),
      ).toEqual(["f3"]);
      expect(await repo.countTasks({ search: "alp" })).toBe(1);
    });

    test("human-free: classify, walk, apply and the queue", async () => {
      const input = {
        taskType: null,
        tags: null,
        source: "mcp",
        requestedByUserId: null,
        requestedByUserIdInherited: false,
        parentTaskId: null,
        workflowRunId: null,
      };
      expect(await repo.classifyHumanFree(input)).toBe(false);
      expect(await repo.classifyHumanFree({ ...input, taskType: "heartbeat" })).toBe(true);
      expect(await repo.classifyHumanFree({ ...input, tags: '["HEARTBEAT"]' })).toBe(true);
      expect(await repo.classifyHumanFree({ ...input, source: "schedule" })).toBe(true);

      await seedTask(storage, { id: "root", taskType: "heartbeat" });
      await seedTask(storage, { id: "k1", parentTaskId: "root" });
      await seedTask(storage, { id: "k2", parentTaskId: "root" });
      await seedTask(storage, { id: "g1", parentTaskId: "k1" });
      expect(await repo.humanFreeAffected(["root"], 10)).toEqual(["root", "k1", "k2", "g1"]);
      expect(await repo.humanFreeAffected(["root"], 2)).toHaveLength(2);
      expect(await repo.applyHumanFreeBatch(["root", "k1", "k2", "g1"])).toBe(4);
      expect(await repo.applyHumanFreeBatch(["root", "k1", "k2", "g1"])).toBe(0);
      expect(await repo.humanFreeUnfinished(["root", "k1"])).toEqual(["root", "k1"]);
      expect(await repo.humanFreeUnfinished(["root", "k1", "k2", "g1"])).toEqual([]);
      expect(await repo.listChildPage("root", 0, 1)).toHaveLength(1);
      const page = await repo.listChildPage("root", 0, 5);
      expect(page.map((r) => r.id)).toEqual(["k1", "k2"]);
      expect(await repo.listChildPage("root", page[0]?.position ?? 0, 5)).toEqual([page[1]]);

      expect(await repo.countHumanFreeQueue()).toBe(0);
      await repo.enqueueHumanFreeWork(["k1", "k2"], "self", 3);
      await repo.enqueueHumanFreeWork(["root"], "children", 1);
      const head = await repo.humanFreeQueueHead();
      expect(head).toMatchObject({ taskId: "k1", scope: "self", afterRowid: 0, hops: 3 });
      await repo.setHumanFreeQueueCursor(head?.seq ?? 0, 7);
      await repo.enqueueHumanFreeWork(["k1"], "self", 2);
      expect(
        (await repo.humanFreeQueueSelfRows(10)).map((r) => [r.taskId, r.afterRowid, r.hops]),
      ).toEqual([
        ["k1", 0, 3],
        ["k2", 0, 3],
      ]);
      await repo.deleteHumanFreeQueueRows([head?.seq ?? 0]);
      expect(await repo.countHumanFreeQueue()).toBe(2);
      await repo.enqueueHumanFreeWork([], "self", 1);
      expect(await repo.countHumanFreeQueue()).toBe(2);
    });

    test("appendDraftTaskText changes only a draft", async () => {
      await seedTask(storage, { id: "d1", task: "base", status: "draft" });
      await seedTask(storage, { id: "p1", task: "base", status: "pending" });
      expect(await repo.appendDraftTaskText("d1", "\n\nmore", T1)).toBe(1);
      expect(await repo.appendDraftTaskText("p1", "\n\nmore", T1)).toBe(0);
      expect(await taskRow("d1")).toMatchObject({ task: "base\n\nmore", lastUpdatedAt: T1 });
      expect(await taskRow("p1")).toMatchObject({ task: "base", lastUpdatedAt: T0 });
    });

    test("foldPendingTaskText is a compare-and-set on status and text", async () => {
      await seedTask(storage, { id: "p1", task: "a", slackParticipants: '{"x":1}' });
      const fold = {
        taskId: "p1",
        expectedTask: "a",
        nextTask: "ab",
        toDraft: false,
        slackParticipants: null,
        now: T1,
      };
      expect(await repo.foldPendingTaskText({ ...fold, expectedTask: "stale" })).toBe(0);
      expect(await repo.foldPendingTaskText(fold)).toBe(1);
      expect(await taskRow("p1")).toEqual({
        task: "ab",
        status: "pending",
        lastUpdatedAt: T1,
        slackParticipants: '{"x":1}',
      });
      expect(
        await repo.foldPendingTaskText({
          ...fold,
          expectedTask: "ab",
          nextTask: "abc",
          toDraft: true,
          slackParticipants: '{"y":2}',
        }),
      ).toBe(1);
      expect(await taskRow("p1")).toMatchObject({
        task: "abc",
        status: "draft",
        slackParticipants: '{"y":2}',
      });
      // Now a draft: no longer pending.
      expect(await repo.foldPendingTaskText({ ...fold, expectedTask: "abc" })).toBe(0);
    });

    test("listDeliveredSlackMessageTs reads triggers and steering log entries", async () => {
      await seedTask(storage, {
        id: "s1",
        slackChannelId: "C1",
        slackThreadTs: "100.1",
        slackTriggerMessageTs: "100.1",
      });
      await seedTask(storage, { id: "s2", slackChannelId: "C1", slackThreadTs: "100.1" });
      await seedTask(storage, {
        id: "s3",
        slackChannelId: "C2",
        slackThreadTs: "100.1",
        slackTriggerMessageTs: "999.9",
      });
      const log = (id: string, taskId: string, newValue: string, metadata: string | null) =>
        storage.executor.run(sql`
          INSERT INTO agent_log (id, "eventType", "taskId", "newValue", metadata, "createdAt")
          VALUES (${id}, 'task_steering', ${taskId}, ${newValue}, ${metadata}, ${T0})`);
      await log("l1", "s2", "slack_reaction", '{"slackMessageTs":"100.2"}');
      await log("l2", "s2", "slack_reaction", "not json");
      await log("l3", "s2", "other", '{"slackMessageTs":"100.3"}');
      await log("l4", "s1", "slack_reaction", '{"slackMessageTs":"100.1"}');
      const ts = await repo.listDeliveredSlackMessageTs("C1", "100.1");
      expect(new Set(ts.filter((v) => v !== null))).toEqual(new Set(["100.1", "100.2"]));
      expect(ts.filter((v) => v === "100.1")).toHaveLength(1);
      expect(await repo.listDeliveredSlackMessageTs("C9", "1")).toEqual([]);
    });

    test("task idempotency keys round trip and reject a duplicate scope", async () => {
      const row = {
        id: "k1",
        principal: "user:1",
        keyHash: "h",
        requestFingerprint: "f",
        taskId: "t1",
        createdAt: T0,
        created_by: "u1",
        updated_by: "u1",
      };
      await repo.insertTaskIdempotencyKey(row);
      expect(await repo.findTaskIdempotencyKey("user:1", "h")).toEqual(row);
      expect(await repo.findTaskIdempotencyKey("user:2", "h")).toBeNull();
      await expect(repo.insertTaskIdempotencyKey({ ...row, id: "k2" })).rejects.toThrow(
        /UNIQUE|unique/,
      );
    });
  });
}
