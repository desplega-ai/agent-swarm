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

    const addAgent = (id: string) =>
      storage.executor.run(sql`
        INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
        VALUES (${id}, ${`name-${id}`}, ${false}, 'idle', ${T0}, ${T0})`);

    test("channels and messages: names, order, mention and unread counts", async () => {
      await addAgent("a1");
      await addAgent("a2x");
      const chan = await repo.insertChannel({
        id: "c1",
        name: "zeta",
        description: null,
        type: "public",
        createdBy: null,
        participants: "[]",
        createdAt: T0,
      });
      expect(chan?.name).toBe("zeta");
      await repo.insertChannel({ ...chan!, id: "c2", name: "alpha" });
      const before = ids(await repo.listChannels());
      expect(before.indexOf("c2")).toBeLessThan(before.indexOf("c1"));
      expect((await repo.findChannelByName("alpha"))?.id).toBe("c2");
      const msg = (id: string, agentId: string | null, mentions: string, createdAt: string) =>
        repo.insertChannelMessage({
          id,
          channelId: "c1",
          agentId,
          content: id,
          replyToId: null,
          mentions,
          createdAt,
        });
      await msg("m1", "a1", "[]", T0);
      await msg("m2", null, '["a1"]', T1);
      await msg("m3", "a2x", '["A1"]', T1);
      expect((await repo.findChannelMessageWithAgent("m1"))?.agentName).toBe("name-a1");
      expect(await repo.findChannelMessage("m1")).not.toHaveProperty("agentName");
      expect(ids(await repo.listChannelMessages("c1", {}))).toEqual(["m3", "m2", "m1"]);
      expect(ids(await repo.listChannelMessages("c1", { since: T0, limit: 1 }))).toEqual(["m3"]);
      expect(ids(await repo.listChannelMessages("c1", { before: T1 }))).toEqual(["m1"]);
      expect(ids(await repo.listChannelMessagesSince("c1", null))).toEqual(["m1", "m2", "m3"]);
      expect(ids(await repo.listChannelMessagesSince("c1", T0))).toEqual(["m2", "m3"]);
      expect(ids(await repo.listMentionMessages("a1", {}))).toEqual(["m3", "m2"]);
      expect(ids(await repo.listMentionMessages("a1", { channelId: "c2" }))).toEqual([]);
      expect(await repo.countUnreadChannelMessages("c1", "a1", null)).toBe(2);
      expect(await repo.countUnreadChannelMessages("c1", "a1", T1)).toBe(0);
      expect(await repo.countChannelMentions("c1", "a1", null)).toBe(2);
      expect(await repo.listUnreadChannelMentions("a1")).toEqual([
        { channelId: "c1", lastReadAt: null, count: 2 },
      ]);
      expect(await repo.listUnreadChannelMentions("a2x")).toEqual([]);
      // A second channel the agent never read: its message counts as unread too.
      await repo.insertChannelMessage({
        id: "m4",
        channelId: "c2",
        agentId: null,
        content: "m4",
        replyToId: null,
        mentions: "[]",
        createdAt: T0,
      });
      const inbox = (unreadCount: number, mentionsCount: number) => ({
        unreadCount,
        mentionsCount,
      });
      expect(await repo.countUnreadInbox("a1")).toEqual(inbox(3, 2));
      expect(await repo.countUnreadInbox("a2x")).toEqual(inbox(3, 0));
      expect(await repo.listChannelReadStates("a1")).toEqual([]);
      await repo.setChannelLastRead("a1", "c1", T0);
      expect(await repo.listUnreadChannelMentions("a1")).toEqual([
        { channelId: "c1", lastReadAt: T0, count: 2 },
      ]);
      expect(await repo.countUnreadInbox("a1")).toEqual(inbox(3, 2));
      await repo.setChannelLastRead("a1", "c1", T1);
      expect(await repo.listUnreadChannelMentions("a1")).toEqual([]);
      expect(await repo.countUnreadInbox("a1")).toEqual(inbox(1, 0));
      await repo.setChannelLastRead("a1", "c1", T0);
      expect(await repo.claimChannelMentions("a1", "c1", T0, T1)).toBe(1);
      expect(await repo.listUnreadChannelMentions("a1")).toEqual([]);
      // A channel being processed drops out of both counts.
      expect(await repo.countUnreadInbox("a1")).toEqual(inbox(1, 0));
      expect(await repo.listChannelReadStates("a1")).toEqual([
        { channelId: "c1", lastReadAt: T0, processing_since: T1 },
      ]);
      await repo.setChannelMessageContent("m1", "edited");
      expect((await repo.findChannelMessage("m1"))?.content).toBe("edited");
      expect(await repo.deleteChannel("c2")).toBe(1);
    });

    test("channel read state: claims are exclusive until released", async () => {
      await addAgent("a1");
      await repo.insertChannel({
        id: "c1",
        name: "c",
        description: null,
        type: "public",
        createdBy: null,
        participants: "[]",
        createdAt: T0,
      });
      expect(await repo.findChannelReadState("a1", "c1")).toBeNull();
      expect(await repo.claimChannelMentions("a1", "c1", T0, T1)).toBe(1);
      expect(await repo.claimChannelMentions("a1", "c1", T0, T1)).toBe(0);
      expect(await repo.findChannelReadState("a1", "c1")).toEqual({
        lastReadAt: T0,
        processing_since: T1,
      });
      await repo.releaseChannelProcessing("a1", ["c1"]);
      await repo.releaseChannelProcessing("a1", []);
      expect(await repo.claimChannelMentions("a1", "c1", T0, T0)).toBe(1);
      expect(await repo.releaseChannelProcessingBefore(T1)).toBe(1);
      await repo.setChannelLastRead("a1", "c1", T1);
      await repo.setChannelLastRead("a1", "c1", T1);
      expect((await repo.findChannelReadState("a1", "c1"))?.lastReadAt).toBe(T1);
    });

    test("inbox messages: unread order, guarded transitions, stale release", async () => {
      await addAgent("a1");
      const row = (id: string, createdAt: string) => ({
        id,
        agentId: "a1",
        content: "c",
        source: "slack",
        status: "unread",
        slackChannelId: null,
        slackThreadTs: null,
        slackUserId: null,
        matchedText: null,
        delegatedToTaskId: null,
        responseText: null,
        createdAt,
        lastUpdatedAt: createdAt,
      });
      expect(await repo.insertInboxMessage(row("i2", T0))).toMatchObject(row("i2", T0));
      await repo.insertInboxMessage(row("i1", T0));
      await repo.insertInboxMessage(row("i3", T1));
      expect(ids(await repo.listUnreadInboxMessages("a1"))).toEqual(["i2", "i1", "i3"]);
      expect(ids(await repo.listUnreadInboxMessages("a1", 2))).toEqual(["i2", "i1"]);
      const claimed = await repo.markInboxMessagesProcessing(["i2", "i1"], T1);
      expect(new Set(ids(claimed))).toEqual(new Set(["i1", "i2"]));
      expect(await repo.markInboxMessagesProcessing(["i2"], T1)).toEqual([]);
      expect(ids(await repo.listProcessingInboxMessages())).toEqual(["i1", "i2"]);
      expect((await repo.markInboxMessageResponded("i1", "r", T1))?.status).toBe("responded");
      expect(await repo.markInboxMessageResponded("i1", "r", T1)).toBeNull();
      await seedTask(storage, { id: "t" });
      expect((await repo.markInboxMessageDelegated("i3", "t", T1))?.delegatedToTaskId).toBe("t");
      expect(await repo.markInboxMessageDelegated("i3", "t", T1)).toBeNull();
      expect(await repo.releaseInboxProcessingBefore("2026-12-01", T1)).toBe(1);
      expect((await repo.findInboxMessage("i2"))?.status).toBe("unread");
      expect((await repo.markInboxMessageRead("i2", T1))?.status).toBe("read");
    });

    test("AgentMail mappings refresh only for the owning agent", async () => {
      await addAgent("a1");
      await addAgent("a2");
      const m = { id: "m1", inboxId: "in", agentId: "a1", inboxEmail: "x@y", createdAt: T0 };
      expect(await repo.upsertAgentMailInboxMapping(m)).toMatchObject(m);
      expect(
        await repo.upsertAgentMailInboxMapping({ ...m, id: "m2", agentId: "a2", inboxEmail: "z" }),
      ).toBeNull();
      expect(
        (await repo.upsertAgentMailInboxMapping({ ...m, id: "m3", inboxEmail: "new" }))?.inboxEmail,
      ).toBe("new");
      await repo.upsertAgentMailInboxMapping({ ...m, id: "m4", inboxId: "in2", agentId: "a2" });
      await repo.upsertAgentMailInboxMapping({ ...m, id: "m5", inboxId: "in3", agentId: "a2" });
      expect(ids(await repo.listAgentMailInboxMappings())).toEqual(["m5", "m4", "m1"]);
      expect(ids(await repo.listAgentMailInboxMappings("a1"))).toEqual(["m1"]);
      expect((await repo.findAgentMailInboxMapping("in"))?.agentId).toBe("a1");
      expect(await repo.deleteAgentMailInboxMapping("in")).toBe(1);
      expect(await repo.deleteAgentMailInboxMapping("in")).toBe(0);
    });

    test("channel activity cursors upsert with the database clock", async () => {
      await repo.upsertChannelActivityCursor("C2", "1.0");
      await repo.upsertChannelActivityCursor("C1", "2.0");
      await repo.upsertChannelActivityCursor("C2", "3.0");
      const rows = await repo.listChannelActivityCursors();
      expect(rows.map((r) => [r.channelId, r.lastSeenTs])).toEqual([
        ["C2", "3.0"],
        ["C1", "2.0"],
      ]);
      expect((await repo.findChannelActivityCursor("C1"))?.updatedAt).toMatch(/Z$/);
      expect(await repo.findChannelActivityCursor("C9")).toBeNull();
    });

    test("inbox item state: sticky readAt, optional lastReadAt, list order", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U')`);
      const base = {
        userId: "u1",
        itemType: "task",
        itemId: "t1",
        status: "unread",
        snoozeUntil: null,
        dismissedAt: null,
        doneAt: null,
        readAt: T0,
        lastReadAt: T0,
        createdAt: T0,
        lastUpdatedAt: T0,
      };
      const first = await repo.upsertInboxItemState(base, true);
      expect(typeof first?.id).toBe("string");
      const second = await repo.upsertInboxItemState(
        { ...base, status: "done", readAt: T1, lastReadAt: T1, lastUpdatedAt: T1 },
        false,
      );
      expect([second?.status, second?.readAt, second?.lastReadAt, second?.id]).toEqual([
        "done",
        T0,
        T0,
        first?.id,
      ]);
      const third = await repo.upsertInboxItemState({ ...base, lastReadAt: null }, true);
      expect(third?.lastReadAt).toBeNull();
      await repo.upsertInboxItemState({ ...base, itemId: "t2", status: "done" }, false);
      const rows = await repo.listInboxItemStates({ userId: "u1" });
      expect(rows.map((r) => r.itemId)).toEqual(["t2", "t1"]);
      expect(
        (await repo.listInboxItemStates({ userId: "u1", status: "done" })).map((r) => r.itemId),
      ).toEqual(["t2"]);
      expect(await repo.listInboxItemStates({ userId: "u1", itemType: "page" })).toEqual([]);
    });
  });
}
