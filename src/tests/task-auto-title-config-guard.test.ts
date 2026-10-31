import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";

describe("task auto-title config validation", () => {
  test("TASK_AUTO_TITLE_ENABLED accepts boolean literals only", () => {
    expect(validateConfigValue("TASK_AUTO_TITLE_ENABLED", "true")).toBeNull();
    expect(validateConfigValue("TASK_AUTO_TITLE_ENABLED", "false")).toBeNull();
    expect(validateConfigValue("TASK_AUTO_TITLE_ENABLED", "maybe")).toMatch(
      /TASK_AUTO_TITLE_ENABLED/,
    );
  });

  test("TASK_AUTO_TITLE_MODEL accepts provider/model-id for a callable provider, a claude alias, or empty", () => {
    for (const value of [
      "openrouter/deepseek/deepseek-v4.1-flash",
      "anthropic/claude-haiku-5-5",
      "openai/gpt-5-nano",
      "openai-codex/gpt-6-luna",
      "haiku",
      "",
      "  anthropic/claude-haiku-5-5  ",
    ]) {
      expect(validateConfigValue("TASK_AUTO_TITLE_MODEL", value)).toBeNull();
    }
  });

  test("TASK_AUTO_TITLE_MODEL rejects unsupported providers and malformed strings", () => {
    expect(validateConfigValue("TASK_AUTO_TITLE_MODEL", "google/gemini-2.5-flash-lite")).toMatch(
      /provider must be/,
    );
    expect(validateConfigValue("TASK_AUTO_TITLE_MODEL", "openai/")).toMatch(/provider\/model-id/);
    expect(validateConfigValue("TASK_AUTO_TITLE_MODEL", "openai/gpt 5")).toMatch(
      /provider\/model-id/,
    );
    expect(validateConfigValue("TASK_AUTO_TITLE_MODEL", 42)).toMatch(/must be a string/);
  });
});
