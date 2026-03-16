import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getLeadAgent,
  getTaskById,
  initDb,
} from "../be/db";
import { buildCancelledBlocks, getTaskLink } from "../slack/blocks";

const TEST_DB_PATH = "./test-slack-actions.sqlite";

let leadAgent: ReturnType<typeof createAgent>;
let slackTask: ReturnType<typeof createTaskExtended>;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  leadAgent = createAgent({ name: "ActionLead", isLead: true, status: "idle" });
  slackTask = createTaskExtended("original task for actions test", {
    agentId: leadAgent.id,
    source: "slack",
    slackChannelId: "C_ACTIONS",
    slackThreadTs: "3333333333.000001",
    slackUserId: "U_ACTIONS",
  });
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

describe("follow_up_task action logic", () => {
  test("getTaskById retrieves the original task", () => {
    const task = getTaskById(slackTask.id);
    expect(task).toBeDefined();
    expect(task!.task).toBe("original task for actions test");
    expect(task!.slackChannelId).toBe("C_ACTIONS");
  });

  test("getLeadAgent returns the lead", () => {
    const lead = getLeadAgent();
    expect(lead).toBeDefined();
    expect(lead!.name).toBe("ActionLead");
  });

  test("creates follow-up task with parentTaskId and custom description", () => {
    const lead = getLeadAgent()!;
    const followUpTask = createTaskExtended("Please also check the logs", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: slackTask.id,
      slackChannelId: "C_ACTIONS",
      slackThreadTs: "3333333333.000001",
      slackUserId: "U_ACTIONS",
    });

    expect(followUpTask).toBeDefined();
    expect(followUpTask.task).toBe("Please also check the logs");
    expect(followUpTask.parentTaskId).toBe(slackTask.id);

    const fetched = getTaskById(followUpTask.id);
    expect(fetched).toBeDefined();
    expect(fetched!.parentTaskId).toBe(slackTask.id);
    expect(fetched!.slackChannelId).toBe("C_ACTIONS");
  });

  test("getTaskLink produces a link for the task", () => {
    const link = getTaskLink(slackTask.id);
    expect(link).toBeTruthy();
    expect(link).toContain(slackTask.id.slice(0, 8));
  });
});

describe("cancel_task action logic", () => {
  test("cancelTask returns task object for a pending task", () => {
    const agent = createAgent({ name: "CancelAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("task to cancel", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_CANCEL",
      slackThreadTs: "4444444444.000001",
      slackUserId: "U_CANCEL",
    });

    const result = cancelTask(task.id, "Cancelled via Slack");
    expect(result).toBeTruthy();

    // Verify task is now cancelled
    const fetched = getTaskById(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.status).toBe("cancelled");
  });

  test("cancelTask returns null for already-cancelled task", () => {
    const agent = createAgent({ name: "CompletedAgent", isLead: false, status: "idle" });
    const task = createTaskExtended("task to double-cancel", {
      agentId: agent.id,
      source: "slack",
      slackChannelId: "C_DONE",
      slackThreadTs: "5555555555.000001",
      slackUserId: "U_DONE",
    });

    // First cancel succeeds
    const first = cancelTask(task.id, "First cancel");
    expect(first).toBeTruthy();

    // Second cancel returns null — already in terminal state
    const second = cancelTask(task.id, "Second cancel");
    expect(second).toBeNull();
  });

  test("buildCancelledBlocks produces correct blocks for cancelled task", () => {
    const blocks = buildCancelledBlocks({
      agentName: "Alpha",
      taskId: slackTask.id,
    });

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Cancelled");
  });
});
