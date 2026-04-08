// Set env var BEFORE importing router — the flag is read at module level
process.env.SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION = "true";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { routeMessage } from "../slack/router";
import type { Agent } from "../types";

const TEST_DB_PATH = "./test-slack-router-require-mention.sqlite";

let leadAgent: Agent;
let workerAgent: Agent;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  leadAgent = createAgent({ name: "lead", isLead: true, status: "idle", capabilities: [] });
  workerAgent = createAgent({ name: "worker", isLead: false, status: "idle", capabilities: [] });
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

describe("SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION=true", () => {
  test("non-mention thread message returns no matches (silently dropped)", () => {
    const channelId = "C_REQ_MENTION_1";
    const threadTs = "1000.0001";

    createTaskExtended("active task", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage("just a follow-up comment", "BOT123", false, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(0);
  });

  test("@mention thread message still routes to working agent", () => {
    const channelId = "C_REQ_MENTION_2";
    const threadTs = "2000.0001";

    createTaskExtended("active task", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage("<@BOT123> please check this", "BOT123", true, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].agent.id).toBe(workerAgent.id);
    expect(matches[0].matchedText).toBe("thread follow-up");
  });

  test("explicit swarm#<uuid> still works without mention", () => {
    const channelId = "C_REQ_MENTION_3";
    const threadTs = "3000.0001";

    createTaskExtended("active task", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage(`swarm#${workerAgent.id} do this`, "BOT123", false, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].agent.id).toBe(workerAgent.id);
    expect(matches[0].matchedText).toBe(`swarm#${workerAgent.id}`);
  });

  test("@mention in thread with offline worker routes to lead", () => {
    const channelId = "C_REQ_MENTION_4";
    const threadTs = "4000.0001";

    const offlineWorker = createAgent({
      name: "offline-worker-rm",
      isLead: false,
      status: "offline",
      capabilities: [],
    });

    createTaskExtended("task for offline", {
      agentId: offlineWorker.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage("<@BOT123> follow up", "BOT123", true, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].agent.id).toBe(leadAgent.id);
    expect(matches[0].matchedText).toBe("thread follow-up (lead fallback)");
  });

  test("non-mention in thread with offline worker returns no matches", () => {
    const channelId = "C_REQ_MENTION_4"; // same thread as above
    const threadTs = "4000.0001";

    const matches = routeMessage("just chatting", "BOT123", false, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(0);
  });
});
