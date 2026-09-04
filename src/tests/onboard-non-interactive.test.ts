import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMaxConcurrentTasks,
  resolveNonInteractiveProvider,
} from "../commands/onboard/non-interactive.ts";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc.ts";

const CLI_PATH = new URL("../cli.tsx", import.meta.url).pathname;

describe("non-interactive onboarding CLI", () => {
  test(
    "--yes without --preset errors before provisioning",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "onboard-no-preset-"));
      try {
        const result = await runChild(["bun", CLI_PATH, "onboard", "--yes"], {
          cwd: outputDir,
          env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth" },
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("--preset is required in non-interactive mode (--yes)");
        expect(result.stdout).toContain("full, dev, content, research, solo");
        expect(result.stdout).not.toContain("Preset: Full");
        expect(await readdir(outputDir)).toEqual([]);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "rejects an invalid CLI concurrency override before provisioning",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "onboard-invalid-concurrency-"));
      try {
        const result = await runChild(
          ["bun", CLI_PATH, "onboard", "--yes", "--preset=solo", "--max-concurrent-tasks=0"],
          {
            cwd: outputDir,
            env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth" },
          },
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain(
          "--max-concurrent-tasks must be an integer between 1 and 100",
        );
        expect(await readdir(outputDir)).toEqual([]);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "documents explicit unattended presets and conservative concurrency",
    async () => {
      const result = await runChild(["bun", CLI_PATH, "onboard", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("required with --yes");
      expect(result.stdout).toContain("onboard --yes --preset=full");
      expect(result.stdout).toContain("default: lead 2, worker 1");
      expect(result.stdout).not.toContain("default: full");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("parseMaxConcurrentTasks", () => {
  test("validates the explicit concurrency override", () => {
    expect(parseMaxConcurrentTasks(undefined)).toEqual({ ok: true, value: null });
    expect(parseMaxConcurrentTasks("4")).toEqual({ ok: true, value: 4 });
    expect(parseMaxConcurrentTasks("0")).toEqual({
      ok: false,
      error: "--max-concurrent-tasks must be an integer between 1 and 100",
    });
    expect(parseMaxConcurrentTasks("1.5").ok).toBe(false);
    expect(parseMaxConcurrentTasks("1e2").ok).toBe(false);
    expect(parseMaxConcurrentTasks("101").ok).toBe(false);
  });
});

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
