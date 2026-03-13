import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentWorkingOnThread,
  getLeadAgent,
  getTaskById,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-slack-assistant.sqlite";

let _leadAgent: ReturnType<typeof createAgent>;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  _leadAgent = createAgent({ name: "AssistantLead", isLead: true, status: "idle" });
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

describe("assistant userMessage routing — new thread (no working agent)", () => {
  test("getAgentWorkingOnThread returns null when no tasks exist for thread", () => {
    const result = getAgentWorkingOnThread("D_ASSISTANT", "6666666666.000001");
    expect(result).toBeNull();
  });

  test("getLeadAgent returns the lead agent for task assignment", () => {
    const lead = getLeadAgent();
    expect(lead).toBeDefined();
    expect(lead!.name).toBe("AssistantLead");
    expect(lead!.isLead).toBe(true);
  });

  test("creates task with slack context for new assistant thread message", () => {
    const lead = getLeadAgent()!;
    const task = createTaskExtended("What's the status of all agents?", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "D_ASSISTANT",
      slackThreadTs: "7777777777.000001",
      slackUserId: "U_ASSISTANT",
    });

    expect(task).toBeDefined();
    expect(task.task).toBe("What's the status of all agents?");
    expect(task.source).toBe("slack");

    const fetched = getTaskById(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.slackChannelId).toBe("D_ASSISTANT");
    expect(fetched!.slackThreadTs).toBe("7777777777.000001");
    expect(fetched!.slackUserId).toBe("U_ASSISTANT");
  });

  test("queues task without agentId when no lead is available", () => {
    // Create a task without agentId (simulates no lead scenario)
    const task = createTaskExtended("queued task, no lead", {
      source: "slack",
      slackChannelId: "D_NOHEAD",
      slackThreadTs: "8888888888.000001",
      slackUserId: "U_NOHEAD",
    });

    expect(task).toBeDefined();
    const fetched = getTaskById(task.id);
    expect(fetched).toBeDefined();
    // Task should be created but unassigned (pending or similar status)
    expect(fetched!.agentId).toBeNull();
  });
});

describe("assistant userMessage routing — follow-up (working agent exists)", () => {
  test("getAgentWorkingOnThread returns the agent working on an active thread task", () => {
    const worker = createAgent({ name: "ThreadWorker", isLead: false, status: "idle" });
    createTaskExtended("initial task in thread", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "D_FOLLOWUP",
      slackThreadTs: "9999999999.000001",
      slackUserId: "U_FOLLOWUP",
    });

    const result = getAgentWorkingOnThread("D_FOLLOWUP", "9999999999.000001");
    expect(result).toBeDefined();
    expect(result!.name).toBe("ThreadWorker");
  });

  test("creates follow-up task assigned to the working agent", () => {
    const workingAgent = getAgentWorkingOnThread("D_FOLLOWUP", "9999999999.000001");
    expect(workingAgent).toBeDefined();

    const followUp = createTaskExtended("follow-up message in assistant thread", {
      agentId: workingAgent!.id,
      source: "slack",
      slackChannelId: "D_FOLLOWUP",
      slackThreadTs: "9999999999.000001",
      slackUserId: "U_FOLLOWUP",
    });

    expect(followUp).toBeDefined();
    expect(followUp.agentId).toBe(workingAgent!.id);

    const fetched = getTaskById(followUp.id);
    expect(fetched).toBeDefined();
    expect(fetched!.slackChannelId).toBe("D_FOLLOWUP");
    expect(fetched!.slackThreadTs).toBe("9999999999.000001");
  });
});

describe("assistant thread title truncation", () => {
  test("short messages stay as-is", () => {
    const text = "Check agent status";
    const title = text.length > 50 ? `${text.slice(0, 47)}...` : text;
    expect(title).toBe("Check agent status");
  });

  test("long messages get truncated to 50 chars", () => {
    const text =
      "This is a very long message that definitely exceeds the fifty character limit for thread titles";
    const title = text.length > 50 ? `${text.slice(0, 47)}...` : text;
    expect(title).toBe("This is a very long message that definitely exc...");
    expect(title.length).toBe(50);
  });
});
