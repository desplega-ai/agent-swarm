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

  test("subscription prefixes preserve the openai row's declared effort levels", () => {
    const facts = { reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] };
    const catalog = { openai: { models: { "gpt-5.6-sol": facts } } };
    expect(isChatgptSubscriptionModel("OpenAI-Codex/gpt-5.6-sol")).toBe(true);
    for (const provider of ["openai", "openai-codex", "OpenAI-Codex"]) {
      expect(reasoningLevelsForModel("pi", `${provider}/gpt-5.6-sol`, catalog)).toEqual(["high"]);
    }
  });
});
