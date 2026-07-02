import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDb,
  getInProgressTasksByContextKey,
  initDb,
} from "../be/db";
import { linearContextKey, slackContextKey } from "../tasks/context-key";

const TEST_DB_PATH = "./test-context-key-db.sqlite";

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

describe("contextKey persistence + lookup", () => {
  test("createTaskExtended persists contextKey and getInProgressTasksByContextKey returns it", () => {
    const agent = createAgent({
      name: "ctx-key-agent-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const key = slackContextKey({ channelId: "C_TEST_1", threadTs: "1700000000.000001" });
    const task = createTaskExtended("Hello", { agentId: agent.id, contextKey: key });

    expect(task.contextKey).toBe(key);

    const siblings = getInProgressTasksByContextKey(key);
    expect(siblings.map((t) => t.id)).toContain(task.id);
  });

  test("getInProgressTasksByContextKey excludes terminal tasks", () => {
    const agent = createAgent({
      name: "ctx-key-agent-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const key = slackContextKey({ channelId: "C_TEST_2", threadTs: "1700000000.000002" });
    const done = createTaskExtended("Done task", { agentId: agent.id, contextKey: key });
    const pending = createTaskExtended("Pending task", { agentId: agent.id, contextKey: key });

    completeTask(done.id, "ok");

    const siblings = getInProgressTasksByContextKey(key);
    const ids = siblings.map((t) => t.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(done.id);
  });

  test("getInProgressTasksByContextKey returns empty for unknown key", () => {
    const results = getInProgressTasksByContextKey("task:slack:C_NONE:0");
    expect(results).toEqual([]);
  });

  test("child task inherits contextKey from parent", () => {
    const agent = createAgent({
      name: "ctx-key-agent-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const key = slackContextKey({ channelId: "C_TEST_3", threadTs: "1700000000.000003" });
    const parent = createTaskExtended("Parent", { agentId: agent.id, contextKey: key });
    const child = createTaskExtended("Child", { agentId: agent.id, parentTaskId: parent.id });

    expect(child.contextKey).toBe(key);
  });

  test("createTaskExtended skips duplicate active Linear tracker contextKey", () => {
    const agent = createAgent({
      name: "ctx-key-agent-linear-active",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const key = linearContextKey({ issueIdentifier: "DES-201" });
    const first = createTaskExtended("First Linear task", { agentId: agent.id, contextKey: key });
    const second = createTaskExtended("Duplicate Linear task", {
      agentId: agent.id,
      contextKey: key,
    });

    expect(second.id).toBe(first.id);
    const count = getDb()
      .query("SELECT COUNT(*) AS count FROM agent_tasks WHERE contextKey = ?")
      .get(key) as { count: number };
    expect(count.count).toBe(1);
  });

  test("createTaskExtended skips duplicate Linear tracker contextKey with linked PR", () => {
    const agent = createAgent({
      name: "ctx-key-agent-linear-pr",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const key = linearContextKey({ issueIdentifier: "DES-202" });
    const first = createTaskExtended("Completed Linear task with PR", {
      agentId: agent.id,
      contextKey: key,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 875,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/875",
    });
    completeTask(first.id, "PR opened");

    const second = createTaskExtended("Duplicate Linear task after PR", {
      agentId: agent.id,
      contextKey: key,
    });

    expect(second.id).toBe(first.id);
    const count = getDb()
      .query("SELECT COUNT(*) AS count FROM agent_tasks WHERE contextKey = ?")
      .get(key) as { count: number };
    expect(count.count).toBe(1);
  });
});
