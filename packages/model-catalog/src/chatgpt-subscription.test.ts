import { describe, expect, test } from "bun:test";
import { chatgptSubscriptionModelId, isChatgptSubscriptionModel } from "./chatgpt-subscription.ts";
import { reasoningLevelsForModel } from "./reasoning.ts";

describe("chatgptSubscriptionModelId", () => {
  test("returns the bare OpenAI id of an openai-codex/<id> model", () => {
    expect(chatgptSubscriptionModelId("openai-codex/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(chatgptSubscriptionModelId(" openai-codex/gpt-6-sol ")).toBe("gpt-6-sol");
  });

  test("anything else is not a subscription model", () => {
    for (const model of [
      "gpt-5.6-sol",
      "openai/gpt-5.6-sol",
      "openai-codex/",
      "openai-codex/a/b",
      "",
      null,
    ]) {
      expect(isChatgptSubscriptionModel(model)).toBe(false);
    }
  });

  test("effort levels come from the openai catalog row", () => {
    const catalog = { openai: { models: { "gpt-5.6-sol": { reasoning: true } } } };
    expect(reasoningLevelsForModel("pi", "openai-codex/gpt-5.6-sol", catalog)).toEqual(
      reasoningLevelsForModel("pi", "openai/gpt-5.6-sol", catalog),
    );
    expect(
      reasoningLevelsForModel("pi", "openai-codex/gpt-5.6-sol", catalog).length,
    ).toBeGreaterThan(0);
  });

  test("a mixed-case prefix keeps the openai effort levels", () => {
    const catalog = { openai: { models: { "gpt-5.6-sol": { reasoning: true } } } };
    expect(isChatgptSubscriptionModel("OpenAI-Codex/gpt-5.6-sol")).toBe(true);
    expect(reasoningLevelsForModel("pi", "OpenAI-Codex/gpt-5.6-sol", catalog)).toEqual(
      reasoningLevelsForModel("pi", "openai/gpt-5.6-sol", catalog),
    );
  });
});
