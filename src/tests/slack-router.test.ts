import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { routeMessage } from "../slack/router";
import type { Agent } from "../types";

const TEST_DB_PATH = "./test-slack-router.sqlite";

let leadAgent: Agent;
let workerAgent: Agent;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  leadAgent = createAgent({ name: "test-lead", isLead: true, status: "idle", capabilities: [] });
  workerAgent = createAgent({
    name: "test-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
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

describe("Slack router — thread follow-up routing", () => {
  describe("message in thread with active worker routes to worker", () => {
    test("routes to worker with in_progress task in thread", () => {
      const channelId = "C100";
      const threadTs = "1000.0001";

      // Create an in_progress task assigned to the worker in this thread
      createTaskExtended("original task", {
        agentId: workerAgent.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackUserId: "U_HUMAN",
      });

      const matches = routeMessage("<@BOT123> check the status", "BOT123", true, {
        channelId,
        threadTs,
      });

      expect(matches).toHaveLength(1);
      expect(matches[0].agent.id).toBe(workerAgent.id);
      expect(matches[0].matchedText).toBe("thread follow-up");
    });
  });

  describe("message in thread with no active worker falls through to lead", () => {
    test("routes to lead when no tasks exist in thread", () => {
      const matches = routeMessage("<@BOT123> do something", "BOT123", true, {
        channelId: "C200",
        threadTs: "2000.0001",
      });

      expect(matches).toHaveLength(1);
      expect(matches[0].agent.id).toBe(leadAgent.id);
      expect(matches[0].matchedText).toBe("@bot");
    });
  });

  describe("message in thread with offline worker falls through to lead", () => {
    test("routes to lead when worker is offline", () => {
      const channelId = "C300";
      const threadTs = "3000.0001";

      // Create an offline worker
      const offlineWorker = createAgent({
        name: "offline-worker",
        isLead: false,
        status: "offline",
        capabilities: [],
      });

      // Create an in_progress task assigned to the offline worker
      createTaskExtended("task for offline worker", {
        agentId: offlineWorker.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackUserId: "U_HUMAN",
      });

      const matches = routeMessage("<@BOT123> follow up", "BOT123", true, { channelId, threadTs });

      // Should route to lead via thread follow-up fallback (not generic @bot)
      expect(matches).toHaveLength(1);
      expect(matches[0].agent.id).toBe(leadAgent.id);
      expect(matches[0].matchedText).toBe("thread follow-up (lead fallback)");
    });
  });

  describe("thread follow-up does not override explicit swarm#<uuid>", () => {
    test("swarm#<uuid> takes priority over thread context", () => {
      const channelId = "C400";
      const threadTs = "4000.0001";

      // Create a second worker
      const worker2 = createAgent({
        name: "worker-2",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      // Worker 1 has an active task in this thread
      createTaskExtended("worker1 task", {
        agentId: workerAgent.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackUserId: "U_HUMAN",
      });

      // Message explicitly targets worker2 via swarm#<uuid>
      const matches = routeMessage(
        `<@BOT123> swarm#${worker2.id} do this instead`,
        "BOT123",
        true,
        { channelId, threadTs },
      );

      // Should route to worker2 (explicit), NOT worker1 (thread context)
      expect(matches).toHaveLength(1);
      expect(matches[0].agent.id).toBe(worker2.id);
      expect(matches[0].matchedText).toBe(`swarm#${worker2.id}`);
    });

    test("swarm#all takes priority over thread context", () => {
      const channelId = "C500";
      const threadTs = "5000.0001";

      // Worker has an active task in this thread
      createTaskExtended("worker task in thread", {
        agentId: workerAgent.id,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackUserId: "U_HUMAN",
      });

      const matches = routeMessage("<@BOT123> swarm#all deploy everything", "BOT123", true, {
        channelId,
        threadTs,
      });

      // Should broadcast to all non-lead workers, not just the thread worker
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches.every((m) => m.matchedText === "swarm#all")).toBe(true);
      // Lead should not be in the matches
      expect(matches.every((m) => !m.agent.isLead)).toBe(true);
    });
  });

  describe("no thread context behaves normally", () => {
    test("routes to lead when bot mentioned without thread context", () => {
      const matches = routeMessage("<@BOT123> hello", "BOT123", true);

      expect(matches).toHaveLength(1);
      expect(matches[0].agent.id).toBe(leadAgent.id);
      expect(matches[0].matchedText).toBe("@bot");
    });

    test("returns empty when bot not mentioned and no thread context", () => {
      const matches = routeMessage("hello everyone", "BOT123", false);

      expect(matches).toHaveLength(0);
    });
  });
});
