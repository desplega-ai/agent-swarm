import { describe, expect, test } from "bun:test";
import {
  computeAiSdkAgentCostUsd,
  resolveAiSdkAgentModel,
} from "../../providers/ai-sdk-agent-models";

describe("ai-sdk-agent model resolution", () => {
  test("maps claude shortnames to OpenAI models and strips openai/ prefix", () => {
    expect(resolveAiSdkAgentModel(undefined)).toBe("gpt-5.4");
    expect(resolveAiSdkAgentModel("fable")).toBe("gpt-5.5");
    expect(resolveAiSdkAgentModel("opus")).toBe("gpt-5.4");
    expect(resolveAiSdkAgentModel("sonnet")).toBe("gpt-5.4");
    expect(resolveAiSdkAgentModel("haiku")).toBe("gpt-5.4-mini");
    expect(resolveAiSdkAgentModel("openai/gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("computeAiSdkAgentCostUsd", () => {
  test("bills uncached input, cached input, and output", () => {
    const cost = computeAiSdkAgentCostUsd("gpt-5.4", 1_000_000, 200_000, 500_000);
    // 800k input @ $2.50 + 200k cached @ $0.25 + 500k output @ $15
    expect(cost).toBeCloseTo(9.55, 5);
  });

  test("unknown model returns zero", () => {
    expect(computeAiSdkAgentCostUsd("gpt-future-2027", 1_000, 0, 500)).toBe(0);
  });
});
