import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkProviderCredentials,
  validateProviderCredentials,
} from "../commands/provider-credentials";
import { createProviderAdapter } from "../providers";
import {
  AMP_PACKAGE,
  AmpAdapter,
  buildAmpPlugin,
  checkAmpCredentials,
  liveTestAmpCredentials,
  parseAmpThreadUsage,
} from "../providers/amp-adapter";
import { applyReasoningEffort } from "../providers/reasoning-effort";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { ampModelError, resolveAmpModel } from "../utils/amp-models";
import { getModelAwareCredentialVars } from "../utils/credentials";
import { resolveHarnessProvider } from "../utils/harness-provider";
import { clearVolatileSecretsForTesting } from "../utils/secret-scrubber";

const KEY = "sgamp_test_credential_value";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A fake `amp` binary plus the config that points the adapter at it. */
async function fixture(
  mode = "success",
  overrides: Partial<ProviderSessionConfig> = {},
  extraEnv: Record<string, string> = {},
): Promise<{ config: ProviderSessionConfig; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "amp-adapter-test-"));
  directories.push(dir);
  const binary = join(dir, "amp");
  const source = await Bun.file(join(import.meta.dir, "fixtures", "fake-amp.ts")).text();
  await Bun.write(binary, `#!${process.execPath}\n${source}`);
  await chmod(binary, 0o700);
  return {
    dir,
    config: {
      prompt: "--not-a-flag\nKeep $() and `quotes` literal.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder must stay text
      systemPrompt: 'System instructions:\n"quoted" ${notInterpolated} */ and \u2028 stay text',
      model: "low",
      role: "worker",
      agentId: "agent-test",
      taskId: "0123456789abcdef-task",
      apiUrl: "http://swarm.invalid",
      apiKey: "swarm-api-key-value",
      cwd: dir,
      logFile: join(dir, "log.jsonl"),
      contextKey: "ctx-key",
      env: {
        AMP_BINARY: binary,
        AMP_API_KEY: KEY,
        AMP_TEST_MODE: mode,
        AMP_TEST_DIR: dir,
        ...extraEnv,
      },
      ...overrides,
    },
  };
}

async function runToCompletion(config: ProviderSessionConfig) {
  const session = await new AmpAdapter().createSession(config);
  const events: ProviderEvent[] = [];
  session.onEvent((event) => events.push(event));
  const result = await session.waitForCompletion();
  return { session, events, result };
}

/** The JSON literal the generated plugin reads its settings from. */
function pluginConfig(source: string): unknown {
  const line = source.split("\n").find((l) => l.startsWith("const CONFIG = "));
  return JSON.parse((line ?? "").slice("const CONFIG = ".length, -1));
}

