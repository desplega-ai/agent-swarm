import { describe, expect, test } from "bun:test";
import { detectMention, extractMentionContext, GITHUB_BOT_NAME } from "./mentions";

describe("detectMention", () => {
  test("returns true for @bot mention", () => {
    expect(detectMention(`Hey @${GITHUB_BOT_NAME} please review this`)).toBe(true);
  });

  test("returns true for mention at start", () => {
    expect(detectMention(`@${GITHUB_BOT_NAME} review this PR`)).toBe(true);
  });

  test("returns true for mention at end", () => {
    expect(detectMention(`Please help @${GITHUB_BOT_NAME}`)).toBe(true);
  });

  test("returns true for mention alone", () => {
    expect(detectMention(`@${GITHUB_BOT_NAME}`)).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(detectMention("@Agent-Swarm-Bot help")).toBe(true);
    expect(detectMention("@AGENT-SWARM-BOT help")).toBe(true);
  });

  test("returns false for no mention", () => {
    expect(detectMention("Just a regular comment")).toBe(false);
  });

  test("returns false when followed by word characters", () => {
    expect(detectMention(`@${GITHUB_BOT_NAME}ting`)).toBe(false);
  });

  test("returns false for null or undefined", () => {
    expect(detectMention(null)).toBe(false);
    expect(detectMention(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(detectMention("")).toBe(false);
  });
});

describe("extractMentionContext", () => {
  test("removes mention and trims outer whitespace", () => {
    // Note: inner double spaces remain after removal
    expect(extractMentionContext(`Hey @${GITHUB_BOT_NAME} please review this`)).toBe(
      "Hey  please review this",
    );
  });

  test("handles mention at start", () => {
    expect(extractMentionContext(`@${GITHUB_BOT_NAME} review this PR`)).toBe("review this PR");
  });

  test("handles mention at end", () => {
    expect(extractMentionContext(`Please help @${GITHUB_BOT_NAME}`)).toBe("Please help");
  });

  test("handles mention alone", () => {
    expect(extractMentionContext(`@${GITHUB_BOT_NAME}`)).toBe("");
  });

  test("is case-insensitive", () => {
    expect(extractMentionContext("@AGENT-SWARM-BOT help me")).toBe("help me");
  });

  test("returns empty string for null or undefined", () => {
    expect(extractMentionContext(null)).toBe("");
    expect(extractMentionContext(undefined)).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(extractMentionContext("")).toBe("");
  });

  test("preserves text without mention", () => {
    expect(extractMentionContext("no mention here")).toBe("no mention here");
  });
});
