import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MessagingRepository, type Storage, sql, sqlIdent } from "../../src";
import type { ContractEngine } from "./env";
import { seedTask } from "./tasks";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

export function messagingContract(engine: ContractEngine): void {
  describe(`messaging repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: MessagingRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.messaging;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    const obligation = (
      table: "slack_relay_obligations" | "chat_relay_obligations",
      taskId: string,
      createdAt: string,
      lastAttemptAt: string | null = null,
    ) =>
      storage.executor.run(sql`
        INSERT INTO ${sqlIdent(table)} (task_id, created_at, last_attempt_at)
        VALUES (${taskId}, ${createdAt}, ${lastAttemptAt})`);

    test("Slack relay obligations: order, attempts, delivery", async () => {
      for (const id of ["a", "b", "c", "d", "e"])
        await seedTask(storage, { id, status: "completed" });
      await storage.executor.run(sql`UPDATE agent_tasks SET status = 'pending' WHERE id = 'e'`);
      await storage.executor.run(sql`DELETE FROM slack_relay_obligations`);
      await obligation("slack_relay_obligations", "a", T1, T0);
      await obligation("slack_relay_obligations", "b", T1);
      await obligation("slack_relay_obligations", "c", T0);
      await obligation("slack_relay_obligations", "d", T0, T1);
      await obligation("slack_relay_obligations", "e", T0);
      expect(ids(await repo.listPendingSlackRelayTasks())).toEqual(["c", "b", "a", "d"]);
      expect(await repo.markSlackRelayAttempted("c", T1)).toBe(1);
      expect(ids(await repo.listPendingSlackRelayTasks())).toEqual(["b", "a", "c", "d"]);
      expect(await repo.markSlackRelayDelivered("b", T1)).toBe(1);
      expect(await repo.markSlackRelayDelivered("b", T1)).toBe(0);
      await storage.executor.run(sql`
        INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, task_id,
          finalized_at, created_at, updated_at)
        VALUES ('m1', 'k', 'C', '1.0', '1.1', 'outcome', 'a', ${T1}, ${T1}, ${T1})`);
      expect(await repo.markFinalizedSlackRelaysDelivered(T1)).toBe(1);
      expect(ids(await repo.listPendingSlackRelayTasks())).toEqual(["c", "d"]);
    });

    test("chat relay obligations: adapter filter, backoff, claims and give-ups", async () => {
      await seedTask(storage, {
        id: "s",
        status: "completed",
        contextKey: "task:chat-sdk:slack:1",
      });
      await seedTask(storage, {
        id: "t",
        status: "failed",
        contextKey: "task:chat-sdk:telegram:1",
      });
      await seedTask(storage, { id: "x", status: "completed", contextKey: "other" });
      await storage.executor.run(sql`DELETE FROM chat_relay_obligations`);
      await obligation("chat_relay_obligations", "s", T0);
      await obligation("chat_relay_obligations", "t", T0);
      await obligation("chat_relay_obligations", "x", T0);
      expect(await repo.listPendingChatRelayTasks(T1, 10, [])).toEqual([]);
      const rows = await repo.listPendingChatRelayTasks(T1, 10, ["slack", "telegram"]);
      expect(ids(rows)).toEqual(["s", "t"]);
      expect([rows[0]?.relay_created_at, rows[0]?.relay_last_error]).toEqual([T0, null]);
      expect(() => repo.listPendingChatRelayTasks(T1, 10, ["Bad*"])).toThrow(
        /invalid chat adapter/,
      );
      expect(await repo.markChatRelayAttempted("s", T1)).toBe(1);
      // In backoff for 3 s * 2^1 after the first attempt.
      expect(await repo.markChatRelayAttempted("s", T1)).toBe(0);
      expect(ids(await repo.listPendingChatRelayTasks(T1, 10, ["slack"]))).toEqual([]);
      expect(
        ids(await repo.listPendingChatRelayTasks("2026-11-21T11:00:07.000Z", 10, ["slack"])),
      ).toEqual(["s"]);
      expect(await repo.recordChatRelayError("s", "boom", T1)).toBe(1);
      expect(await repo.markChatRelayGivenUp("t", "nope", T1)).toBe(1);
      expect(await repo.markChatRelayGivenUp("t", "nope", T1)).toBe(0);
      expect(await repo.markChatRelayDelivered("s", T1)).toBe(1);
      expect(await repo.markChatRelayDelivered("s", T1)).toBe(0);
      expect(await repo.giveUpChatRelaysCreatedBefore(T1, T1, "old")).toBe(1);
      const left = await storage.executor.get<{ last_error: string }>(
        sql`SELECT last_error FROM chat_relay_obligations WHERE task_id = 'x'`,
      );
      expect(left?.last_error).toBe("old");
    });
  });
}
