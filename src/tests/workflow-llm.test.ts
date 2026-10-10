import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL } from "../utils/internal-ai/models";
import { OPENROUTER_APP_ATTRIBUTION_HEADERS } from "../utils/openrouter-base-url";
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
      headers: {},
      model: "deepseek/deepseek-v4.1-flash",
    });
  });

  test("attributes direct openrouter.ai calls unless OPENROUTER_APP_ATTRIBUTION is off", async () => {
    const direct = await resolveWorkflowLlmConfig(undefined, { OPENROUTER_API_KEY: "sk-or-test" });
    expect(direct.headers).toEqual(OPENROUTER_APP_ATTRIBUTION_HEADERS);

    const optedOut = await resolveWorkflowLlmConfig(undefined, {
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_APP_ATTRIBUTION: "false",
    });
    expect(optedOut.headers).toEqual({});
  });

  test("routes OpenAI credentials to the SDK default endpoint", async () => {
    const config = await resolveWorkflowLlmConfig(undefined, {
      OPENAI_API_KEY: "example-sk-openai-test",
    });

    expect(config).toEqual({
      apiKey: "example-sk-openai-test",
      baseURL: undefined,
      headers: {},
      model: "gpt-6-luna",
    });
  });

  test("does not reuse the memory-rater model as a workflow default", async () => {
    const previous = process.env.MEMORY_RATER_MODEL;
    process.env.MEMORY_RATER_MODEL = "openrouter/anthropic/claude-sonnet-4-5";
    try {
      const config = await resolveWorkflowLlmConfig(undefined, {
        OPENAI_API_KEY: "example-sk-openai-test",
      });
      expect(config.model).toBe("gpt-6-luna");
    } finally {
      if (previous === undefined) delete process.env.MEMORY_RATER_MODEL;
      else process.env.MEMORY_RATER_MODEL = previous;
    }
  });

  test("still follows DEFAULT_MODEL, which the pinned rater default no longer tracks", async () => {
    const before = DEFAULT_MODEL.openrouter;
    try {
      DEFAULT_MODEL.openrouter = "openrouter/some/bumped-model";
      const config = await resolveWorkflowLlmConfig(undefined, {
        OPENROUTER_API_KEY: "sk-or-test",
      });
      expect(config.model).toBe("some/bumped-model");
    } finally {
      DEFAULT_MODEL.openrouter = before;
    }
  });

  test("preserves an explicit provider-compatible model", async () => {
    const config = await resolveWorkflowLlmConfig("openai/gpt-5.4", {
      OPENAI_API_KEY: "example-sk-openai-test",
    });

    expect(config.model).toBe("gpt-5.4");
  });

  test("rejects credential kinds without an OpenAI-compatible endpoint", async () => {
    await expect(
      resolveWorkflowLlmConfig(undefined, { ANTHROPIC_API_KEY: "example-sk-ant-test" }),
    ).rejects.toThrow("do not support the resolved anthropic credential yet");
  });
});
