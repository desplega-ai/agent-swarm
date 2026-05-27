import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, completeTask, createAgent, createTaskExtended, initDb } from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { applySiblingAwareness } from "../tasks/sibling-awareness";

const TEST_DB_PATH = "./test-sibling-awareness-db.sqlite";

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("applySiblingAwareness — no siblings", () => {
  test("returns description unchanged when no siblings exist", async () => {
    const key = slackContextKey({
      channelId: "C_SIB_NONE",
      threadTs: "1700000000.000001",
    });
    const out = await applySiblingAwareness({ description: "Do the thing", contextKey: key });
    expect(out.description).toBe("Do the thing");
    expect(out.parentTaskId).toBeUndefined();
    expect(out.siblings).toEqual([]);
  });

  test("returns description unchanged when contextKey is empty", async () => {
    const out = await applySiblingAwareness({ description: "body", contextKey: "" });
    expect(out.description).toBe("body");
    expect(out.parentTaskId).toBeUndefined();
    expect(out.siblings).toEqual([]);
  });
});

describe("applySiblingAwareness — with siblings", () => {
  test("prepends sibling block when an in-flight sibling exists", async () => {
    const agent = await createAgent({
      name: "sib-agent-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_1",
      threadTs: "1700000000.000002",
    });
    const existing = await createTaskExtended("First task that the user already sent", {
      agentId: agent.id,
      contextKey: key,
    });

    const result = await applySiblingAwareness({
      description: "Follow-up body",
      contextKey: key,
      currentAgentId: agent.id,
    });

    expect(result.description).toContain("<sibling_tasks_in_progress>");
    expect(result.description).toContain(`contextKey: ${key}`);
    expect(result.description).toContain(`task:${existing.id}`);
    expect(result.description).toContain(`agent:${agent.name}`);
    expect(result.description.endsWith("Follow-up body")).toBe(true);
    expect(result.siblings.map((s) => s.id)).toContain(existing.id);
  });

  test("auto-wires parentTaskId when sibling is on the same agent", async () => {
    const agent = await createAgent({
      name: "sib-agent-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_2",
      threadTs: "1700000000.000003",
    });
    const existing = await createTaskExtended("Original", {
      agentId: agent.id,
      contextKey: key,
    });

    const result = await applySiblingAwareness({
      description: "Follow-up",
      contextKey: key,
      currentAgentId: agent.id,
    });
    expect(result.parentTaskId).toBe(existing.id);
  });

  test("does NOT auto-wire parentTaskId when sibling is on a different agent", async () => {
    const agentA = await createAgent({
      name: "sib-agent-3A",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const agentB = await createAgent({
      name: "sib-agent-3B",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_3",
      threadTs: "1700000000.000004",
    });
    await createTaskExtended("Task on A", { agentId: agentA.id, contextKey: key });

    // New task is destined for agentB — no resume wiring.
    const result = await applySiblingAwareness({
      description: "Body",
      contextKey: key,
      currentAgentId: agentB.id,
    });
    expect(result.parentTaskId).toBeUndefined();
    // But the sibling block is still included so agentB sees what's in flight.
    expect(result.description).toContain("<sibling_tasks_in_progress>");
    expect(result.description).toContain(`agent:${agentA.name}`);
  });

  test("does NOT auto-wire parentTaskId when currentAgentId is undefined", async () => {
    const agent = await createAgent({
      name: "sib-agent-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_4",
      threadTs: "1700000000.000005",
    });
    await createTaskExtended("Existing", { agentId: agent.id, contextKey: key });

    const result = await applySiblingAwareness({ description: "Body", contextKey: key });
    expect(result.parentTaskId).toBeUndefined();
    // Block still included — useful for the worker that eventually picks it up.
    expect(result.description).toContain("<sibling_tasks_in_progress>");
  });

  test("excludes terminal tasks (completed) from sibling results", async () => {
    const agent = await createAgent({
      name: "sib-agent-5",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_5",
      threadTs: "1700000000.000006",
    });
    const done = await createTaskExtended("Done", { agentId: agent.id, contextKey: key });
    await completeTask(done.id, "ok");

    const result = await applySiblingAwareness({
      description: "Body",
      contextKey: key,
      currentAgentId: agent.id,
    });
    expect(result.siblings).toEqual([]);
    expect(result.description).toBe("Body");
    expect(result.parentTaskId).toBeUndefined();
  });
});