/** Alive and not a zombie: a killed orphan waits to be reaped by init and still answers kill(pid, 0). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

async function invocation(dir: string) {
  return Bun.file(join(dir, "invocation.json")).json();
}

describe("amp registration and model selection", () => {
  test("registry, tiers, steering and credentials select amp", async () => {
    expect(await createProviderAdapter("amp")).toBeInstanceOf(AmpAdapter);
    expect(resolveHarnessProvider({ HARNESS_PROVIDER: "amp" }, {})).toBe("amp");
    expect(getModelAwareCredentialVars("amp", "low")).toEqual(["AMP_API_KEY"]);
    expect(checkAmpCredentials({}).ready).toBe(false);
    expect(checkAmpCredentials({}).missing).toEqual(["AMP_API_KEY"]);
    expect(checkAmpCredentials({ AMP_API_KEY: "  " }).ready).toBe(false);
    expect(checkAmpCredentials({ AMP_API_KEY: KEY })).toMatchObject({
      ready: true,
      satisfiedBy: "env",
    });
    expect((await checkProviderCredentials("amp", { AMP_API_KEY: KEY })).ready).toBe(true);
  });

  test("a tier resolves to a mode and a provider/model resolves to a pin", () => {
    // Every tier default must be a model amp accepts.
    for (const mode of Object.values(DEFAULT_MODEL_TIER_MAP.amp)) {
      expect(resolveAmpModel(mode)).toEqual({ model: mode, baseMode: mode });
    }
    expect(resolveAmpModel(undefined)).toEqual({ model: "medium", baseMode: "medium" });
    expect(resolveAmpModel(" LOW ")).toEqual({ model: "low", baseMode: "low" });
    expect(resolveAmpModel("openai/gpt-5-nano")).toEqual({
      model: "openai/gpt-5-nano",
      baseMode: "medium",
      pin: "openai/gpt-5-nano",
    });
    expect(resolveAmpModel("anthropic/claude-haiku-4-5-20251001").pin).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
  });

  test("anything else is rejected with the accepted forms, at send-task time too", async () => {
    for (const bad of ["sonnet", "gpt-5", "latest:anthropic/opus", "a b/c", "x/"]) {
      expect(() => resolveAmpModel(bad)).toThrow(/Use a mode \(low, medium, high, ultra\)/);
      expect(ampModelError(bad)).toContain("Unsupported amp model");
    }
    expect(ampModelError("medium")).toBeNull();
    expect(ampModelError("openai/gpt-5-nano")).toBeNull();
    const { explicitModelError } = await import("../be/model-validation");
    expect(await explicitModelError({ model: "high", harnessProvider: "amp" })).toBeNull();
    expect(await explicitModelError({ model: "sonnet", harnessProvider: "amp" })).toContain(
      "Unsupported amp model",
    );
  });

  test("effort is offered for a pinned provider/model, never for a mode", () => {
    expect(applyReasoningEffort("amp", "low", "high")).toEqual({ kind: "noop" });
    expect(applyReasoningEffort("amp", "openai/gpt-5-nano", undefined)).toEqual({ kind: "noop" });
    expect(applyReasoningEffort("amp", "openai/gpt-5-nano", "high")).toEqual({
      kind: "amp-effort",
      reasoningEffort: "high",
    });
    // Not a level the catalog gives gpt-5-nano.
    expect(applyReasoningEffort("amp", "openai/gpt-5-nano", "max")).toEqual({ kind: "noop" });
  });

  test("the image pins the same Amp version the adapter names", async () => {
    const dockerfile = await Bun.file(
      join(import.meta.dir, "..", "..", "Dockerfile.worker"),
    ).text();
    const version = dockerfile.match(/^ARG AMP_VERSION=(\S+)$/m)?.[1];
    expect(AMP_PACKAGE).toBe(`@ampcode/cli@${version}`);
    expect(dockerfile).toMatch(/^ARG AMP_SHA512_AMD64=[0-9a-f]{128}$/m);
    expect(dockerfile).toMatch(/^ARG AMP_SHA512_ARM64=[0-9a-f]{128}$/m);
  });
});

describe("amp plugin", () => {
  test("the plugin carries the prompt as data, so no prompt text can become code", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder must stay text
    const hostile = 'a"; process.exit(1); //\n`${x}` */ \u2028 \\';
    const source = buildAmpPlugin({ baseMode: "low", instructions: hostile });
    expect(source.startsWith("// @amp-agent-mode key=agent-swarm label=Agent Swarm\n")).toBe(true);
    expect(pluginConfig(source)).toEqual({
      baseMode: "low",
      instructions: hostile,
      model: null,
      reasoningEffort: null,
    });
    expect(source.split("\n").filter((line) => line.includes("process.exit"))).toHaveLength(1);
  });
});

