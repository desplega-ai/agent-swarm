import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, getDb, initDb } from "../be/db";

const TEST_DB_PATH = "./test-slack-metadata-inheritance.sqlite";

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
    // ignore if files don't exist
  }
});

/** Helper to set a task to in_progress status (simulates runner picking it up) */
function setTaskInProgress(taskId: string): void {
  getDb().run(
    "UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [taskId],
  );
}

describe("Slack metadata auto-inheritance via sourceTaskId", () => {
  const lead = { name: "inherit-lead", isLead: true, status: "idle" as const, capabilities: [] };
  const worker = {
    name: "inherit-worker",
    isLead: false,
    status: "idle" as const,
    capabilities: [],
  };

  let leadAgent: ReturnType<typeof createAgent>;
  let workerAgent: ReturnType<typeof createAgent>;

  beforeAll(() => {
    leadAgent = createAgent(lead);
    workerAgent = createAgent(worker);
  });

  test("sourceTaskId provided → inherits from that task's Slack metadata", () => {
    // Lead has an in-progress task with Slack metadata
    const leadTask = createTaskExtended("lead task with slack", {
      agentId: leadAgent.id,
      slackChannelId: "C_SOURCE",
      slackThreadTs: "1000.0001",
      slackUserId: "U_TARAS",
    });
    setTaskInProgress(leadTask.id);

    // Create a child task using sourceTaskId
    const childTask = createTaskExtended("child task", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
    });

    expect(childTask.slackChannelId).toBe("C_SOURCE");
    expect(childTask.slackThreadTs).toBe("1000.0001");
    expect(childTask.slackUserId).toBe("U_TARAS");
  });

  test("sourceTaskId picks the correct task even with multiple in-progress tasks", () => {
    // Lead has TWO in-progress tasks with different Slack metadata
    const taskA = createTaskExtended("lead task A", {
      agentId: leadAgent.id,
      slackChannelId: "C_TASK_A",
      slackThreadTs: "2000.0001",
      slackUserId: "U_USER_A",
    });
    setTaskInProgress(taskA.id);

    const taskB = createTaskExtended("lead task B", {
      agentId: leadAgent.id,
      slackChannelId: "C_TASK_B",
      slackThreadTs: "3000.0001",
      slackUserId: "U_USER_B",
    });
    setTaskInProgress(taskB.id);

    // sourceTaskId = taskA → should inherit from A, not B (which is more recent)
    const childFromA = createTaskExtended("child from A", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: taskA.id,
    });

    expect(childFromA.slackChannelId).toBe("C_TASK_A");
    expect(childFromA.slackThreadTs).toBe("2000.0001");
    expect(childFromA.slackUserId).toBe("U_USER_A");
  });

  test("sourceTaskId not provided → no inheritance (no heuristic fallback)", () => {
    // Create a fresh agent to avoid interference from other tests
    const freshLead = createAgent({
      name: "fallback-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const leadTask = createTaskExtended("fallback lead task", {
      agentId: freshLead.id,
      slackChannelId: "C_FALLBACK",
      slackThreadTs: "4000.0001",
      slackUserId: "U_FALLBACK",
    });
    setTaskInProgress(leadTask.id);

    // No sourceTaskId → no inheritance (adapters must provide sourceTaskId deterministically)
    const childTask = createTaskExtended("child no sourceTaskId", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("explicit Slack params take priority over sourceTaskId inheritance", () => {
    const leadTask = createTaskExtended("lead explicit test", {
      agentId: leadAgent.id,
      slackChannelId: "C_LEAD_EXPLICIT",
      slackThreadTs: "5000.0001",
      slackUserId: "U_LEAD_EXPLICIT",
    });
    setTaskInProgress(leadTask.id);

    // Explicit params should override sourceTaskId inheritance
    const childTask = createTaskExtended("child explicit", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
      slackChannelId: "C_EXPLICIT",
      slackThreadTs: "6000.0001",
      slackUserId: "U_EXPLICIT",
    });

    expect(childTask.slackChannelId).toBe("C_EXPLICIT");
    expect(childTask.slackThreadTs).toBe("6000.0001");
    expect(childTask.slackUserId).toBe("U_EXPLICIT");
  });

  test("parentTaskId inheritance takes priority over sourceTaskId", () => {
    const parentTask = createTaskExtended("parent task", {
      agentId: workerAgent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "7000.0001",
      slackUserId: "U_PARENT",
    });

    const leadTask = createTaskExtended("lead with different slack", {
      agentId: leadAgent.id,
      slackChannelId: "C_LEAD_DIFFERENT",
      slackThreadTs: "8000.0001",
      slackUserId: "U_LEAD_DIFFERENT",
    });
    setTaskInProgress(leadTask.id);

    // parentTaskId sets Slack metadata first, so sourceTaskId doesn't override
    const childTask = createTaskExtended("child with parent", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
      parentTaskId: parentTask.id,
    });

    expect(childTask.slackChannelId).toBe("C_PARENT");
    expect(childTask.slackThreadTs).toBe("7000.0001");
    expect(childTask.slackUserId).toBe("U_PARENT");
  });

  test("no in-progress task and no sourceTaskId → no inheritance", () => {
    const freshLead = createAgent({
      name: "no-task-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // No tasks for this agent at all
    const childTask = createTaskExtended("orphan child", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("creator task has no Slack metadata → no inheritance", () => {
    const leadTask = createTaskExtended("lead task no slack", {
      agentId: leadAgent.id,
      // No Slack metadata on this task
    });
    setTaskInProgress(leadTask.id);

    const childTask = createTaskExtended("child no slack inherit", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("sourceTaskId pointing to non-existent task → no inheritance (no heuristic fallback)", () => {
    const freshLead = createAgent({
      name: "nonexist-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const leadTask = createTaskExtended("fallback task for nonexist", {
      agentId: freshLead.id,
      slackChannelId: "C_NONEXIST_FALLBACK",
      slackThreadTs: "9000.0001",
      slackUserId: "U_NONEXIST",
    });
    setTaskInProgress(leadTask.id);

    const childTask = createTaskExtended("child with bad sourceTaskId", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
      sourceTaskId: "00000000-0000-0000-0000-000000000000", // non-existent
    });

    // No fallback — sourceTaskId is the only path, and it points to a non-existent task
    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
  });
});
