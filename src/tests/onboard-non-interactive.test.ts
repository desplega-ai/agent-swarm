import { describe, expect, test } from "bun:test";
import { resolveNonInteractiveProvider } from "../commands/onboard/non-interactive.ts";

describe("resolveNonInteractiveProvider", () => {
  test("keeps Claude as the default and accepts OAuth", () => {
    const result = resolveNonInteractiveProvider({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect(result).toMatchObject({
      ok: true,
      state: { provider: "claude", harness: "claude", claudeOAuthToken: "oauth" },
    });
  });

  test("accepts a Claude Anthropic API key", () => {
    const result = resolveNonInteractiveProvider({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(result).toMatchObject({
      ok: true,
      state: {
        provider: "claude",
        harness: "claude",
        credentialType: "api_key",
        anthropicApiKey: "sk-ant",
      },
    });
  });

  test("detects OpenAI and maps it to codex", () => {
    const result = resolveNonInteractiveProvider({ OPENAI_API_KEY: "sk-openai" });
    expect(result).toMatchObject({
      ok: true,
      state: { provider: "openai", harness: "codex", openaiApiKey: "sk-openai" },
    });
  });

  test("detects OpenRouter, maps it to pi, and supplies the suggested model", () => {
    const result = resolveNonInteractiveProvider({ OPENROUTER_API_KEY: "sk-or" });
    expect(result).toMatchObject({
      ok: true,
      state: {
        provider: "openrouter",
        harness: "pi",
        openrouterApiKey: "sk-or",
        modelOverride: "openrouter/qwen/qwen3-coder-flash",
      },
    });
  });

  test("accepts Bedrock profile auth and normalizes the model prefix", () => {
    const result = resolveNonInteractiveProvider({
      HARNESS_PROVIDER: "bedrock",
      AWS_PROFILE: "swarm",
      AWS_REGION: "us-west-2",
      MODEL_OVERRIDE: "anthropic.claude-sonnet-4-20250514-v1:0",
    });
    expect(result).toMatchObject({
      ok: true,
      state: {
        provider: "bedrock",
        harness: "pi",
        awsProfile: "swarm",
        awsRegion: "us-west-2",
        modelOverride: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      },
    });
  });

  test("accepts generated pi/Bedrock configuration with access keys", () => {
    const result = resolveNonInteractiveProvider({
      HARNESS_PROVIDER: "pi",
      AWS_ACCESS_KEY_ID: "AKIA-test",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "eu-west-1",
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-3-haiku-20240307-v1:0",
    });
    expect(result).toMatchObject({
      ok: true,
      state: { provider: "bedrock", harness: "pi", awsAccessKeyId: "AKIA-test" },
    });
  });

  test("lists all accepted credential sets when none is configured", () => {
    const result = resolveNonInteractiveProvider({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.error).toContain("OPENAI_API_KEY");
    expect(result.error).toContain("OPENROUTER_API_KEY");
    expect(result.error).toContain("AWS_REGION");
  });
});
