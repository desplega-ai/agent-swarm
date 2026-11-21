import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Storage, sql, type TasksRepository } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

type SeedTask = {
  id: string;
  task?: string;
  status?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  agentId?: string | null;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
  slackTriggerMessageTs?: string | null;
  slackParticipants?: string | null;
};

export function seedTask(storage: Storage, t: SeedTask) {
  const createdAt = t.createdAt ?? T0;
  return storage.executor.run(sql`
    INSERT INTO agent_tasks (
      id, task, status, "createdAt", "lastUpdatedAt", "agentId",
      "slackChannelId", "slackThreadTs", "slackTriggerMessageTs", "slackParticipants"
    ) VALUES (
      ${t.id}, ${t.task ?? "t"}, ${t.status ?? "pending"}, ${createdAt}, ${t.lastUpdatedAt ?? createdAt},
      ${t.agentId ?? null}, ${t.slackChannelId ?? null}, ${t.slackThreadTs ?? null},
      ${t.slackTriggerMessageTs ?? null}, ${t.slackParticipants ?? null}
    )`);
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
