import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  jsonText,
  type NewTaskRow,
  type Storage,
  sql,
  sqlIdent,
  sqlJoin,
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
  // Flags bind as booleans and JSON columns go through jsonText, so the seed
  // stores the same values on every engine.
  const value = (c: string) => {
    const v = row[c] ?? null;
    if (TASK_FLAG_COLUMNS.has(c) && v !== null) return sql`${Boolean(v)}`;
    if (TASK_JSON_COLUMNS.has(c)) return sql`${jsonText(v as string | null)}`;
    return sql`${v}`;
  };
  return storage.executor.run(sql`
    INSERT INTO agent_tasks (${sqlJoin(
      columns.map((c) => sql`${sqlIdent(c)}`),
      sql`, `,
    )}) VALUES (${sqlJoin(columns.map(value), sql`, `)})`);
}

const TASK_FLAG_COLUMNS = new Set([
  "isHumanFree",
  "requestedByUserIdInherited",
  "slackReplySent",
  "was_paused",
]);
const TASK_JSON_COLUMNS = new Set([
  "dependsOn",
  "fallbackHops",
  "followUpConfig",
  "harnessVariantMeta",
  "outputSchema",
  "providerMeta",
  "slackParticipants",
  "tags",
]);

/** A `NewTaskRow` with only the text set: every optional column is null. */
function newTaskRow(id: string, task: string): NewTaskRow {
  const none = null;
  return {
    id,
    key: `shared/task:${id}/`,
    agentId: none,
    creatorAgentId: none,
    task,
    status: "unassigned",
    source: "api",
    routing_reason: none,
    routing_source: none,
    routing_note: none,
    taskType: none,
    tags: "[]",
    priority: 50,
    dependsOn: "[]",
    offeredTo: none,
    offeredAt: none,
    slackChannelId: none,
    slackThreadTs: none,
    slackTriggerMessageTs: none,
    slackUserId: none,
    slackParticipants: none,
    vcsProvider: none,
    vcsRepo: none,
    vcsEventType: none,
    vcsNumber: none,
    vcsCommentId: none,
    vcsAuthor: none,
    vcsUrl: none,
    vcsInstallationId: none,
    vcsNodeId: none,
    agentmailInboxId: none,
    agentmailMessageId: none,
    agentmailThreadId: none,
    mentionMessageId: none,
    mentionChannelId: none,
    dir: none,
    parentTaskId: none,
    dispatchedByTaskId: none,
    model: none,
    modelTier: none,
    effort: none,
    profile: none,
    modelGroup: none,
    fallbackHops: none,
    scheduleId: none,
    workflowRunId: none,
    workflowRunStepId: none,
    outputSchema: none,
    followUpConfig: none,
    requestedByUserId: none,
    requestedByUserIdInherited: false,
    contextKey: none,
    routingAffinity: none,
    swarmVersion: "1.0.0",
    createdAt: T0,
    lastUpdatedAt: T0,
    created_by: none,
    updated_by: none,
    isHumanFree: false,
    sourceStepId: none,
    sourceScriptRunId: none,
  };
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

    test("attribution: roots, shipped trees (attachment, output, case) and reach per requester", async () => {
      await seedUsers("u1", "u2");
      const at = (h: number) => `2026-11-20T${String(h).padStart(2, "0")}:00:00.000Z`;
      await seedTask(storage, {
        id: "r1",
        requestedByUserId: "u1",
        status: "completed",
        agentId: null,
        source: "api",
        createdAt: at(1),
      });
      await seedTask(storage, {
        id: "c1",
        parentTaskId: "r1",
        requestedByUserId: "u1",
        status: "completed",
        source: "mcp",
        output: "see HTTPS://GITHUB.COM/o/r/PULL/7",
        createdAt: at(2),
      });
      await seedTask(storage, {
        id: "r2",
        requestedByUserId: "u1",
        status: "completed",
        source: "api",
        createdAt: at(3),
      });
      await seedTask(storage, {
        id: "r3",
        requestedByUserId: "u2",
        status: "completed",
        source: "slack",
        vcsRepo: "o/r",
        createdAt: at(4),
      });
      await storage.executor.run(
        sql`INSERT INTO task_attachments (id, task_id, kind, url, name, created_at) VALUES ('a1', 'r3', 'url', 'https://gitlab.example.com/g/p/-/merge_requests/3', 'mr', ${at(4)})`,
      );
      await seedTask(storage, {
        id: "r4",
        requestedByUserId: "u2",
        status: "completed",
        isHumanFree: 1,
        createdAt: at(5),
      });
      await seedTask(storage, {
        id: "r5",
        requestedByUserId: "u2",
        status: "completed",
        createdAt: at(9),
      });
      const window = { startDate: at(0), endBefore: at(8) };
      const roots = (await repo.listAttributionRoots(window, "github.com")).sort((a, b) =>
        a.userId.localeCompare(b.userId),
      );
      expect(roots).toEqual([
        { userId: "u1", initiated: 2, shipped: 1 },
        { userId: "u2", initiated: 1, shipped: 1 },
      ]);
      const reach = (await repo.listAttributionReach(window)).sort((a, b) =>
        a.userId.localeCompare(b.userId),
      );
      expect(reach).toEqual([
        { userId: "u1", agentsReached: 0, reposReached: 0, surfacesReached: 2 },
        { userId: "u2", agentsReached: 0, reposReached: 1, surfacesReached: 1 },
      ]);
      expect(await repo.listAttributionRoots({ endAtOrBefore: at(1) }, "github.com")).toEqual([
        { userId: "u1", initiated: 1, shipped: 1 },
      ]);
    });

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

    test("a server-stamped lastUpdatedAt read back wins its own compare-and-swap", async () => {
      // The heartbeat and routed assignment read a row, then CAS on the value
      // they read. The engine's clock stamps it, so the stored value must equal
      // the read one: no precision finer than the read text keeps.
      await seedTask(storage, { id: "cas", status: "in_progress" });
      await repo.setTaskOutput("cas", "partial");
      const read = await storage.executor.get<{ lastUpdatedAt: string }>(
        sql`SELECT "lastUpdatedAt" FROM agent_tasks WHERE id = ${"cas"}`,
      );
      const lastUpdatedAt = read?.lastUpdatedAt as string;
      expect(lastUpdatedAt).not.toBe(T0);
      const failed = await repo.finishTask("cas", {
        status: "failed",
        statusKind: "error",
        failureReason: "stalled",
        finishedAt: T1,
        expectedLastUpdatedAt: lastUpdatedAt,
      });
      expect(failed).toMatchObject({ status: "failed", statusKind: "error" });
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
      // Rows written while the mark is 0 are past it: not indexed yet.
      await storage.executor.run(
        sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = 0 WHERE id = 1`,
      );
      await seedTask(storage, { id: "f1", task: "alpha" });
      await seedTask(storage, { id: "f2", task: "beta" });
      await seedTask(storage, { id: "f3", task: "gamma" });
      expect(await repo.getTaskFtsIndexedThrough()).toBe(0);
      // Until the mark is complete, a row past it still matches (SQLite: the
      // substring match; Postgres: the token match on the row's text).
      expect(await repo.countTasks({ search: "alph" })).toBe(1);
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
      // Then it is the token index: a word prefix matches, a substring does not.
      expect(await repo.countTasks({ search: "lph" })).toBe(0);
    });

    const writeTask = (id: string, task: string) =>
      repo.insertSimpleTask({
        id,
        key: `shared/task:${id}/`,
        agentId: "a1",
        task,
        status: "pending",
        source: "api",
        slackChannelId: null,
        slackThreadTs: null,
        slackUserId: null,
        swarmVersion: "1.0.0",
        isHumanFree: false,
      });
    const found = async (search: string) =>
      ((await repo.listTasks({ search }, { limit: 50, offset: 0 }, "full")) as TaskRow[])
        .map((row) => row.id)
        .sort();

    test("task search follows each write of the task text and title", async () => {
      const inserted = await repo.insertTask(newTaskRow("w0", "inserted heron text"));
      expect(inserted?.id).toBe("w0");
      expect(await found("heron text")).toEqual(["w0"]);

      expect((await writeTask("w1", "first draft words"))?.id).toBe("w1");
      expect(await found("draft words")).toEqual(["w1"]);
      await storage.executor.run(sql`UPDATE agent_tasks SET status = 'draft' WHERE id = 'w1'`);
      expect(await repo.appendDraftTaskText("w1", " appended tail", T1)).toBe(1);
      expect(await repo.appendDraftTaskText("w0", " not a draft", T1)).toBe(0);
      expect(await found("words appended tail")).toEqual(["w1"]);
      expect(await found("not a draft")).toEqual([]);

      await writeTask("w2", "pending original");
      const fold = {
        taskId: "w2",
        expectedTask: "pending original",
        nextTask: "folded replacement",
        toDraft: false,
        slackParticipants: null,
        now: T1,
      };
      expect(await repo.foldPendingTaskText(fold)).toBe(1);
      expect(await repo.foldPendingTaskText(fold)).toBe(0);
      expect(await found("folded replacement")).toEqual(["w2"]);
      expect(await found("original")).toEqual([]);

      expect((await repo.setTaskTitleIfUnset("w2", "osprey title"))?.title).toBe("osprey title");
      expect(await repo.setTaskTitleIfUnset("w2", "kestrel title")).toBeNull();
      expect(await found("osprey")).toEqual(["w2"]);
      expect(await found("kestrel")).toEqual([]);
      expect((await repo.setTaskTitle("w2", "kestrel title"))?.title).toBe("kestrel title");
      expect(await found("osprey")).toEqual([]);
      expect(await found("kestrel title")).toEqual(["w2"]);
      await repo.setTaskTitle("w2", null);
      expect(await found("kestrel")).toEqual([]);
      expect(await found("folded")).toEqual(["w2"]);
      expect(await repo.countTasks({ search: "folded" })).toBe(1);

      expect(await repo.deleteTask("w1")).toBe(1);
      expect(await found("appended")).toEqual([]);
    });

    test("task search: a phrase with a prefix on the last word, in one column, or an id prefix", async () => {
      const corpus: Record<string, string> = {
        t1: "amber falcon crosses the river",
        t2: "amber falcon nests near cliffs",
        t3: "falcon amber sleeps at noon",
        t4: "silver river flows past cliffs",
        t5: "the riverbank hosts amber reeds",
        t6: "Amberly visits silver cliffs",
        t7: "copper kettle boils water",
        t8: "falcons circle the copper tower",
        t9: "fix src/be/db.ts: deploy-helper's v1.2 run_id",
      };
      // Repository writes, which keep the search index of every engine.
      for (const [id, task] of Object.entries(corpus)) await writeTask(id, task);
      await writeTask("ab-title", "ends with copper");
      await repo.setTaskTitle("ab-title", "kettle lid");
      expect(await found("falcon")).toEqual(["t1", "t2", "t3", "t8"]);
      expect(await found("amber falcon")).toEqual(["t1", "t2"]);
      expect(await found("river")).toEqual(["t1", "t4", "t5"]);
      expect(await found("AMBER")).toEqual(["t1", "t2", "t3", "t5", "t6"]);
      expect(await found("falc")).toEqual(["t1", "t2", "t3", "t8"]);
      expect(await found("kettle boils")).toEqual(["t7"]);
      expect(await found("alcon")).toEqual([]);
      expect(await found("cliffs silver")).toEqual([]);
      expect(await found("%")).toEqual([]);
      expect(await found("_")).toEqual([]);
      // Punctuation splits words: paths, hyphens, apostrophes, dots, underscores.
      expect(await found("db")).toEqual(["t9"]);
      expect(await found("be db ts")).toEqual(["t9"]);
      expect(await found("helper s v1")).toEqual(["t9"]);
      expect(await found("2 run id")).toEqual(["t9"]);
      // The title is searched too, but a phrase never runs from the task into it.
      expect(await found("kettle lid")).toEqual(["ab-title"]);
      expect(await found("copper kettle")).toEqual(["t7"]);
      // A task id prefix.
      expect(await found("ab-t")).toEqual(["ab-title"]);
      expect(await repo.countTasks({ search: "falcon" })).toBe(4);
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

    test("task UI specs upsert and action runs reserve, lease and release", async () => {
      await seedTask(storage, { id: "t" });
      await seedTask(storage, { id: "r" });
      await repo.upsertTaskUiSpec({
        taskId: "t",
        spec: '{"root":"a"}',
        actions: null,
        fallbackText: "fb",
        userId: null,
      });
      await repo.upsertTaskUiSpec({
        taskId: "t",
        spec: '{"root":"b"}',
        actions: "{}",
        fallbackText: "fb2",
        userId: null,
      });
      expect(await repo.findTaskUiSpec("t")).toEqual({
        taskId: "t",
        spec: '{"root":"b"}',
        actions: "{}",
        fallbackText: "fb2",
      });
      expect(await repo.listTaskUiSpecs(["t", "r"])).toHaveLength(1);
      expect(await repo.listTaskUiSpecs([])).toEqual([]);
      const run = { taskId: "t", actionId: "go", surface: "web", slackUserId: null, userId: null };
      expect(await repo.reserveTaskUiActionRun(run)).toBe(1);
      expect(await repo.reserveTaskUiActionRun(run)).toBe(0);
      await repo.releaseTaskUiActionRun("t", "go");
      expect(await repo.reserveTaskUiActionRun(run)).toBe(1);
      await repo.setTaskUiActionResult("t", "go", "r");
      await repo.releaseTaskUiActionRun("t", "go");
      expect(await repo.reserveTaskUiActionRun(run)).toBe(0);

      const lease = {
        ...run,
        actionId: "script",
        lockedUntil: "2026-11-21T10:05:00.000Z",
        now: T0,
        cooldownCutoff: "2026-11-21T09:59:00.000Z",
      };
      expect(await repo.acquireTaskUiScriptActionRun(lease)).toBe(1);
      expect(await repo.acquireTaskUiScriptActionRun(lease)).toBe(0);
      expect(await repo.findTaskUiActionLease("t", "script")).toEqual({
        lockedUntil: lease.lockedUntil,
        lastRunAt: null,
      });
      await repo.finishTaskUiScriptActionRun("t", "script", null, T0);
      expect(await repo.findTaskUiActionLease("t", "script")).toEqual({
        lockedUntil: null,
        lastRunAt: T0,
      });
      // Inside the cooldown, then after it.
      expect(await repo.acquireTaskUiScriptActionRun(lease)).toBe(0);
      expect(
        await repo.acquireTaskUiScriptActionRun({ ...lease, now: T1, cooldownCutoff: T1 }),
      ).toBe(1);
      expect(await repo.findTaskUiActionLease("t", "missing")).toBeNull();
    });

    test("checklist items: defaults, add, lookups and updates", async () => {
      await seedUsers("u1");
      await repo.seedChecklistDefaults("u1");
      await repo.seedChecklistDefaults("u1");
      const rows = await repo.listChecklistRows("u1");
      expect(rows.map((r) => r.id).sort()).toEqual([
        "swarm:channel",
        "swarm:tool",
        "user:u1:use_case",
      ]);
      expect((await repo.listChecklistRows(null)).map((r) => r.id).sort()).toEqual([
        "swarm:channel",
        "swarm:tool",
      ]);
      expect(await repo.nextChecklistSortOrder("swarm", null)).toBe(2);
      expect(await repo.nextChecklistSortOrder("user", "u1")).toBe(3);
      expect(await repo.nextChecklistSortOrder("user", "nobody")).toBe(0);
      await repo.insertChecklistItem({
        id: "c1",
        scope: "user",
        userId: "u1",
        kind: "channel",
        label: "Slack",
        href: null,
        meta: '{"adapter":"slack"}',
        sortOrder: 3,
        now: T0,
        actor: "u1",
      });
      expect(await repo.findOpenChannelChecklistItem("user", "u1", "slack")).toEqual({ id: "c1" });
      expect(await repo.findOpenChannelChecklistItem("user", "u1", "teams")).toBeNull();
      await repo.setChecklistStatus("c1", "done", "ok", T1, "lead:x");
      expect(await repo.findOpenChannelChecklistItem("user", "u1", "slack")).toBeNull();
      const done = (await repo.listChecklistRows("u1")).find((r) => r.id === "c1");
      expect(done).toMatchObject({
        status: "done",
        statusReason: "ok",
        statusChangedAt: T1,
        statusChangedByName: "Lead",
      });
      await repo.setChecklistSortOrder("c1", 9, T1, "u1");
      await repo.markChecklistNudged("c1", "task-1", T1);
      expect(await repo.findChecklistItem("c1")).toMatchObject({
        sortOrder: 9,
        nudgedAt: T1,
        nudgedTaskId: "task-1",
      });
    });

    test("citations upsert by index and list in index order", async () => {
      await seedTask(storage, { id: "a" });
      await seedTask(storage, { id: "b" });
      const c = {
        index: 2,
        kind: "url",
        ref: "https://x",
        label: null,
        quote: null,
        resolvedUrl: "https://x",
        verified: "unchecked",
        general: false,
      };
      await repo.upsertTaskCitation("a", c);
      await repo.upsertTaskCitation("a", { ...c, index: 1, general: true });
      await repo.upsertTaskCitation("a", { ...c, label: "L" });
      await repo.upsertTaskCitation("b", { ...c, index: 3 });
      expect(await repo.listTaskCitations("a")).toEqual([
        { ...c, index: 1, general: 1 },
        { ...c, label: "L", general: 0 },
      ]);
      expect(
        (await repo.listTaskCitationsForTasks(["b", "a"])).map((r) => [r.taskId, r.index]),
      ).toEqual([
        ["a", 1],
        ["a", 2],
        ["b", 3],
      ]);
      expect(await repo.listTaskCitationsForTasks([])).toEqual([]);
    });

    test("shipping evidence reads output and attachments in creation order", async () => {
      await seedTask(storage, { id: "a", output: "done" });
      const attach = (id: string, url: string, createdAt: string) =>
        storage.executor.run(sql`
          INSERT INTO task_attachments (id, task_id, name, kind, url, created_at)
          VALUES (${id}, 'a', ${id}, 'url', ${url}, ${createdAt})`);
      await attach("x2", "https://b", T0);
      await attach("x1", "https://a", T0);
      await attach("x0", "https://c", "2026-11-21T09:00:00.000Z");
      expect(await repo.findTaskOutput("a")).toEqual({ output: "done" });
      expect(await repo.findTaskOutput("missing")).toBeNull();
      expect((await repo.listTaskAttachmentUrls("a")).map((r) => r.url)).toEqual([
        "https://c",
        "https://b",
        "https://a",
      ]);
    });

    test("pool routing reads and the conditional release", async () => {
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', ${false}, 'idle', ${T0}, ${T0})`);
      await seedTask(storage, { id: "w", agentId: "ag", pool_wake_at: T0 });
      await seedTask(storage, { id: "p", agentId: "ag" });
      await seedTask(storage, { id: "i", agentId: "ag", status: "in_progress" });
      await seedTask(storage, { id: "h", pool_wake_at: T0, routing_reason: "human_pinned" });
      expect(ids(await repo.listPoolPendingTasks()).sort()).toEqual(["w"]);
      expect(await repo.countAgentOpenTasks("ag")).toEqual({ count: 3, pending: 2 });
      expect(await repo.countAgentOpenTasks("none")).toEqual({ count: 0, pending: 0 });
      expect(await repo.countAgentPendingTasks("ag")).toBe(2);
      expect(await repo.releasePendingPoolTask("w", "ag", T1)).toBe(0);
      expect(await repo.releasePendingPoolTask("p", "other", T1)).toBe(0);
      expect(await repo.releasePendingPoolTask("p", "ag", T1)).toBe(1);
      expect(await repo.findTaskById("p")).toMatchObject({
        status: "unassigned",
        agentId: null,
        lastUpdatedAt: T1,
      });
    });

    test("deferred waits: admission reads and inserts", async () => {
      const schedule = (id: string, enabled: boolean) =>
        storage.executor.run(sql`
          INSERT INTO scheduled_tasks (id, name, "taskTemplate", "targetAgentId", enabled, "parentTaskId",
            "scheduleType", "nextRunAt", "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, 't', 'ag', ${enabled}, 'parent', 'one_time', ${T1}, ${T0}, ${T0})`);
      await seedTask(storage, { id: "parent" });
      await seedTask(storage, { id: "w1" });
      await seedTask(storage, { id: "w2" });
      await schedule("s1", true);
      await schedule("s2", false);
      await repo.insertDeferredTaskWait({
        scheduleId: "s1",
        eventName: "task.completed",
        mode: "any",
        userId: null,
      });
      await repo.insertDeferredTaskWaitMember("s1", "w1", null);
      await repo.insertDeferredTaskWait({
        scheduleId: "s2",
        eventName: "task.completed",
        mode: "any",
        userId: null,
      });
      await repo.insertDeferredTaskWaitMember("s2", "w2", null);
      expect(await repo.findPendingTaskWaitWatching("ag", ["w2", "w1"])).toEqual({
        scheduleId: "s1",
        parentTaskId: "parent",
      });
      expect(await repo.findPendingTaskWaitWatching("ag", ["w2"])).toBeNull();
      expect(await repo.findPendingTaskWaitWatching("other", ["w1"])).toBeNull();
      expect(await repo.countPendingEventWaitsForAgent("ag")).toBe(0);
      await schedule("s3", true);
      await repo.insertDeferredEventWait({
        scheduleId: "s3",
        source: "github",
        event: "pr.merged",
        matchKey: "k",
        matchJson: "{}",
        userId: null,
      });
      expect(await repo.countPendingEventWaitsForAgent("ag")).toBe(1);
    });

    test("deferred waits: resolution reads, claim, member re-point", async () => {
      const schedule = (id: string, parentTaskId: string, enabled = true, taskType = "x") =>
        storage.executor.run(sql`
          INSERT INTO scheduled_tasks (id, name, "taskTemplate", "targetAgentId", enabled, "parentTaskId",
            "taskType", "scheduleType", "nextRunAt", "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, 't', 'ag', ${enabled}, ${parentTaskId}, ${taskType}, 'one_time', ${T1}, ${T0}, ${T0})`);
      await seedTask(storage, { id: "waiter" });
      await seedTask(storage, { id: "m1", status: "completed" });
      await seedTask(storage, { id: "m2", status: "superseded", failureReason: "wf" });
      await seedTask(storage, { id: "m3", status: "superseded" });
      await seedTask(storage, { id: "m3r", parentTaskId: "m3", taskType: "resume" });
      await schedule("s1", "waiter");
      await repo.insertDeferredTaskWait({
        scheduleId: "s1",
        eventName: "settled",
        mode: "all",
        userId: null,
      });
      for (const m of ["m1", "m2", "m3"]) await repo.insertDeferredTaskWaitMember("s1", m, null);
      expect(await repo.findDeferredTaskWait("s1")).toMatchObject({
        scheduleId: "s1",
        eventName: "settled",
        mode: "all",
        status: "pending",
      });
      expect(await repo.findDeferredEventWait("s1")).toBeNull();
      expect(await repo.hasDeferredWait("s1")).toBe(true);
      expect(await repo.hasDeferredWait("nope")).toBe(false);
      const members = await repo.listDeferredWaitMembers("s1", "wf");
      expect(members.map((m) => [m.taskId, m.taskStatus, Number(m.deferred)]).sort()).toEqual([
        ["m1", "completed", 0],
        ["m2", "failed", 0],
        ["m3", "superseded", 0],
      ]);
      expect((await repo.listReadyDeferredTaskWaits("wf")).map((r) => r.taskStatus).sort()).toEqual(
        ["completed", "failed"],
      );
      expect((await repo.listReadyDeferredTaskWaits("wf", "m1")).map((r) => r.taskStatus)).toEqual([
        "completed",
      ]);
      expect(await repo.listSupersededWaitMembers()).toEqual([
        { taskId: "m3", resumeTaskId: "m3r" },
      ]);
      await repo.transferWaitMembers("nobody", "m3r", T1);
      await repo.repointWaitMembers("m3", "m3r", T1);
      expect((await repo.listDeferredWaitMembers("s1", "wf")).map((m) => m.taskId).sort()).toEqual([
        "m1",
        "m2",
        "m3r",
      ]);
      // A deferral pending on a member hides it from the ready list.
      await schedule("d1", "m1", true, "deferred");
      expect(await repo.listReadyDeferredTaskWaits("wf", "m1")).toEqual([]);

      expect(await repo.claimDeferredWait("deferred_task_waits", "s1", "task.completed", T1)).toBe(
        1,
      );
      expect(await repo.claimDeferredWait("deferred_task_waits", "s1", "task.completed", T1)).toBe(
        0,
      );
      await repo.setDeferredWaitChild("deferred_task_waits", "s1", "m1");
      expect(await repo.findDeferredTaskWait("s1")).toMatchObject({ status: "fired" });
      // Fired waits keep their members.
      await repo.transferWaitMembers("m1", "m2", T1);
      expect((await repo.listDeferredWaitMembers("s1", "wf")).map((m) => m.taskId).sort()).toEqual([
        "m1",
        "m2",
        "m3r",
      ]);

      await schedule("e1", "waiter");
      await repo.insertDeferredEventWait({
        scheduleId: "e1",
        source: "github",
        event: "pr.merged",
        matchKey: "k1",
        matchJson: "{}",
        userId: null,
      });
      expect(await repo.hasPendingEventWait("github", "pr.merged")).toBe(true);
      expect(await repo.hasPendingEventWait("github", "other")).toBe(false);
      expect(await repo.listPendingEventWaits()).toEqual([
        { scheduleId: "e1", source: "github", event: "pr.merged", matchKey: "k1", matchJson: "{}" },
      ]);
      expect(
        await repo.listPendingEventWaits({ source: "github", event: "pr.merged", matchKey: "k2" }),
      ).toEqual([]);
      expect(
        await repo.claimDeferredWait("deferred_event_waits", "e1", "external:github:pr.merged", T1),
      ).toBe(1);
      expect(await repo.hasPendingEventWait("github", "pr.merged")).toBe(false);
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

    // ---- db.ts move: Slack/VCS tracking, attachments, steering, pool lifecycle ----

    const addAgent = (id: string, isLead: boolean, status = "idle") =>
      storage.executor.run(sql`
        INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
        VALUES (${id}, ${id}, ${isLead}, ${status}, ${T0}, ${T0})`);

    test("Slack tracking sets only the given columns; thread tasks keep insertion order on ties", async () => {
      await seedTask(storage, { id: "b", slackChannelId: "C", slackThreadTs: "1" });
      await seedTask(storage, { id: "a", slackChannelId: "C", slackThreadTs: "1" });
      await seedTask(storage, { id: "z", slackChannelId: "C", slackThreadTs: "1", createdAt: T1 });
      expect(ids(await repo.listTasksInSlackThread("C", "1"))).toEqual(["b", "a", "z"]);
      await repo.markTaskSlackReplySent("a");
      await repo.setTaskSlackTracking("a", { slackProgressMessageTs: "p" });
      await repo.setTaskSlackTracking("a", {});
      let row = await repo.findTaskById("a");
      expect(row?.slackReplySent).toBe(1);
      expect(row?.slackProgressMessageTs).toBe("p");
      expect(row?.slackTreeRootMessageTs).toBeNull();
      await repo.setTaskSlackTracking("a", {
        slackProgressMessageTs: null,
        slackTreeRootMessageTs: "r",
      });
      row = await repo.findTaskById("a");
      expect(row?.slackProgressMessageTs).toBeNull();
      expect(row?.slackTreeRootMessageTs).toBe("r");
      const vcs = await repo.setTaskVcs(
        "a",
        { vcsProvider: "github", vcsRepo: "o/r", vcsNumber: 7, vcsUrl: "u" },
        T1,
      );
      expect([vcs?.vcsNumber, vcs?.lastUpdatedAt]).toEqual([7, T1]);
      expect(
        await repo.setTaskVcs(
          "nope",
          { vcsProvider: "g", vcsRepo: "r", vcsNumber: 1, vcsUrl: "u" },
          T1,
        ),
      ).toBeNull();
    });

    test("task attachments: dedup lookups, generated rows, replace and order", async () => {
      await seedTask(storage, { id: "t" });
      const write = {
        agent_id: null,
        name: "n",
        kind: "url",
        url: "https://x/1",
        path: null,
        page_id: null,
        provider_id: "url",
        provider_key: null,
        capabilities: JSON.stringify({ gen: "src" }),
        agent_fs_org_id: null,
        agent_fs_drive_id: null,
        mime_type: null,
        size_bytes: null,
        sha256: "s1",
        intent: null,
        description: null,
        is_primary: true,
        updated_by: null,
      };
      const a = await repo.insertTaskAttachment({
        ...write,
        id: "a1",
        task_id: "t",
        created_by: null,
      });
      expect(a?.is_primary).toBe(1);
      expect(typeof a?.created_at).toBe("string");
      await repo.insertTaskAttachment({
        ...write,
        id: "a2",
        task_id: "t",
        created_by: null,
        url: "https://x/2",
        sha256: null,
        capabilities: null,
        is_primary: false,
      });
      expect((await repo.findTaskAttachmentBySha256("t", "s1"))?.id).toBe("a1");
      expect(await repo.findTaskAttachmentBySha256("t", "zz")).toBeNull();
      const tuple = {
        taskId: "t",
        kind: "url",
        path: "",
        url: "https://x/2",
        pageId: "",
        name: "n",
      };
      expect((await repo.findTaskAttachmentByTuple(tuple))?.id).toBe("a2");
      expect(await repo.findTaskAttachmentByTuple({ ...tuple, path: "p" })).toBeNull();
      expect(new Set(await repo.listUrlAttachmentUrls("t"))).toEqual(
        new Set(["https://x/1", "https://x/2"]),
      );
      expect(await repo.listGeneratedUrlAttachments("t", "gen", "src")).toEqual([
        { id: "a1", name: "n", url: "https://x/1" },
      ]);
      expect(ids(await repo.listTaskAttachments("t"))).toEqual(["a1", "a2"]);
      const replaced = await repo.replaceTaskAttachment("a2", {
        ...write,
        name: "m",
        is_primary: false,
      });
      expect([replaced?.name, replaced?.is_primary, replaced?.created_by]).toEqual(["m", 0, null]);
      expect(await repo.replaceTaskAttachment("zz", write)).toBeNull();
      expect(await repo.deleteTaskAttachment("a1")).toBe(1);
      expect(await repo.deleteTaskAttachment("a1")).toBe(0);
    });

    test("steering messages: sender names, guarded transitions, per-agent pending order", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'Ann')`);
      await addAgent("ag", false);
      await seedTask(storage, { id: "t", agentId: "ag" });
      const base = {
        task_id: "t",
        body: "b",
        mode: "queue",
        source: "ui",
        created_by_user_id: null,
        created_by_agent_id: null,
        attachments: null,
      };
      const m1 = await repo.insertSteeringMessage({
        ...base,
        id: "m1",
        created_by_kind: "user",
        created_by_user_id: "u1",
      });
      expect([m1?.status, m1?.delivered_at]).toEqual(["pending", null]);
      await repo.insertSteeringMessage({
        ...base,
        id: "m2",
        created_by_kind: "agent",
        created_by_agent_id: "ag",
      });
      await repo.insertSteeringMessage({
        ...base,
        id: "m3",
        created_by_kind: "system",
        attachments: '[{"id":"a1"}]',
      });
      expect((await repo.findSteeringMessage("m1"))?.sender_name).toBe("Ann");
      expect((await repo.findSteeringMessage("m1"))?.attachments).toBeNull();
      expect((await repo.findSteeringMessage("m3"))?.attachments).toBe('[{"id":"a1"}]');
      expect((await repo.findSteeringMessage("m2"))?.sender_name).toBe("ag");
      expect((await repo.findSteeringMessage("m3"))?.sender_name).toBeNull();
      expect(ids(await repo.listPendingSteeringForAgent("ag"))).toEqual(["m1", "m2", "m3"]);
      expect(ids(await repo.listPendingSteeringForAgent("ag", { userId: null }))).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
      expect(await repo.markSteeringDelivered("m1", "steer", "other")).toBeNull();
      const delivered = await repo.markSteeringDelivered("m1", "steer", null);
      expect(delivered?.status).toBe("delivered");
      expect(delivered?.delivered_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(await repo.markSteeringDelivered("m1", "steer", null)).toBeNull();
      expect(await repo.markSteeringHandled("m2", null)).toBeNull();
      expect((await repo.markSteeringHandled("m1", "ok"))?.handled_note).toBe("ok");
      await seedTask(storage, { id: "t2" });
      expect((await repo.markSteeringPromoted("m2", "t2"))?.promoted_task_id).toBe("t2");
      expect(ids(await repo.listSteeringMessages("t"))).toEqual(["m1", "m2", "m3"]);
      expect(ids(await repo.listSteeringMessages("t", "pending"))).toEqual(["m3"]);
      expect(await repo.hasPendingSteering("t")).toBe(true);
      expect(await repo.cancelPendingSteering("t")).toBe(1);
      expect(await repo.hasPendingSteering("t")).toBe(false);
    });

    test("routing snapshot: candidates skip leads, worker statuses count open tasks", async () => {
      await addAgent("lead", true);
      await addAgent("w1", false);
      await addAgent("w2", false, "busy");
      await seedTask(storage, {
        id: "a",
        agentId: "w1",
        vcsRepo: "r",
        vcsNumber: 1,
        status: "in_progress",
      });
      await seedTask(storage, {
        id: "b",
        agentId: "lead",
        vcsRepo: "r",
        vcsNumber: 1,
        createdAt: T1,
      });
      await seedTask(storage, {
        id: "c",
        offeredTo: "w2",
        agentId: "w1",
        vcsRepo: "r",
        status: "offered",
      });
      expect(await repo.findLatestRoutingCandidate({ vcsRepo: "r", vcsNumber: 1 })).toEqual({
        taskId: "a",
        agentId: "w1",
      });
      expect(await repo.findLatestRoutingCandidate({ vcsRepo: "r" })).toEqual({
        taskId: "c",
        agentId: "w2",
      });
      expect(await repo.findLatestRoutingCandidate({ agentmailThreadId: "x" })).toBeNull();
      const statuses = await repo.listRoutingWorkerStatuses(["pending", "in_progress", "offered"]);
      expect(statuses).toEqual([
        { agentId: "w1", status: "idle", openTaskCount: 2, activeTaskCount: 1 },
        { agentId: "w2", status: "busy", openTaskCount: 1, activeTaskCount: 0 },
      ]);
      expect(await repo.findTaskKey("a")).toBe("shared/");
      expect(await repo.findTaskKey("zz")).toBeNull();
    });

    test("pool lifecycle transitions are guarded on the current status", async () => {
      await seedTask(storage, { id: "u", status: "unassigned" });
      expect((await repo.claimUnassignedTask("u", "w", T1))?.status).toBe("in_progress");
      expect(await repo.claimUnassignedTask("u", "w", T1)).toBeNull();
      const released = await repo.releaseTaskToPool("u", T1);
      expect([released?.status, released?.agentId]).toEqual(["unassigned", null]);
      await seedTask(storage, { id: "p", status: "pending", agentId: "w", pool_wake_at: T0 });
      expect(await repo.releaseTaskToPool("p", T1, { agentId: "w", poolWakeAt: T1 })).toBeNull();
      expect(
        (await repo.releaseTaskToPool("p", T1, { agentId: "w", poolWakeAt: T0 }))?.pool_wake_at,
      ).toBeNull();
      await seedTask(storage, { id: "o", status: "offered", offeredTo: "w", offeredAt: T0 });
      const accepted = await repo.acceptOfferedTask("o", "w", T1);
      expect([accepted?.status, accepted?.acceptedAt]).toEqual(["pending", T1]);
      await seedTask(storage, { id: "r", status: "reviewing", offeredTo: "w" });
      const rejected = await repo.rejectOfferedTask("r", null, T1);
      expect([rejected?.status, rejected?.offeredTo, rejected?.rejectionReason]).toEqual([
        "unassigned",
        null,
        null,
      ]);
      expect(await repo.moveTaskStatus("r", "backlog", "unassigned", T1)).toBeNull();
      expect((await repo.moveTaskStatus("r", "unassigned", "backlog", T1))?.status).toBe("backlog");
      await seedTask(storage, { id: "d1", status: "draft", offeredTo: "w" });
      await seedTask(storage, { id: "d2", status: "draft", agentId: "w" });
      await seedTask(storage, { id: "d3", status: "draft", lastUpdatedAt: T1 });
      expect((await repo.promoteDraftTask("d1", T1))?.status).toBe("offered");
      expect(await repo.promoteDraftTask("d1", T1)).toBeNull();
      await repo.refreshDraftTaskLease("d2", T0);
      expect(await repo.promoteDraftsIdleSince(T1, T1)).toBe(1);
      expect((await repo.findTaskById("d2"))?.status).toBe("pending");
      expect((await repo.findTaskById("d3"))?.status).toBe("draft");
      await seedTask(storage, { id: "rv", status: "reviewing" });
      expect(await repo.releaseReviewingIdleSince(T1, T1)).toBe(1);
      expect((await repo.findTaskById("rv"))?.status).toBe("offered");
    });

    test("offers to offline or deleted agents return to the pool unless reachable", async () => {
      await addAgent("on", false);
      await addAgent("off", false, "offline");
      await addAgent("off2", false, "offline");
      await seedTask(storage, { id: "a", status: "offered", offeredTo: "on" });
      await seedTask(storage, { id: "b", status: "offered", offeredTo: "off" });
      await seedTask(storage, { id: "c", status: "offered", offeredTo: "gone" });
      await seedTask(storage, { id: "d", status: "offered", offeredTo: "off2" });
      expect(await repo.releaseOffersOfOfflineAgents(T1, ["off2"])).toBe(2);
      expect((await repo.findTaskById("a"))?.status).toBe("offered");
      expect((await repo.findTaskById("b"))?.offeredTo).toBeNull();
      expect((await repo.findTaskById("d"))?.status).toBe("offered");
      expect(await repo.releaseOffersOfOfflineAgents(T1, [])).toBe(1);
    });

    test("pool order is priority, createdAt, then insertion order", async () => {
      await seedTask(storage, { id: "b", status: "unassigned" });
      await seedTask(storage, { id: "a", status: "unassigned" });
      await seedTask(storage, { id: "h", status: "unassigned", priority: 90, createdAt: T1 });
      await seedTask(storage, { id: "o", status: "offered", offeredTo: "w" });
      expect(await repo.listUnassignedTaskIds(10)).toEqual(["h", "b", "a"]);
      expect(ids(await repo.listUnassignedTasks(2, 1))).toEqual(["b", "a"]);
      expect(await repo.countUnassignedTasks()).toBe(3);
      expect(ids(await repo.listOfferedTasksForAgent("w"))).toEqual(["o"]);
    });

    test("dependents and recent similar tasks", async () => {
      await seedTask(storage, { id: "p" });
      await seedTask(storage, { id: "d2", dependsOn: '["p","x"]' });
      await seedTask(storage, { id: "d1", dependsOn: '["p"]', status: "completed" });
      await seedTask(storage, { id: "n", dependsOn: "[]" });
      expect(ids(await repo.listDependentTasks("p"))).toEqual(["d2", "d1"]);
      await seedTask(storage, { id: "r1", creatorAgentId: "c", createdAt: T1 });
      await seedTask(storage, { id: "r2", creatorAgentId: "c", createdAt: T1 });
      await seedTask(storage, { id: "r3", creatorAgentId: "c", createdAt: T1, status: "failed" });
      expect(
        ids(await repo.listRecentSimilarTasks({ since: T0, creatorAgentId: "c", limit: 10 })),
      ).toEqual(["r2", "r1"]);
      expect(
        ids(await repo.listRecentSimilarTasks({ since: T0, agentId: "zz", limit: 10 })),
      ).toEqual([]);
    });

    test("status counts, lead delegations and active swarm tasks", async () => {
      await addAgent("lead", true);
      await addAgent("w", false);
      await seedTask(storage, { id: "o", status: "offered", offeredTo: "w" });
      await seedTask(storage, {
        id: "i1",
        status: "in_progress",
        agentId: "w",
        creatorAgentId: "lead",
        createdAt: T1,
      });
      await seedTask(storage, {
        id: "i2",
        status: "in_progress",
        agentId: "w",
        creatorAgentId: "lead",
        createdAt: T1,
      });
      await seedTask(storage, {
        id: "x",
        status: "in_progress",
        creatorAgentId: "w",
        createdAt: T1,
      });
      expect(await repo.countTasksWithStatus("offered", { offeredTo: "w" })).toBe(1);
      expect(await repo.countTasksWithStatus("in_progress", { agentId: "w" })).toBe(2);
      expect(await repo.countTasksWithStatus("in_progress")).toBe(3);
      const delegations = await repo.listRecentLeadDelegations(T0);
      expect(ids(delegations)).toEqual(["i2", "i1"]);
      expect(delegations[0]).toEqual({
        id: "i2",
        task: "t",
        agentId: "w",
        agentName: "w",
        creatorAgentId: "lead",
        status: "in_progress",
        createdAt: T1,
      });
      expect(ids(await repo.listActiveSwarmTasks({ userId: null }))).toEqual(["x", "i2", "i1"]);
      expect(await repo.countTasksByStatus()).toEqual([
        { status: "in_progress", count: 3 },
        { status: "offered", count: 1 },
      ]);
      expect(await repo.hasCompletedTask()).toBe(false);
    });

    test("heartbeat reads: stalled, pinned, affinity, failed; guarded pending fail", async () => {
      await seedTask(storage, { id: "s2", status: "in_progress" });
      await seedTask(storage, { id: "s1", status: "in_progress" });
      await seedTask(storage, { id: "s3", status: "in_progress", lastUpdatedAt: T1 });
      expect(ids(await repo.listStalledInProgressTasks(T1))).toEqual(["s2", "s1"]);
      await seedTask(storage, { id: "p1", taskType: "resume", tags: '["CRASH-RECOVERY-PIN"]' });
      await seedTask(storage, { id: "p2", tags: '["reboot-retry-pin"]' });
      await seedTask(storage, { id: "p3", tags: '["crash-recovery-pin"]' });
      expect(ids(await repo.listStalePinnedResumes(T1))).toEqual(["p1", "p2"]);
      const failed = await repo.failPendingTask("p1", {
        status: "cancelled",
        statusKind: "system",
        failureReason: "r",
        now: T1,
      });
      expect([failed?.status, failed?.finishedAt, failed?.failureReason]).toEqual([
        "cancelled",
        T1,
        "r",
      ]);
      expect(
        await repo.failPendingTask("p1", {
          status: "failed",
          statusKind: "error",
          failureReason: "r",
          now: T1,
        }),
      ).toBeNull();
      await seedTask(storage, { id: "a1", status: "unassigned", routingAffinity: "{}" });
      await seedTask(storage, { id: "a2", status: "unassigned" });
      expect(ids(await repo.listStaleUnassignedAffinityTasks(T1))).toEqual(["a1"]);
      await seedTask(storage, { id: "f1", status: "failed", finishedAt: T1 });
      await seedTask(storage, { id: "f2", status: "failed", finishedAt: T1 });
      await seedTask(storage, { id: "f3", status: "failed", finishedAt: T0 });
      expect(ids(await repo.listRecentFailedTasks("2026-01-01", 2))).toEqual(["f2", "f1"]);
      expect(await repo.countTasksFinishedSince("failed", T0)).toBe(2);
      expect(await repo.countTasksCreatedLastDay()).toBeGreaterThanOrEqual(0);
    });

    test("workflow links, credential keys and the AgentMail thread lookup", async () => {
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, "createdAt", "lastUpdatedAt")
        VALUES ('wf', 'wf', '{}', ${T0}, ${T0})`);
      await storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, "startedAt")
        VALUES ('run', 'wf', 'running', ${T0})`);
      await seedTask(storage, { id: "b", workflowRunId: "run" });
      await seedTask(storage, { id: "a", workflowRunId: "run" });
      await seedTask(storage, { id: "c" });
      expect(await repo.listTaskIdsOfWorkflow("wf")).toEqual(["b", "a"]);
      await repo.unlinkTasksFromWorkflow("wf");
      expect(await repo.listTaskIdsOfWorkflow("wf")).toEqual([]);
      expect(await repo.findTaskByWorkflowRunStepId("none")).toBeNull();
      await repo.setTaskCredentialKey("a", "abcd", "CLAUDE");
      await repo.setTaskCredentialKey("b", "abcd", "CLAUDE");
      await repo.setTaskCredentialKey("c", "zz", "CLAUDE");
      await storage.executor.run(sql`UPDATE agent_tasks SET status = 'in_progress'`);
      expect(
        await repo.countInProgressByCredentialSuffix("CLAUDE", ["zz", "abcd", "nope"]),
      ).toEqual([
        { suffix: "abcd", n: 2 },
        { suffix: "zz", n: 1 },
      ]);
      await storage.executor.run(sql`UPDATE agent_tasks SET "agentmailThreadId" = 'th'`);
      expect((await repo.findLatestTaskByAgentMailThread("th"))?.id).toBe("c");
    });

    test("context snapshots fold into the task aggregates", async () => {
      await addAgent("a", false);
      await seedTask(storage, { id: "t" });
      const snap = {
        id: "s1",
        taskId: "t",
        agentId: "a",
        sessionId: "sess",
        contextUsedTokens: 100,
        contextTotalTokens: 1000,
        contextPercent: 10,
        eventType: "progress",
        compactTrigger: null,
        preCompactTokens: null,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        contextFormula: null,
        createdAt: T0,
      };
      await repo.insertContextSnapshot(snap);
      await repo.insertContextSnapshot({ ...snap, id: "s0" });
      await repo.applyContextSnapshotToTask("t", {
        contextPercent: 10,
        contextUsedTokens: 100,
        contextTotalTokens: 1000,
        compaction: false,
      });
      await repo.applyContextSnapshotToTask("t", {
        contextPercent: 5,
        contextUsedTokens: 50,
        contextTotalTokens: 2000,
        compaction: true,
      });
      const row = await repo.findTaskById("t");
      expect([
        row?.peakContextPercent,
        row?.peakContextTokens,
        row?.contextWindowSize,
        row?.compactionCount,
      ]).toEqual([10, 100, 1000, 1]);
      expect(ids(await repo.listContextSnapshots({ taskId: "t" }, 10))).toEqual(["s1", "s0"]);
      expect(ids(await repo.listContextSnapshots({ sessionId: "sess" }, 1))).toEqual(["s1"]);
      expect((await repo.listContextSnapshots({ taskId: "t" }, 10))[0]).toEqual(snap);
      expect(await repo.countContextSnapshots("t")).toBe(2);
    });

    test("task templates filter and keep insertion order on createdAt ties", async () => {
      const tpl = (id: string, kind: string, title: string, category: string | null) =>
        storage.executor.run(sql`
          INSERT INTO task_templates (id, title, description, prompt, kind, payload, category, tags, "createdAt")
          VALUES (${id}, ${title}, 'd', 'p', ${kind}, '{}', ${category}, '[]', ${T0})`);
      await tpl("z", "task", "Fix Bug", "eng");
      await tpl("a", "workflow", "Report", null);
      const mine = (rows: { id: string }[]) => ids(rows).filter((id) => id === "z" || id === "a");
      expect(mine(await repo.listTaskTemplates({}))).toEqual(["z", "a"]);
      expect(mine(await repo.listTaskTemplates({ query: "BUG" }))).toEqual(["z"]);
      expect(mine(await repo.listTaskTemplates({ kind: "workflow" }))).toEqual(["a"]);
      expect(mine(await repo.listTaskTemplates({ category: "eng", query: "  " }))).toEqual(["z"]);
    });

    test("root task chain walks children with their cost", async () => {
      await seedTask(storage, { id: "r" });
      await seedTask(storage, { id: "c2", parentTaskId: "r", createdAt: T1 });
      await seedTask(storage, { id: "c1", parentTaskId: "r", createdAt: T1 });
      await seedTask(storage, { id: "g", parentTaskId: "c1", createdAt: T1 });
      await seedTask(storage, { id: "other" });
      const chain = await repo.listRootTaskChain("r");
      expect(ids(chain)).toEqual(["r", "c2", "c1", "g"]);
      expect(chain[0]?.totalCostUsd).toBeNull();
    });

    test("task ids requested by a user, directly or through a workflow run", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u9', 'U')`);
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, "createdAt", "lastUpdatedAt")
        VALUES ('wf9', 'wf9', '{}', ${T0}, ${T0})`);
      await storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, "startedAt", created_by)
        VALUES ('run9', 'wf9', 'running', ${T0}, 'u9')`);
      await seedTask(storage, { id: "z", requestedByUserId: "u9" });
      await seedTask(storage, { id: "y", workflowRunId: "run9", requestedByUserId: "u9" });
      await seedTask(storage, { id: "x", workflowRunId: "run9" });
      await seedTask(storage, { id: "w" });
      expect(await repo.listTaskIdsRequestedByUser("u9")).toEqual(["x", "y", "z"]);
      await storage.repos.workflows.setRunContextReplay("run9", "sealed");
      const run = await storage.executor.get<{ context_replay: string }>(
        sql`SELECT context_replay FROM workflow_runs WHERE id = 'run9'`,
      );
      expect(run?.context_replay).toBe("sealed");
    });

    test("cross-module task reads: open children, boot triage, checklist, status, parent", async () => {
      const terminal = ["completed", "failed", "cancelled", "superseded", "skipped"];
      await seedTask(storage, { id: "root", source: "slack" });
      await seedTask(storage, { id: "c1", parentTaskId: "root", status: "completed" });
      expect(await repo.findOpenChildTaskId("root", terminal)).toBeNull();
      await seedTask(storage, { id: "c2", parentTaskId: "root", status: "in_progress" });
      expect(await repo.findOpenChildTaskId("root", terminal)).toBe("c2");
      await seedTask(storage, {
        id: "b1",
        agentId: "lead",
        taskType: "boot-triage",
        status: "failed",
      });
      expect(await repo.findOpenBootTriageTask("lead", terminal)).toBeNull();
      await seedTask(storage, { id: "b2", agentId: "lead", taskType: "boot-triage" });
      expect(await repo.findOpenBootTriageTask("lead", terminal)).toBe("b2");
      await seedTask(storage, {
        id: "h1",
        agentId: "lead",
        taskType: "heartbeat-checklist",
        status: "completed",
      });
      const open = ["pending", "in_progress"];
      expect(await repo.findOpenHeartbeatChecklistTask("lead", open)).toBeNull();
      await seedTask(storage, { id: "h2", agentId: "lead", taskType: "heartbeat-checklist" });
      expect(await repo.findOpenHeartbeatChecklistTask("lead", open)).toBe("h2");
      expect(await repo.findOpenHeartbeatChecklistTask("other", open)).toBeNull();
      expect(await repo.findTaskStatus("c1")).toBe("completed");
      expect(await repo.findTaskStatus("missing")).toBeNull();
      expect(await repo.findTaskParentId("c1")).toEqual({ parentTaskId: "root" });
      expect(await repo.findTaskParentId("root")).toEqual({ parentTaskId: null });
      expect(await repo.findTaskParentId("missing")).toBeNull();
      await seedTask(storage, { id: "c3", parentTaskId: "c2", source: "api" });
      expect(await repo.findRootTaskSource("c3", 10)).toEqual({ source: "slack" });
      expect(await repo.findRootTaskSource("c3", 1)).toEqual({ source: "mcp" });
      expect(await repo.findRootTaskSource("missing", 10)).toBeNull();
    });

    test("repointTaskDependency writes only while status and membership still hold", async () => {
      await seedTask(storage, { id: "d", dependsOn: '["old","x"]' });
      expect(await repo.repointTaskDependency("d", "in_progress", "old", '["new","x"]')).toBe(
        false,
      );
      expect(await repo.repointTaskDependency("d", "pending", "gone", '["new","x"]')).toBe(false);
      expect(await repo.repointTaskDependency("d", "pending", "old", '["new","x"]')).toBe(true);
      const row = await repo.findTaskById("d");
      expect(row?.dependsOn).toBe('["new","x"]');
      expect(row?.lastUpdatedAt).not.toBe(T0);
    });

    test("runtime instance, model resolution and agentRanModel", async () => {
      await seedTask(storage, { id: "t", agentId: "ag", model: "opus" });
      await repo.setTaskRuntimeInstance("t", "other", "rt");
      await repo.setTaskRuntimeInstance("t", "ag", "rt");
      expect(
        await storage.executor.get(sql`SELECT runtime_instance_id FROM agent_tasks WHERE id = 't'`),
      ).toEqual({ runtime_instance_id: "rt" });
      expect(await repo.agentRanModel("ag", "opus")).toBe(true);
      await repo.setTaskModelResolution("t", {
        resolvedModel: "claude-x",
        modelSource: "tier",
        modelAlias: null,
        resolvedProfile: "p",
      });
      expect(await repo.findTaskById("t")).toMatchObject({
        resolvedModel: "claude-x",
        modelSource: "tier",
        modelAlias: null,
        resolvedProfile: "p",
      });
      expect(await repo.agentRanModel("ag", "opus")).toBe(false);
      expect(await repo.agentRanModel("ag", "claude-x")).toBe(true);
      expect(await repo.agentRanModel("other", "claude-x")).toBe(false);
      await repo.clearTaskModelResolution("t");
      expect(await repo.findTaskById("t")).toMatchObject({
        resolvedModel: null,
        modelSource: null,
        resolvedProfile: null,
      });
    });

    test("in-progress reads for the API drain", async () => {
      const agent = (id: string, status: string, at: string) =>
        storage.executor.run(sql`
          INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, ${false}, ${status}, ${T0}, ${at})`);
      await agent("live", "busy", T1);
      await agent("stale", "busy", T0);
      await agent("off", "offline", T1);
      await seedTask(storage, { id: "a", agentId: "live", status: "in_progress" });
      await seedTask(storage, { id: "b", agentId: "stale", status: "in_progress" });
      await seedTask(storage, { id: "c", agentId: "off", status: "in_progress" });
      await seedTask(storage, { id: "d", agentId: "live", status: "pending" });
      expect(await repo.listLiveInProgressTaskIds(T1)).toEqual(["a"]);
      expect(await repo.countInProgressAmong(["a", "b", "d", "zz"])).toBe(2);
      expect(await repo.countInProgressAmong([])).toBe(0);
    });

    test("queueStallOldest counts claimable tasks and picks the oldest", async () => {
      expect(await repo.queueStallOldest()).toEqual({
        claimableCount: 0,
        oldestTaskId: null,
        oldestClaimableAt: null,
      });
      await seedTask(storage, { id: "dep", status: "completed", finishedAt: T1 });
      await seedTask(storage, { id: "open", status: "in_progress" });
      await seedTask(storage, {
        id: "q1",
        status: "unassigned",
        createdAt: T0,
        dependsOn: '["dep"]',
      });
      await seedTask(storage, { id: "q2", createdAt: "2026-11-21T10:30:00.000Z" });
      await seedTask(storage, { id: "blocked", dependsOn: '["open"]' });
      expect(await repo.queueStallOldest()).toEqual({
        claimableCount: 2,
        oldestTaskId: "q2",
        oldestClaimableAt: "2026-11-21T10:30:00.000Z",
      });
    });

    test("install and tree aggregates", async () => {
      expect(await repo.hasUserOrNonSystemTask()).toBe(false);
      await seedUsers("u1", "u2");
      expect(await repo.hasUserOrNonSystemTask()).toBe(true);
      await storage.executor.run(sql`DELETE FROM users`);
      await seedTask(storage, { id: "boot", taskType: "boot-triage" });
      expect(await repo.hasUserOrNonSystemTask()).toBe(false);
      await seedUsers("u1", "u2");
      await seedTask(storage, {
        id: "r",
        status: "completed",
        finishedAt: T0,
        requestedByUserId: "u1",
      });
      expect(await repo.hasUserOrNonSystemTask()).toBe(true);
      await seedTask(storage, { id: "k", parentTaskId: "r", status: "failed", finishedAt: T1 });
      expect(await repo.taskTreeSettlement("r", ["completed", "failed"])).toEqual({
        open: 0,
        deferred: 0,
        lastFinishedAt: T1,
      });
      await seedTask(storage, { id: "k2", parentTaskId: "k", requestedByUserId: "u2" });
      await storage.executor.run(sql`
        INSERT INTO scheduled_tasks (id, name, "taskTemplate", enabled, "parentTaskId", "taskType",
          "scheduleType", "nextRunAt", "createdAt", "lastUpdatedAt")
        VALUES ('s', 's', 't', ${true}, 'k', 'deferred', 'one_time', ${T1}, ${T0}, ${T0})`);
      expect(await repo.taskTreeSettlement("r", ["completed", "failed"])).toEqual({
        open: 1,
        deferred: 1,
        lastFinishedAt: T1,
      });
      expect(await repo.countFinishedTaskOutcomes()).toEqual({ completed: 1, failed: 1 });
      expect(await repo.countTaskActivitySince(T1)).toEqual({
        created: 0,
        completed: 0,
        failed: 1,
      });
      expect(await repo.countDistinctRequestersSince(T0)).toBe(2);
      expect(await repo.countDistinctRequestersSince(T1)).toBe(0);
    });

    test("carrySteeringMessages moves pending and delivered rows only", async () => {
      await seedTask(storage, { id: "from" });
      await seedTask(storage, { id: "to" });
      const steer = (id: string, status: string) =>
        storage.executor.run(sql`
          INSERT INTO task_steering_messages (id, task_id, body, mode, status, delivered_mode, source,
            created_by_kind, delivered_at)
          VALUES (${id}, 'from', 'b', 'steer', ${status}, 'steer', 'api', 'system', ${T0})`);
      await steer("p", "pending");
      await steer("d", "delivered");
      await steer("h", "handled");
      expect((await repo.carrySteeringMessages("from", "to")).sort()).toEqual(["d", "p"]);
      expect(
        await storage.executor.query(sql`
          SELECT id, task_id, status, delivered_mode, delivered_at FROM task_steering_messages ORDER BY id`),
      ).toEqual([
        { id: "d", task_id: "to", status: "pending", delivered_mode: null, delivered_at: null },
        { id: "h", task_id: "from", status: "handled", delivered_mode: "steer", delivered_at: T0 },
        { id: "p", task_id: "to", status: "pending", delivered_mode: null, delivered_at: null },
      ]);
    });

    test("slack threads, run task probes and depended-on ids", async () => {
      const terminal = ["completed", "failed", "cancelled"];
      await seedTask(storage, {
        id: "s1",
        slackChannelId: "C",
        slackThreadTs: "1",
        taskType: "deferred",
      });
      await seedTask(storage, { id: "s2" });
      const threads = await repo.listTaskSlackThreads(["s1", "s2", "zz"]);
      expect(threads).toHaveLength(2);
      expect(threads).toContainEqual({
        slackChannelId: "C",
        slackThreadTs: "1",
        taskType: "deferred",
      });
      expect(await repo.listTaskSlackThreads([])).toEqual([]);
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, triggers, enabled, "createdAt", "lastUpdatedAt")
        VALUES ('wf', 'wf', '{}', '[]', ${true}, ${T0}, ${T0})`);
      for (const run of ["r1", "r2"]) {
        await storage.executor.run(sql`
          INSERT INTO workflow_runs (id, "workflowId", status, "startedAt", "lastUpdatedAt")
          VALUES (${run}, 'wf', 'running', ${T0}, ${T0})`);
      }
      await seedTask(storage, { id: "w1", workflowRunId: "r1", status: "completed" });
      expect(await repo.hasOpenTaskOfRuns(["r1"], terminal)).toBe(false);
      expect(await repo.listOpenTaskIdsOfRuns(["r1"], terminal)).toEqual([]);
      await seedTask(storage, { id: "w2", workflowRunId: "r1", dependsOn: '["w1","x"]' });
      await seedTask(storage, { id: "w3", status: "completed", dependsOn: '["y"]' });
      expect(await repo.hasOpenTaskOfRuns(["r1", "r2"], terminal)).toBe(true);
      expect(await repo.listOpenTaskIdsOfRuns(["r1"], terminal)).toEqual(["w2"]);
      expect((await repo.listDependedOnTaskIds(terminal)).sort()).toEqual(["w1", "x"]);
    });

    test("findCitationTarget reads the target of each kind", async () => {
      await seedTask(storage, { id: "t1" });
      expect(await repo.findCitationTarget("task", "t1")).toEqual({ id: "t1" });
      expect(await repo.findCitationTarget("task", "missing")).toBeNull();
      expect(await repo.findCitationTarget("page", "missing")).toBeNull();
      expect(await repo.findCitationTarget("script-run", "missing")).toBeNull();
      expect(await repo.findCitationTarget("memory", "missing")).toBeNull();
    });

    test("shippingEvidenceSql matches PR attachments and PR output", async () => {
      await seedTask(storage, { id: "o", output: "Opened https://github.com/o/r/pull/7." });
      await seedTask(storage, { id: "n", output: "https://notgithub.com/o/r/pull/8" });
      await seedTask(storage, { id: "a" });
      await storage.executor.run(sql`
        INSERT INTO task_attachments (id, task_id, name, kind, url, created_at)
        VALUES ('x', 'a', 'x', 'url', 'https://example.com/report', ${T0})`);
      const e = repo.shippingEvidenceSql("t", "github.com");
      const read = (id: string) =>
        storage.executor.get(sql`
          SELECT ${e.hasArtifact} AS "hasArtifact", ${e.hasPullRequest} AS "hasPullRequest"
          FROM agent_tasks t WHERE t.id = ${id}`);
      expect(await read("o")).toEqual({ hasArtifact: 1, hasPullRequest: 1 });
      expect(await read("n")).toEqual({ hasArtifact: 0, hasPullRequest: 0 });
      expect(await read("a")).toEqual({ hasArtifact: 1, hasPullRequest: 0 });
      expect(() => repo.shippingEvidenceSql("t; x", "github.com")).toThrow(
        "Invalid task SQL alias",
      );
    });
  });
}
