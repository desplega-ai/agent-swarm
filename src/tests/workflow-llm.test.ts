import { describe, expect, test } from "bun:test";
import { resolveWorkflowLlmConfig } from "../workflows/executors/workflow-llm";

describe("resolveWorkflowLlmConfig", () => {
  test("routes OpenRouter credentials through the configured gateway", async () => {
    const config = await resolveWorkflowLlmConfig(undefined, {
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "https://gateway.example.test/v1",
    });

    expect(config).toEqual({
      apiKey: "sk-or-test",
      baseURL: "https://gateway.example.test/v1",
      model: "google/gemini-3-flash-preview",
    });
  });

  test("routes OpenAI credentials to the SDK default endpoint", async () => {
    const config = await resolveWorkflowLlmConfig(undefined, {
      OPENAI_API_KEY: "sk-openai-test",
    });

    expect(config).toEqual({
      apiKey: "sk-openai-test",
      baseURL: undefined,
      model: "gpt-5.4-mini",
    });
  });

  test("does not reuse the memory-rater model as a workflow default", async () => {
    const previous = process.env.MEMORY_RATER_MODEL;
    process.env.MEMORY_RATER_MODEL = "openrouter/anthropic/claude-sonnet-4-5";
    try {
      const config = await resolveWorkflowLlmConfig(undefined, {
        OPENAI_API_KEY: "sk-openai-test",
      });
      expect(config.model).toBe("gpt-5.4-mini");
    } finally {
      if (previous === undefined) delete process.env.MEMORY_RATER_MODEL;
      else process.env.MEMORY_RATER_MODEL = previous;
    }
  });

  test("preserves an explicit provider-compatible model", async () => {
    const config = await resolveWorkflowLlmConfig("openai/gpt-5.4", {
      OPENAI_API_KEY: "sk-openai-test",
    });

    expect(config.model).toBe("gpt-5.4");
  });

  test("rejects credential kinds without an OpenAI-compatible endpoint", async () => {
    await expect(
      resolveWorkflowLlmConfig(undefined, { ANTHROPIC_API_KEY: "sk-ant-test" }),
    ).rejects.toThrow("do not support the resolved anthropic credential yet");
  });
});
