/**
 * Alias tests for mentions.ts
 *
 * IMPORTANT: process.env.GITHUB_BOT_ALIASES must be set BEFORE importing
 * mentions.ts because BOT_NAMES is computed once at module load time via an IIFE.
 * ESM imports are hoisted, so we use dynamic import() to control evaluation order.
 * This is why these tests live in a separate file from mentions.test.ts.
 */

import { beforeAll, describe, expect, test } from "bun:test";

let detectMention: typeof import("./mentions").detectMention;
let extractMentionContext: typeof import("./mentions").extractMentionContext;
let isBotAssignee: typeof import("./mentions").isBotAssignee;
let BOT_NAMES: typeof import("./mentions").BOT_NAMES;

beforeAll(async () => {
  process.env.GITHUB_BOT_ALIASES = "alias1,alias2";
  const mod = await import("./mentions");
  detectMention = mod.detectMention;
  extractMentionContext = mod.extractMentionContext;
  isBotAssignee = mod.isBotAssignee;
  BOT_NAMES = mod.BOT_NAMES;
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