describe("amp thread export", () => {
  test("splits cache creation by vendor and names the primary model and window", () => {
    const usage = parseAmpThreadUsage({
      messages: [
        { role: "user" },
        {
          role: "assistant",
          usage: {
            model: "claude-opus-5-5",
            inputTokens: 4,
            outputTokens: 5,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 1000,
            maxInputTokens: 872000,
            totalInputTokens: 1014,
          },
        },
        {
          role: "assistant",
          usage: {
            model: "gpt-5-nano-2025-08-07",
            inputTokens: 0,
            outputTokens: 7,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 500,
            maxInputTokens: 272000,
            totalInputTokens: 500,
          },
        },
        { role: "assistant" },
      ],
    });
    expect(usage?.models).toEqual([
      {
        model: "claude-opus-5-5",
        inputTokens: 4,
        outputTokens: 5,
        cacheReadTokens: 10,
        cacheWriteTokens: 1000,
      },
      {
        model: "gpt-5-nano-2025-08-07",
        // No cache-write rate exists off Anthropic, so these stay plain input.
        inputTokens: 500,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    expect(usage?.primaryModel).toBe("claude-opus-5-5");
    expect(usage?.contextWindow).toBe(272000);
    expect(usage?.contextUsedTokens).toBe(507);
    expect(parseAmpThreadUsage({ messages: [] })).toBeUndefined();
    expect(parseAmpThreadUsage(null)).toBeUndefined();
  });
});

describe("amp session", () => {
  test("spawns amp with the per-task plugin, settings and MCP config, and cleans up", async () => {
    const { config, dir } = await fixture();
    const { events, result } = await runToCompletion({ ...config, reasoningEffort: "high" });
    expect(result).toMatchObject({
      exitCode: 0,
      isError: false,
      output: "Done ✓",
      sessionId: "T-fake-session",
    });
    const run = await invocation(dir);
    expect(run.args).toEqual([
      "-x",
      "--stream-json",
      "--stream-json-input",
      "-m",
      "agent-swarm",
      "--title",
      "swarm task 01234567",
      "--settings-file",
      run.args[run.args.indexOf("--settings-file") + 1],
      "--mcp-config",
      run.args[run.args.indexOf("--mcp-config") + 1],
      "--plugin-ready-timeout",
      "30",
      "--visibility",
      "private",
      "--no-notifications",
      "--no-ide",
      "--no-color",
    ]);
    expect(existsSync(run.cwd)).toBe(true);
    // Secrets travel by environment and 0600 file, never on the command line.
    expect(JSON.stringify(run.args)).not.toContain(KEY);
    expect(JSON.stringify(run.args)).not.toContain("swarm-api-key-value");
    expect(run.env.AMP_API_KEY).toBe(KEY);
    expect(run.env.XDG_CONFIG_HOME).toContain("swarm-amp-");
    // Updates, commit trailers and notifications are off; prompts are off in the container sandbox.
    expect(JSON.parse(run.settings)).toMatchObject({
      "amp.updates.mode": "disabled",
      "amp.git.commit.coauthor.enabled": false,
      "amp.git.commit.ampThread.enabled": false,
      "amp.notifications.enabled": false,
      "amp.dangerouslyAllowAll": true,
    });
    expect(run.mcpMode).toBe("600");
    expect(JSON.parse(run.mcp)).toMatchObject({
      "agent-swarm": {
        url: "http://swarm.invalid/mcp",
        headers: {
          Authorization: "Bearer swarm-api-key-value",
          "X-Agent-ID": "agent-test",
          "X-Source-Task-Id": "0123456789abcdef-task",
          "X-Context-Key": "ctx-key",
        },
      },
    });
    // The system prompt rides on the plugin mode; a mode (low) pins no model.
    expect(run.plugin).toContain("// @amp-agent-mode key=agent-swarm label=Agent Swarm");
    expect(pluginConfig(run.plugin)).toEqual({
      baseMode: "low",
      instructions: config.systemPrompt,
      model: null,
      reasoningEffort: null,
    });
    // The per-task tree (config, plugin and the MCP file with the bearer) is gone.
    expect(existsSync(dirname(run.env.XDG_CONFIG_HOME))).toBe(false);
    expect(events).toContainEqual({
      type: "session_init",
      sessionId: "T-fake-session",
      provider: "amp",
    });
    expect(result.appliedReasoningEffort).toBeNull();
  });

  test("a pinned provider/model and its effort go to the plugin agent", async () => {
    const { config, dir } = await fixture("success", {
      model: "openai/gpt-5-nano",
      reasoningEffort: "high",
    });
    const { result } = await runToCompletion(config);
    expect(result.appliedReasoningEffort).toBe("high");
    const run = await invocation(dir);
    expect(pluginConfig(run.plugin)).toMatchObject({
      baseMode: "medium",
      model: "openai/gpt-5-nano",
      reasoningEffort: "high",
    });
  });

  test("a model Amp cannot run fails before any process starts", async () => {
    const { config, dir } = await fixture("success", { model: "sonnet" });
    await expect(new AmpAdapter().createSession(config)).rejects.toThrow(/Unsupported amp model/);
    expect(existsSync(join(dir, "invocation.json"))).toBe(false);
  });

  test("a missing key or binary fails with a clear error", async () => {
    const { config } = await fixture();
    await expect(
      new AmpAdapter().createSession({ ...config, env: { ...config.env, AMP_API_KEY: "" } }),
    ).rejects.toThrow("amp requires AMP_API_KEY");
    await expect(
      new AmpAdapter().createSession({
        ...config,
        env: { AMP_API_KEY: KEY, PATH: "/nonexistent", AMP_BINARY: "" },
      }),
    ).rejects.toThrow(/amp CLI not found/);
  });

  test("normalizes the stream and prices the usage from the export", async () => {
    const { config } = await fixture("tool");
    const { events, result } = await runToCompletion(config);
    expect(events).toContainEqual({
      type: "tool_start",
      toolCallId: "TU-1",
      toolName: "code_exec",
      args: { code: "1+1" },
    });
    expect(events).toContainEqual({
      type: "tool_end",
      toolCallId: "TU-1",
      toolName: "code_exec",
      result: "2",
    });
    expect(events).toContainEqual({ type: "message", role: "assistant", content: "Done ✓" });
    const contexts = events.filter((e) => e.type === "context_usage");
    // Per request, the window is unknown; the last snapshot, after the export, has it.
    expect(contexts[0]).toMatchObject({ contextUsedTokens: 1209, contextTotalTokens: null });
    expect(contexts.at(-1)).toMatchObject({
      contextUsedTokens: 1205,
      contextTotalTokens: 228928,
      contextFormula: "input-cache-output",
    });
    expect(result.cost).toMatchObject({
      provider: "amp",
      totalCostUsd: 0,
      model: "accounts/fireworks/models/glm-5p3-flash",
      numTurns: 1,
      durationMs: 1234,
      isError: false,
      inputTokens: 1000,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      models: [{ model: "accounts/fireworks/models/glm-5p3-flash", inputTokens: 1000 }],
    });
    expect(events.some((e) => e.type === "result")).toBe(true);
    const logged = events
      .filter((e): e is Extract<ProviderEvent, { type: "raw_log" }> => e.type === "raw_log")
      .map((e) => JSON.parse(e.content));
    // The stream names no model: the adapter logs what it asked for, then what Amp ran.
    expect(logged[0]).toMatchObject({ subtype: "model.selected", model: "low", mode: "low" });
    expect(logged.at(-1)).toMatchObject({
      subtype: "model.resolved",
      model: "accounts/fireworks/models/glm-5p3-flash",
    });
  });

  test("falls back to stream tokens and the configured model when the export fails", async () => {
    const { config } = await fixture("export-fail");
    const { result } = await runToCompletion(config);
    expect(result.isError).toBe(false);
    expect(result.cost).toMatchObject({
      model: "low",
      inputTokens: 4,
      outputTokens: 5,
      cacheReadTokens: 200,
      cacheWriteTokens: 1000,
    });
    expect(result.cost?.models).toBeUndefined();
  });

  test("fails the session when Amp starts without the swarm MCP server", async () => {
    const { config } = await fixture("mcp-fail");
    const { result, events } = await runToCompletion(config);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("amp could not connect to the swarm MCP server (failed)");
    expect(events).toContainEqual({ type: "error", message: result.failureReason as string });
  });

  test("a failed result and a bad key both fail the task with the reason", async () => {
    const failed = await runToCompletion((await fixture("error-result")).config);
    expect(failed.result).toMatchObject({
      isError: true,
      exitCode: 1,
      failureReason: "The model refused",
    });
    const badKey = await runToCompletion((await fixture("bad-key")).config);
    expect(badKey.result.isError).toBe(true);
    expect(badKey.result.failureReason).toContain("Invalid or missing API key");
  });

  test("a key split across stderr chunks is redacted in every event and the failure reason", async () => {
    const { config } = await fixture("stderr-split-key");
    const { events, result } = await runToCompletion(config);
    const stderr = events.flatMap((e) => (e.type === "raw_stderr" ? [e.content] : []));
    // The runner prints each raw_stderr and stores it as a session-log row; the
    // rows joined must not rebuild the key either.
    expect(stderr.join("")).toBe(
      "warning: key [REDACTED:AMP_API_KEY] rejected\nfatal: [REDACTED:AMP_API_KEY]",
    );
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("[REDACTED:AMP_API_KEY]");
    expect(result.failureReason).not.toContain(KEY);
  });

  test("queued steering runs after the turn, then input closes and late steering is refused", async () => {
    const { config } = await fixture("steer");
    const session = await new AmpAdapter().createSession(config);
    const events: ProviderEvent[] = [];
    session.onEvent((event) => events.push(event));
    // First turn is inside its 600ms tool call.
    await Bun.sleep(250);
    expect(await session.deliverSteering?.({ mode: "queue", text: "also say DONE2" })).toEqual({
      delivered: true,
      mode: "queue",
    });
    const result = await session.waitForCompletion();
    const texts = events.flatMap((e) => (e.type === "message" ? [e.content] : []));
    expect(texts).toEqual(["DONE1", "DONE2"]);
    expect(result).toMatchObject({ isError: false, output: "DONE2" });
    expect(result.cost?.numTurns).toBe(2);
    expect(await session.deliverSteering?.({ mode: "queue", text: "too late" })).toEqual({
      delivered: false,
      reason: "Amp is no longer reading input (the turn has ended)",
    });
  });

  test("abort stops amp and a command it started in its own session", async () => {
    if (process.platform !== "linux") return;
    const { config, dir } = await fixture("abort");
    const session = await new AmpAdapter().createSession(config);
    const done = session.waitForCompletion();
    const pidFile = join(dir, "child.pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const childPid = Number(await Bun.file(pidFile).text());
    expect(childPid).toBeGreaterThan(0);
    await session.abort();
    const result = await done;
    expect(result).toMatchObject({ isError: true, failureReason: "amp session aborted" });
    expect(result.exitCode).not.toBe(0);
    for (let i = 0; i < 100; i++) {
      if (!isRunning(childPid)) return;
      await Bun.sleep(50);
    }
    throw new Error(`the setsid child ${childPid} survived the abort`);
  }, 20_000);
});

describe("amp live test", () => {
  const env = async (mode: string) => {
    const { config } = await fixture(mode);
    return config.env as Record<string, string>;
  };

  test("a good key passes and the account output is never returned", async () => {
    const result = await liveTestAmpCredentials(await env("success"));
    expect(result).toEqual({ ok: true });
  });

  test("a bogus key fails with Amp's own message", async () => {
    const result = await liveTestAmpCredentials(await env("usage-bad-key"));
    expect(result).toEqual({
      ok: false,
      error: "Invalid or missing API key. Run 'amp login' to authenticate.",
    });
  });

  test("a key the probe sees only in its env is redacted from the error", async () => {
    // No session has registered this key, and it is not in process.env.
    clearVolatileSecretsForTesting();
    const key = `sgamp_probe_only_${crypto.randomUUID()}`;
    expect(Object.values(process.env)).not.toContain(key);
    const result = await liveTestAmpCredentials({
      ...(await env("usage-echo-key")),
      AMP_API_KEY: key,
    });
    expect(result).toEqual({ ok: false, error: "Rejected key [REDACTED:AMP_API_KEY]" });
  });

  test("a hung amp usage times out instead of hanging the worker", async () => {
    const started = Date.now();
    const result = await liveTestAmpCredentials(await env("usage-hang"), 300);
    expect(result).toEqual({ ok: false, error: "amp usage timed out after 300ms" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the dashboard test connection runs it, and a missing key is named", async () => {
    expect(await validateProviderCredentials("amp", await env("success"))).toMatchObject({
      ok: true,
    });
    expect(await validateProviderCredentials("amp", await env("usage-bad-key"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid or missing API key"),
    });
    expect(await validateProviderCredentials("amp", {})).toMatchObject({
      ok: false,
      error: "AMP_API_KEY is not set.",
    });
  });
});
