import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getPendingSlackRelayTasks,
  initDb,
  markFinalizedSlackRelaysDelivered,
  markSlackRelayAttempted,
  markSlackRelayDelivered,
  recordSlackMessage,
} from "../be/db";

const TEST_DB_PATH = "./test-slack-relay-obligations.sqlite";
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedMigrationTemplate: Uint8Array | undefined;

function removeTestDb(): void {
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // The SQLite sidecars are not always created.
    }
  }
}

beforeAll(() => {
  closeDb();
  savedMigrationTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  removeTestDb();
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  removeTestDb();
  testGlobals.__testMigrationTemplate = savedMigrationTemplate;
});

describe("durable Slack relay obligations", () => {
  test("survives a database restart until delivery is marked", async () => {
    const agent = await createAgent({ name: "RelayAgent", isLead: true, status: "idle" });
    const task = await createTaskExtended("relay this result", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY",
      slackThreadTs: "1000000000.000001",
      slackUserId: "U_RELAY",
    });

    await completeTask(task.id, "durable result");
    expect((await getPendingSlackRelayTasks()).map((pending) => pending.id)).toContain(task.id);

    closeDb();
    initDb(TEST_DB_PATH);

    expect((await getPendingSlackRelayTasks()).map((pending) => pending.id)).toContain(task.id);

    expect(await markSlackRelayDelivered(task.id)).toBe(true);
    expect(await markSlackRelayDelivered(task.id)).toBe(false);
    expect((await getPendingSlackRelayTasks()).map((pending) => pending.id)).not.toContain(task.id);
  });

  test("rotates attempted obligations behind fresh work", async () => {
    const agent = await createAgent({ name: "RelayRotationAgent", isLead: true, status: "idle" });
    const first = await createTaskExtended("first relay", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY_ROTATION",
      slackThreadTs: "1000000000.000010",
    });
    const second = await createTaskExtended("second relay", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY_ROTATION",
      slackThreadTs: "1000000000.000011",
    });
    await completeTask(first.id, "first");
    await completeTask(second.id, "second");

    const before = (await getPendingSlackRelayTasks()).map((pending) => pending.id);
    expect(before.indexOf(first.id)).toBeLessThan(before.indexOf(second.id));

    await markSlackRelayAttempted(first.id);
    const after = (await getPendingSlackRelayTasks()).map((pending) => pending.id);
    expect(after.indexOf(second.id)).toBeLessThan(after.indexOf(first.id));
  });

  test("enqueues failed and cancelled Slack roots", async () => {
    const agent = await createAgent({ name: "RelayTerminalAgent", isLead: true, status: "idle" });
    const failed = await createTaskExtended("failed relay", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY",
      slackThreadTs: "1000000000.000002",
    });
    const cancelled = await createTaskExtended("cancelled relay", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY",
      slackThreadTs: "1000000000.000003",
    });

    await failTask(failed.id, "expected test failure");
    await cancelTask(cancelled.id, "expected test cancellation");

    const pendingIds = (await getPendingSlackRelayTasks()).map((pending) => pending.id);
    expect(pendingIds).toContain(failed.id);
    expect(pendingIds).toContain(cancelled.id);
  });

  test("enqueues Slack follow-ups but not non-Slack descendants", async () => {
    const agent = await createAgent({ name: "RelayScopeAgent", isLead: true, status: "idle" });
    const nonSlack = await createTaskExtended("not a Slack task", {
      agentId: agent.id,
      source: "mcp",
    });
    const root = await createTaskExtended("Slack root", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY",
      slackThreadTs: "1000000000.000004",
    });
    const slackFollowUp = await createTaskExtended("Slack follow-up", {
      agentId: agent.id,
      source: "slack",
      parentTaskId: root.id,
    });
    const delegatedChild = await createTaskExtended("delegated child", {
      agentId: agent.id,
      source: "mcp",
      parentTaskId: root.id,
    });

    await completeTask(nonSlack.id, "done");
    await completeTask(slackFollowUp.id, "done");
    await completeTask(delegatedChild.id, "done");

    const pendingIds = (await getPendingSlackRelayTasks()).map((pending) => pending.id);
    expect(pendingIds).not.toContain(nonSlack.id);
    expect(pendingIds).toContain(slackFollowUp.id);
    expect(pendingIds).not.toContain(delegatedChild.id);
  });

  test("accepts renderer v2's finalized outcome as delivery", async () => {
    const agent = await createAgent({ name: "RelayV2Agent", isLead: true, status: "idle" });
    const task = await createTaskExtended("renderer v2 relay", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_RELAY_V2",
      slackThreadTs: "1000000000.000005",
    });
    await completeTask(task.id, "delivered by v2");
    await recordSlackMessage({
      contextKey: `slack:C_RELAY_V2:1000000000.000005`,
      channelId: "C_RELAY_V2",
      threadTs: "1000000000.000005",
      ts: "1000000000.000006",
      kind: "outcome",
      taskId: task.id,
      finalized: true,
    });

    expect(await markFinalizedSlackRelaysDelivered()).toBe(1);
    expect((await getPendingSlackRelayTasks()).map((pending) => pending.id)).not.toContain(task.id);
  });
});
