import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, completeTask, createAgent, createTaskExtended, initDb } from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { applySiblingAwareness } from "../tasks/sibling-awareness";

const TEST_DB_PATH = "./test-sibling-awareness-db.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
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
  test("returns description unchanged when no siblings exist", () => {
    const key = slackContextKey({
      channelId: "C_SIB_NONE",
      threadTs: "1700000000.000001",
    });
    const out = applySiblingAwareness({ description: "Do the thing", contextKey: key });
    expect(out.description).toBe("Do the thing");
    expect(out.parentTaskId).toBeUndefined();
    expect(out.siblings).toEqual([]);
  });

  test("returns description unchanged when contextKey is empty", () => {
    const out = applySiblingAwareness({ description: "body", contextKey: "" });
    expect(out.description).toBe("body");
    expect(out.parentTaskId).toBeUndefined();
    expect(out.siblings).toEqual([]);
  });
});

describe("applySiblingAwareness — with siblings", () => {
  test("prepends sibling block when an in-flight sibling exists", () => {
    const agent = createAgent({
      name: "sib-agent-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_1",
      threadTs: "1700000000.000002",
    });
    const existing = createTaskExtended("First task that the user already sent", {
      agentId: agent.id,
      contextKey: key,
    });

    const result = applySiblingAwareness({
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

  test("auto-wires parentTaskId when sibling is on the same agent", () => {
    const agent = createAgent({
      name: "sib-agent-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_2",
      threadTs: "1700000000.000003",
    });
    const existing = createTaskExtended("Original", {
      agentId: agent.id,
      contextKey: key,
    });

    const result = applySiblingAwareness({
      description: "Follow-up",
      contextKey: key,
      currentAgentId: agent.id,
    });
    expect(result.parentTaskId).toBe(existing.id);
  });

  test("does NOT auto-wire parentTaskId when sibling is on a different agent", () => {
    const agentA = createAgent({
      name: "sib-agent-3A",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const agentB = createAgent({
      name: "sib-agent-3B",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_3",
      threadTs: "1700000000.000004",
    });
    createTaskExtended("Task on A", { agentId: agentA.id, contextKey: key });

    // New task is destined for agentB — no resume wiring.
    const result = applySiblingAwareness({
      description: "Body",
      contextKey: key,
      currentAgentId: agentB.id,
    });
    expect(result.parentTaskId).toBeUndefined();
    // But the sibling block is still included so agentB sees what's in flight.
    expect(result.description).toContain("<sibling_tasks_in_progress>");
    expect(result.description).toContain(`agent:${agentA.name}`);
  });

  test("does NOT auto-wire parentTaskId when currentAgentId is undefined", () => {
    const agent = createAgent({
      name: "sib-agent-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_4",
      threadTs: "1700000000.000005",
    });
    createTaskExtended("Existing", { agentId: agent.id, contextKey: key });

    const result = applySiblingAwareness({ description: "Body", contextKey: key });
    expect(result.parentTaskId).toBeUndefined();
    // Block still included — useful for the worker that eventually picks it up.
    expect(result.description).toContain("<sibling_tasks_in_progress>");
  });

  test("excludes terminal tasks (completed) from sibling results", () => {
    const agent = createAgent({
      name: "sib-agent-5",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const key = slackContextKey({
      channelId: "C_SIB_5",
      threadTs: "1700000000.000006",
    });
    const done = createTaskExtended("Done", { agentId: agent.id, contextKey: key });
    completeTask(done.id, "ok");

    const result = applySiblingAwareness({
      description: "Body",
      contextKey: key,
      currentAgentId: agent.id,
    });
    expect(result.siblings).toEqual([]);
    expect(result.description).toBe("Body");
    expect(result.parentTaskId).toBeUndefined();
  });
});
