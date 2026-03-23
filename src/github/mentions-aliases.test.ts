/**
 * Alias tests for mentions.ts
 *
 * BOT_NAMES is computed once at module load time. In bun test, all test files
 * share the same process, so mentions.test.ts loads the module first (without
 * aliases). We use _resetBotNamesForTesting() to recompute from current env.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  _resetBotNamesForTesting,
  BOT_NAMES,
  detectMention,
  extractMentionContext,
  isBotAssignee,
} from "./mentions";

const originalAliases = process.env.GITHUB_BOT_ALIASES;

beforeAll(() => {
  process.env.GITHUB_BOT_ALIASES = "alias1,alias2";
  _resetBotNamesForTesting();
});

afterAll(() => {
  if (originalAliases === undefined) {
    delete process.env.GITHUB_BOT_ALIASES;
  } else {
    process.env.GITHUB_BOT_ALIASES = originalAliases;
  }
  _resetBotNamesForTesting();
});

describe("GITHUB_BOT_ALIASES support", () => {
  test("BOT_NAMES includes primary name and aliases", () => {
    expect(BOT_NAMES).toContain("agent-swarm-bot");
    expect(BOT_NAMES).toContain("alias1");
    expect(BOT_NAMES).toContain("alias2");
  });

  test("detectMention recognizes alias mentions", () => {
    expect(detectMention("@alias1 review this")).toBe(true);
    expect(detectMention("@alias2 please help")).toBe(true);
    expect(detectMention("Hey @alias1")).toBe(true);
  });

  test("detectMention is case-insensitive for aliases", () => {
    expect(detectMention("@ALIAS1 review")).toBe(true);
    expect(detectMention("@Alias2 help")).toBe(true);
  });

  test("detectMention still recognizes primary bot name", () => {
    expect(detectMention("@agent-swarm-bot review")).toBe(true);
  });

  test("isBotAssignee recognizes aliases", () => {
    expect(isBotAssignee("alias1")).toBe(true);
    expect(isBotAssignee("alias2")).toBe(true);
    expect(isBotAssignee("ALIAS1")).toBe(true);
  });

  test("isBotAssignee still recognizes primary bot name", () => {
    expect(isBotAssignee("agent-swarm-bot")).toBe(true);
  });

  test("isBotAssignee rejects unknown names", () => {
    expect(isBotAssignee("not-an-alias")).toBe(false);
  });

  test("extractMentionContext works with aliases", () => {
    expect(extractMentionContext("@alias1 review this PR")).toBe("review this PR");
    expect(extractMentionContext("Hey @alias2 help me")).toBe("Hey  help me");
  });
});
