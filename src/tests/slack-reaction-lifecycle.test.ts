import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failSlackReactionGroup,
  failTask,
  getDb,
  getPendingSlackTaskReactionGroups,
  initDb,
  openSlackReactionGroup,
  recordSlackTaskReaction,
  sealSlackReactionGroup,
} from "../be/db";
import { processSlackTerminalReactions, terminalSlackReaction } from "../slack/ack";

const TEST_DB_PATH = "./test-slack-reaction-lifecycle.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

beforeEach(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("Slack task reaction lifecycle", () => {
  test("rolls one human message up only after every correlated task completes", async () => {
    const agent = createAgent({ name: "Reaction worker", isLead: false, status: "idle" });
    const first = createTaskExtended("first routed task", { agentId: agent.id, source: "slack" });
    const second = createTaskExtended("second routed task", {
      agentId: agent.id,
      source: "slack",
    });
    for (const task of [first, second]) {
      recordSlackTaskReaction({
        channelId: "C_ROLLUP",
        messageTs: "100.2",
        taskId: task.id,
        acceptanceReaction: "eyes",
      });
    }
    sealSlackReactionGroup("C_ROLLUP", "100.2");

    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    const client = { reactions: { add, remove } } as never;

    completeTask(first.id, "first done");
    await processSlackTerminalReactions(client);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(1);

    completeTask(second.id, "second done");
    await processSlackTerminalReactions(client);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({
      channel: "C_ROLLUP",
      name: "eyes",
      timestamp: "100.2",
    });
    expect(add).toHaveBeenCalledWith({
      channel: "C_ROLLUP",
      name: "white_check_mark",
      timestamp: "100.2",
    });
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("uses x when any task correlated to the message fails", async () => {
    const agent = createAgent({ name: "Failure worker", isLead: false, status: "idle" });
    const completed = createTaskExtended("successful branch", { agentId: agent.id });
    const failed = createTaskExtended("failed branch", { agentId: agent.id });
    for (const task of [completed, failed]) {
      recordSlackTaskReaction({
        channelId: "D_FAILURE",
        messageTs: "200.3",
        taskId: task.id,
        acceptanceReaction: "heavy_plus_sign",
      });
    }
    sealSlackReactionGroup("D_FAILURE", "200.3");
    completeTask(completed.id, "done");
    failTask(failed.id, "boom");

    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);

    expect(remove).toHaveBeenCalledWith({
      channel: "D_FAILURE",
      name: "heavy_plus_sign",
      timestamp: "200.3",
    });
    expect(add).toHaveBeenCalledWith({
      channel: "D_FAILURE",
      name: "x",
      timestamp: "200.3",
    });
  });

  test("one task can settle every buffered message linked to it", async () => {
    const task = createTaskExtended("batched follow-up", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_BUFFER",
      messageTs: "300.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    recordSlackTaskReaction({
      channelId: "C_BUFFER",
      messageTs: "300.2",
      taskId: task.id,
      acceptanceReaction: "heavy_plus_sign",
    });
    sealSlackReactionGroup("C_BUFFER", "300.1");
    sealSlackReactionGroup("C_BUFFER", "300.2");
    completeTask(task.id, "batch done");

    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);

    expect(remove.mock.calls.map((call) => call[0]).filter((call) => call.name !== "x")).toEqual([
      { channel: "C_BUFFER", name: "eyes", timestamp: "300.1" },
      { channel: "C_BUFFER", name: "heavy_plus_sign", timestamp: "300.2" },
    ]);
    expect(add).toHaveBeenCalledTimes(2);
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("benign Slack errors finalize while transient failures remain retryable", async () => {
    const task = createTaskExtended("retry reaction", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_RETRY",
      messageTs: "400.1",
      taskId: task.id,
      acceptanceReaction: "zap",
    });
    sealSlackReactionGroup("C_RETRY", "400.1");
    completeTask(task.id, "done");

    const transientRemove = mock(async () => {
      throw new Error("temporary Slack outage");
    });
    const add = mock(async () => ({}));
    await expect(
      processSlackTerminalReactions({
        reactions: { add, remove: transientRemove },
      } as never),
    ).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(1);

    const noReaction = mock(async () => {
      throw { data: { error: "no_reaction" } };
    });
    const alreadyReacted = mock(async () => {
      throw { data: { error: "already_reacted" } };
    });
    await processSlackTerminalReactions({
      reactions: { add: alreadyReacted, remove: noReaction },
    } as never);
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("uses the outcome-card completed/failed vocabulary", () => {
    expect(terminalSlackReaction(["completed", "completed"])).toBe("white_check_mark");
    expect(terminalSlackReaction(["completed", "failed"])).toBe("x");
    expect(terminalSlackReaction(["completed", "cancelled"])).toBe("x");
    expect(terminalSlackReaction(["superseded"])).toBe("x");
  });

  test("deleting a task preserves a failure tombstone for Slack cleanup", async () => {
    const task = createTaskExtended("deleted task", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_DELETE",
      messageTs: "500.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    sealSlackReactionGroup("C_DELETE", "500.1");
    getDb().run("DELETE FROM agent_tasks WHERE id = ?", [task.id]);
    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).toHaveBeenCalledWith({
      channel: "C_DELETE",
      name: "x",
      timestamp: "500.1",
    });
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("message_not_found finalizes without trying to add a terminal reaction", async () => {
    const task = createTaskExtended("missing Slack message", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_MISSING",
      messageTs: "600.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    sealSlackReactionGroup("C_MISSING", "600.1");
    completeTask(task.id, "done");
    const remove = mock(async () => {
      throw { data: { error: "message_not_found" } };
    });
    const add = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).not.toHaveBeenCalled();
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("a transient terminal-add failure retries on the next watcher pass", async () => {
    const task = createTaskExtended("retry terminal add", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_ADD_RETRY",
      messageTs: "650.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    sealSlackReactionGroup("C_ADD_RETRY", "650.1");
    completeTask(task.id, "done");
    const remove = mock(async () => ({}));
    const transientAdd = mock(async () => {
      throw new Error("temporary add failure");
    });
    await processSlackTerminalReactions({
      reactions: { add: transientAdd, remove },
    } as never);
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(1);

    const add = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).toHaveBeenCalledWith({
      channel: "C_ADD_RETRY",
      name: "white_check_mark",
      timestamp: "650.1",
    });
    expect(getPendingSlackTaskReactionGroups()).toHaveLength(0);
  });

  test("an abandoned pre-flush buffer resolves as failed after restart", async () => {
    openSlackReactionGroup({
      channelId: "C_ABANDONED",
      messageTs: "675.1",
      acceptanceReaction: "heavy_plus_sign",
    });
    getDb().run(
      `UPDATE slack_reaction_groups
       SET abandon_after = '2000-01-01T00:00:00.000Z'
       WHERE channel_id = 'C_ABANDONED' AND message_ts = '675.1'`,
    );
    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(remove).toHaveBeenCalledWith({
      channel: "C_ABANDONED",
      name: "heavy_plus_sign",
      timestamp: "675.1",
    });
    expect(add).toHaveBeenCalledWith({
      channel: "C_ABANDONED",
      name: "x",
      timestamp: "675.1",
    });
  });

  test("an abandoned partial fan-out waits for linked work, then resolves x", async () => {
    const task = createTaskExtended("only linked branch", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_PARTIAL_RESTART",
      messageTs: "680.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    getDb().run(
      `UPDATE slack_reaction_groups
       SET abandon_after = '2000-01-01T00:00:00.000Z'
       WHERE channel_id = 'C_PARTIAL_RESTART' AND message_ts = '680.1'`,
    );
    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).not.toHaveBeenCalled();

    completeTask(task.id, "linked branch done");
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).toHaveBeenCalledWith({
      channel: "C_PARTIAL_RESTART",
      name: "x",
      timestamp: "680.1",
    });
  });

  test("a forced partial-routing failure overrides a successful linked branch", async () => {
    const task = createTaskExtended("successful routed branch", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_PARTIAL_ROUTE",
      messageTs: "690.1",
      taskId: task.id,
      acceptanceReaction: "eyes",
    });
    expect(failSlackReactionGroup("C_PARTIAL_ROUTE", "690.1")).toBe(true);
    completeTask(task.id, "linked branch done");
    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).toHaveBeenCalledWith({
      channel: "C_PARTIAL_ROUTE",
      name: "x",
      timestamp: "690.1",
    });
  });

  test("sealing reports false when no durable message lifecycle exists", () => {
    expect(sealSlackReactionGroup("C_UNKNOWN", "699.1")).toBe(false);
  });

  test("an unsealed fan-out cannot finalize while more tasks are being linked", async () => {
    const first = createTaskExtended("first branch", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_UNSEALED",
      messageTs: "700.1",
      taskId: first.id,
      acceptanceReaction: "eyes",
    });
    completeTask(first.id, "done");
    const add = mock(async () => ({}));
    const remove = mock(async () => ({}));
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).not.toHaveBeenCalled();

    const second = createTaskExtended("second branch", { source: "slack" });
    recordSlackTaskReaction({
      channelId: "C_UNSEALED",
      messageTs: "700.1",
      taskId: second.id,
      acceptanceReaction: "eyes",
    });
    sealSlackReactionGroup("C_UNSEALED", "700.1");
    failTask(second.id, "failed");
    await processSlackTerminalReactions({ reactions: { add, remove } } as never);
    expect(add).toHaveBeenCalledWith({
      channel: "C_UNSEALED",
      name: "x",
      timestamp: "700.1",
    });
  });
});
