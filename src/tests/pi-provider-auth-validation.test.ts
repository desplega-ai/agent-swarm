import { describe, expect, test } from "bun:test";
import { validatePiAuthForModel } from "../commands/providers/pi-config.ts";

describe("validatePiAuthForModel", () => {
  test("throws deterministic error when openrouter key is missing", () => {
    expect(() => {
      validatePiAuthForModel("openrouter/openai/gpt-oss-120b", {});
    }).toThrow(/OPENROUTER_API_KEY/);
  });

  test("throws deterministic error when anthropic key is missing", () => {
    expect(() => {
      validatePiAuthForModel("opus", {});
    }).toThrow(/ANTHROPIC_API_KEY/);
  });

  test("passes when required key is present", () => {
    expect(() => {
      validatePiAuthForModel("openrouter/openai/gpt-oss-120b", {
        OPENROUTER_API_KEY: "test-key",
      });
    }).not.toThrow();
  });
});
