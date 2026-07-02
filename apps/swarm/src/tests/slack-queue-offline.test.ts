import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getLeadAgent,
  getTasksByAgentId,
  getTasksByStatus,
  initDb,
} from "../be/db";
import { extractTaskFromMessage, routeMessage } from "../slack/router";

const TEST_DB_PATH = "./test-slack-queue-offline.sqlite";

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

describe("Slack queue-when-offline", () => {
  describe("routeMessage returns empty when all agents are offline", () => {
    test("returns no matches when only offline agents exist", () => {
      createAgent({ name: "offline-worker", isLead: false, status: "offline", capabilities: [] });

      const matches = routeMessage("Hello <@BOT123>", "BOT123", true);
      expect(matches).toHaveLength(0);
    });

    test("returns no matches when offline lead exists", () => {
      createAgent({ name: "offline-lead", isLead: true, status: "offline", capabilities: [] });

      const matches = routeMessage("<@BOT123> do something", "BOT123", true);
      expect(matches).toHaveLength(0);
    });
  });

  describe("getLeadAgent finds lead regardless of status", () => {
    test("returns offline lead agent", () => {
      const lead = getLeadAgent();
      expect(lead).not.toBeNull();
      expect(lead!.isLead).toBe(true);
      // The lead we created above is offline — getLeadAgent should still find it
      expect(lead!.status).toBe("offline");
    });
  });

  describe("queue as task when offline lead exists", () => {
    test("creates task for offline lead with correct metadata", () => {
      const lead = getLeadAgent()!;
      const taskDescription = "deploy the new feature";

      const task = createTaskExtended(taskDescription, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: "C999",
        slackThreadTs: "1111.2222",
        slackUserId: "U_HUMAN",
      });

      expect(task.agentId).toBe(lead.id);
      expect(task.task).toBe(taskDescription);
      expect(task.source).toBe("slack");
      expect(task.slackChannelId).toBe("C999");
      expect(task.slackThreadTs).toBe("1111.2222");
      expect(task.slackUserId).toBe("U_HUMAN");
      expect(task.status).toBe("pending");
    });

    test("queued task appears in lead's task list", () => {
      const lead = getLeadAgent()!;
      const tasks = getTasksByAgentId(lead.id);
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      const queued = tasks.find((t) => t.task === "deploy the new feature");
      expect(queued).toBeDefined();
      expect(queued!.source).toBe("slack");
    });

    test("creates task with thread context", () => {
      const lead = getLeadAgent()!;
      const threadContext = "Alice: something is broken\n[Agent]: I'll look into it";
      const taskDescription = "check the logs";
      const fullTaskDescription = `<thread_context>\n${threadContext}\n</thread_context>\n\n${taskDescription}`;

      const task = createTaskExtended(fullTaskDescription, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: "C888",
        slackThreadTs: "3333.4444",
        slackUserId: "U_HUMAN2",
      });

      expect(task.task).toContain("<thread_context>");
      expect(task.task).toContain("check the logs");
      expect(task.task).toContain("Alice: something is broken");
    });
  });

  describe("queue as unassigned task when no lead exists at all", () => {
    test("creates unassigned task with Slack metadata", () => {
      const taskText = "fix the CI pipeline";

      const task = createTaskExtended(taskText, {
        source: "slack",
        slackChannelId: "C777",
        slackThreadTs: "5555.6666",
        slackUserId: "U_HUMAN3",
      });

      expect(task.task).toBe(taskText);
      expect(task.status).toBe("unassigned");
      expect(task.agentId).toBeNull();
      expect(task.source).toBe("slack");
      expect(task.slackChannelId).toBe("C777");
      expect(task.slackThreadTs).toBe("5555.6666");
      expect(task.slackUserId).toBe("U_HUMAN3");
    });

    test("unassigned task appears in unassigned status query", () => {
      const unassigned = getTasksByStatus("unassigned");
      const queued = unassigned.find((t) => t.task === "fix the CI pipeline");
      expect(queued).toBeDefined();
      expect(queued!.slackChannelId).toBe("C777");
    });

    test("creates task with thread context in fullTaskDescription format", () => {
      const threadContext = "Bob: deploy broke\n[Agent]: checking";
      const taskDescription = "investigate the deploy failure";
      const fullTaskDescription = `<thread_context>\n${threadContext}\n</thread_context>\n\n${taskDescription}`;

      const task = createTaskExtended(fullTaskDescription, {
        source: "slack",
        slackChannelId: "C666",
        slackThreadTs: "7777.8888",
        slackUserId: "U_HUMAN4",
      });

      expect(task.task).toContain("<thread_context>");
      expect(task.task).toContain("Bob: deploy broke");
      expect(task.task).toContain("investigate the deploy failure");
    });
  });

  describe("extractTaskFromMessage", () => {
    test("strips bot mention and returns task text", () => {
      const result = extractTaskFromMessage("<@BOT123> deploy the app", "BOT123");
      expect(result).toBe("deploy the app");
    });

    test("returns empty string for mention-only messages", () => {
      const result = extractTaskFromMessage("<@BOT123>", "BOT123");
      expect(result).toBe("");
    });

    test("strips swarm# references too", () => {
      const result = extractTaskFromMessage(
        "<@BOT123> swarm#all do something swarm#00000000-0000-0000-0000-000000000000",
        "BOT123",
      );
      expect(result).toBe("do something");
    });
  });
});
