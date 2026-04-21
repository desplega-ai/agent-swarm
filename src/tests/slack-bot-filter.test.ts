import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { isBotMessage } from "../slack/handlers";
import { hasOtherUserMention, routeMessage } from "../slack/router";
import type { Agent } from "../types";

const TEST_DB_PATH = "./test-slack-bot-filter.sqlite";

let leadAgent: Agent;
let workerAgent: Agent;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  leadAgent = createAgent({
    name: "filter-lead",
    isLead: true,
    status: "idle",
    capabilities: [],
  });
  workerAgent = createAgent({
    name: "filter-worker",
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
    // ignore
  }
});

describe("isBotMessage", () => {
  const BOT_ID = "UBOT123";

  test("plain human message → false", () => {
    expect(isBotMessage({ user: "UHUMAN" }, BOT_ID)).toBe(false);
  });

  test("subtype bot_message → true", () => {
    expect(isBotMessage({ subtype: "bot_message", user: "UHUMAN" }, BOT_ID)).toBe(true);
  });

  test("bot_id present → true", () => {
    expect(isBotMessage({ bot_id: "B001", user: "UHUMAN" }, BOT_ID)).toBe(true);
  });

  test("own bot user ID (self-posted) → true", () => {
    expect(isBotMessage({ user: BOT_ID }, BOT_ID)).toBe(true);
  });

  test("empty event with no bot signals → false", () => {
    expect(isBotMessage({ user: "UHUMAN" }, BOT_ID)).toBe(false);
  });
});

describe("hasOtherUserMention", () => {
  const BOT_ID = "UBOT123";

  test("no mentions → false", () => {
    expect(hasOtherUserMention("hello everyone", BOT_ID)).toBe(false);
  });

  test("only our bot mentioned → false", () => {
    expect(hasOtherUserMention(`hey <@${BOT_ID}> pls`, BOT_ID)).toBe(false);
  });

  test("different user mentioned → true", () => {
    expect(hasOtherUserMention("hey <@UDEVIN01> wdyt", BOT_ID)).toBe(true);
  });

  test("our bot AND another user mentioned → true", () => {
    expect(hasOtherUserMention(`<@${BOT_ID}> and <@UDEVIN01> hi`, BOT_ID)).toBe(true);
  });
});

describe("routeMessage — thread follow-up skips messages aimed at other users", () => {
  const BOT_ID = "UBOT123";

  test("plain follow-up (no mentions) still routes to active worker", () => {
    const channelId = "C_BF_100";
    const threadTs = "1100.0001";
    createTaskExtended("original", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage("and also the weather", BOT_ID, false, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].agent.id).toBe(workerAgent.id);
  });

  test("follow-up mentioning another bot (Devin) does NOT route", () => {
    const channelId = "C_BF_200";
    const threadTs = "1200.0001";
    createTaskExtended("original", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage("<@UDEVIN01> wdyt?", BOT_ID, false, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(0);
  });

  test("follow-up mentioning BOTH our bot and another bot routes to swarm", () => {
    const channelId = "C_BF_300";
    const threadTs = "1300.0001";
    createTaskExtended("original", {
      agentId: workerAgent.id,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      slackUserId: "U_HUMAN",
    });

    const matches = routeMessage(`<@${BOT_ID}> and <@UDEVIN01> please coordinate`, BOT_ID, true, {
      channelId,
      threadTs,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].agent.id).toBe(workerAgent.id);
  });

  test("no thread activity + only another bot mentioned → no match", () => {
    const matches = routeMessage("<@UDEVIN01> hi", BOT_ID, false, {
      channelId: "C_BF_400",
      threadTs: "1400.0001",
    });

    expect(matches).toHaveLength(0);
    // Silence unused lead warning — lead exists but should not be routed to
    expect(leadAgent.id).toBeDefined();
  });
});
