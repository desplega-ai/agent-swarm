/**
 * Tests for the assistant-surface co-mention guard.
 *
 * The guard in assistant.ts and handlers.ts prevents the swarm from spawning a
 * task when a Slack message arrives on the AI-App / assistant surface and
 * @-mentions a DIFFERENT agent (e.g. Devin) but NOT our bot.
 *
 * Regression for task 4ae1f3b5 — root message "<@U0831BS93V1> Are you here?"
 * (Devin) triggered an unwanted swarm task.
 */
import { describe, expect, test } from "bun:test";
import { hasOtherUserMention } from "../slack/router";

const BOT_USER_ID = "U0ASK3PCZ4P"; // our bot
const DEVIN_USER_ID = "U0831BS93V1"; // another agent
const HUMAN_USER_ID = "U037TJB7VHQ"; // a human

// ---------------------------------------------------------------------------
// hasOtherUserMention — the function powering both guards
// ---------------------------------------------------------------------------
describe("hasOtherUserMention — assistant surface scenarios", () => {
  test("returns true when message mentions only another agent (e.g. Devin)", () => {
    expect(hasOtherUserMention(`<@${DEVIN_USER_ID}> Are you here?`, BOT_USER_ID)).toBe(true);
  });

  test("returns true when message mentions a human (not our bot)", () => {
    expect(hasOtherUserMention(`<@${HUMAN_USER_ID}> what do you think?`, BOT_USER_ID)).toBe(true);
  });

  test("returns false when message mentions only our bot", () => {
    expect(hasOtherUserMention(`<@${BOT_USER_ID}> help me`, BOT_USER_ID)).toBe(false);
  });

  test("returns false when message has no @-mentions at all (plain DM)", () => {
    expect(hasOtherUserMention("Hello, what is the agent status?", BOT_USER_ID)).toBe(false);
  });

  test("returns true when message mentions both our bot AND another user", () => {
    // @-mentions both — hasOtherUserMention is true because Devin is mentioned.
    // The guard also checks !botMentioned, so this path goes through normally.
    expect(
      hasOtherUserMention(
        `<@${BOT_USER_ID}> <@${DEVIN_USER_ID}> what do you both think?`,
        BOT_USER_ID,
      ),
    ).toBe(true);
  });

  test("returns false for swarm#all text command (no @-mention)", () => {
    expect(hasOtherUserMention("swarm#all deploy staging", BOT_USER_ID)).toBe(false);
  });

  test("returns false for swarm#<uuid> text command (no @-mention)", () => {
    expect(
      hasOtherUserMention("swarm#5fd166b4-7d41-40ce-852f-9a3c2ea191a3 run task", BOT_USER_ID),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard condition — mirrors the logic in assistant.ts and handlers.ts
// The guard fires (suppresses task creation) when:
//   !botMentioned && hasOtherUserMention(text, botUserId)
// ---------------------------------------------------------------------------
describe("assistant surface guard condition", () => {
  function shouldSkip(text: string, botUserId: string): boolean {
    const botMentioned = text.includes(`<@${botUserId}>`);
    return !botMentioned && hasOtherUserMention(text, botUserId);
  }

  test("skips — message mentions only Devin (the Devin co-mention case)", () => {
    expect(shouldSkip(`<@${DEVIN_USER_ID}> Are you here?`, BOT_USER_ID)).toBe(true);
  });

  test("skips — message mentions a human user, not our bot", () => {
    expect(shouldSkip(`<@${HUMAN_USER_ID}> wdyt?`, BOT_USER_ID)).toBe(true);
  });

  test("does NOT skip — message mentions our bot (direct mention)", () => {
    expect(shouldSkip(`<@${BOT_USER_ID}> help me`, BOT_USER_ID)).toBe(false);
  });

  test("does NOT skip — plain DM with no @-mentions (normal assistant use)", () => {
    expect(shouldSkip("Show me the latest agent tasks", BOT_USER_ID)).toBe(false);
  });

  test("does NOT skip — message mentions our bot AND Devin (co-mention, bot included)", () => {
    // botMentioned=true → guard does NOT fire → task proceeds normally
    expect(
      shouldSkip(
        `<@${BOT_USER_ID}> and <@${DEVIN_USER_ID}> can you both look at this?`,
        BOT_USER_ID,
      ),
    ).toBe(false);
  });

  test("does NOT skip — swarm#all command (no @-mention)", () => {
    expect(shouldSkip("swarm#all run the deployment", BOT_USER_ID)).toBe(false);
  });

  test("does NOT skip — swarm#<uuid> command (no @-mention)", () => {
    expect(shouldSkip("swarm#5fd166b4-7d41-40ce-852f-9a3c2ea191a3 do the thing", BOT_USER_ID)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isImplicitMention guard — mirrors the logic added to handlers.ts line 494
// isImplicitMention = isAssistantThread && !botMentioned && !hasOtherUserMention(text, botUserId)
// ---------------------------------------------------------------------------
describe("isImplicitMention with co-mention guard (handlers.ts)", () => {
  function computeIsImplicitMention(
    isAssistantThread: boolean,
    text: string,
    botUserId: string,
  ): boolean {
    const botMentioned = text.includes(`<@${botUserId}>`);
    return isAssistantThread && !botMentioned && !hasOtherUserMention(text, botUserId);
  }

  test("false — not an assistant thread", () => {
    expect(computeIsImplicitMention(false, "Hello there", BOT_USER_ID)).toBe(false);
  });

  test("false — assistant thread but message mentions Devin only", () => {
    expect(computeIsImplicitMention(true, `<@${DEVIN_USER_ID}> are you here?`, BOT_USER_ID)).toBe(
      false,
    );
  });

  test("false — assistant thread, message mentions our bot (explicit mention)", () => {
    expect(computeIsImplicitMention(true, `<@${BOT_USER_ID}> help`, BOT_USER_ID)).toBe(false);
  });

  test("true — assistant thread, plain message with no @-mentions (normal DM use)", () => {
    expect(computeIsImplicitMention(true, "What are the active tasks?", BOT_USER_ID)).toBe(true);
  });
});
