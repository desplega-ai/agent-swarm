import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSessionEnvironment,
  cleanupTaskFile,
  getTaskFilePath,
  runClaudeSessionSummary,
} from "../providers/claude-adapter";
import {
  buildClaudeSdkCommand,
  ClaudeInputQueue,
  resolveClaudeSdkExecutable,
  validateClaudeSdkAdditionalArgs,
} from "../providers/claude-sdk-session";
import { normalizeClaudeMessage } from "../providers/claude-session-events";
import type { ProviderSessionConfig } from "../providers/types";
import { isClaudeBridgeEffective, resolveClaudeTransport } from "../utils/claude-transport";

describe("Claude hook credential boundary", () => {
  test("does not mirror OAuth into the harness and preserves adapter summary credentials", async () => {
    for (const transport of ["cli", "sdk"]) {
      const sourceEnv = {
        CLAUDE_TRANSPORT: transport,
        CLAUDE_CODE_OAUTH_TOKEN: "fixture-selected-oauth",
        ANTHROPIC_API_KEY: "fixture-selected-api",
        AGENT_SWARM_CLAUDE_OAUTH_TOKEN: "fixture-stale-mirror",
      };
      const config = {
        taskId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        env: sourceEnv,
        apiUrl: "http://fixture.invalid",
        apiKey: "fixture-swarm-key",
      } as ProviderSessionConfig;
      const { env } = buildClaudeSessionEnvironment(
        config,
        "claude-haiku-4-5",
        "/tmp/fixture-task",
      );
      expect(env.AGENT_SWARM_CLAUDE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(sourceEnv.CLAUDE_CODE_OAUTH_TOKEN);
      expect(env.ANTHROPIC_API_KEY).toBe(sourceEnv.ANTHROPIC_API_KEY);
      expect(sourceEnv.AGENT_SWARM_CLAUDE_OAUTH_TOKEN).toBe("fixture-stale-mirror");
      let summaryEnv: NodeJS.ProcessEnv | undefined;
      await runClaudeSessionSummary(
        config,
        ["A completed task with durable evidence. ".repeat(5)],
        async (options) => {
          summaryEnv = options.env;
        },
      );
      expect(summaryEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe(sourceEnv.CLAUDE_CODE_OAUTH_TOKEN);
      expect(summaryEnv?.ANTHROPIC_API_KEY).toBe(sourceEnv.ANTHROPIC_API_KEY);
    }
  });
});

describe("Claude transport resolution", () => {
  test("uses the resolved overlay, then fallback, then CLI", () => {
    expect(resolveClaudeTransport({ CLAUDE_TRANSPORT: "sdk" }, { CLAUDE_TRANSPORT: "cli" })).toBe(
      "sdk",
    );
    expect(resolveClaudeTransport({}, { CLAUDE_TRANSPORT: "sdk" })).toBe("sdk");
    expect(resolveClaudeTransport({}, {})).toBe("cli");
  });

  test("rejects values outside the strict transport enum", () => {
    expect(() => resolveClaudeTransport({ CLAUDE_TRANSPORT: "SDK" }, {})).toThrow(
      /Expected 'cli' or 'sdk'/,
    );
  });

  test("preserves API-only bridge fallback and detects explicit bridge binaries", () => {
    expect(
      isClaudeBridgeEffective({ SWARM_USE_CLAUDE_BRIDGE: "true", ANTHROPIC_API_KEY: "api" }, {}),
    ).toBeFalse();
    expect(
      isClaudeBridgeEffective(
        { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
        {},
      ),
    ).toBeTrue();
    expect(isClaudeBridgeEffective({ CLAUDE_BINARY: "bunx claude-bridge" }, {})).toBeTrue();
    expect(isClaudeBridgeEffective({ CLAUDE_BINARY: "shannon" }, {})).toBeTrue();
  });

  test("an explicit empty OAuth overlay does not reuse fallback OAuth", () => {
    expect(
      isClaudeBridgeEffective(
        { SWARM_USE_CLAUDE_BRIDGE: "true", CLAUDE_CODE_OAUTH_TOKEN: "" },
        { CLAUDE_CODE_OAUTH_TOKEN: "fallback" },
      ),
    ).toBeFalse();
  });
});

describe("Claude SDK argument handling", () => {
  test("preserves wrapper prefixes and repeated arguments before final Swarm config", () => {
    expect(
      buildClaudeSdkCommand(
        { command: "/resolved/claude", args: ["--output-format", "stream-json"] },
        ["bunx", "wrapper"],
        ["--allowedTools", "Read", "--allowedTools", "Write"],
        ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"],
      ),
    ).toEqual([
      "bunx",
      "wrapper",
      "--output-format",
      "stream-json",
      "--allowedTools",
      "Read",
      "--allowedTools",
      "Write",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("preserves the SDK-selected interpreter for a script executable", () => {
    expect(
      buildClaudeSdkCommand(
        { command: "/usr/bin/bun", args: ["/opt/claude/cli.js", "--print"] },
        ["/opt/claude/cli.js"],
        ["--allowedTools", "Read"],
        ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"],
      ),
    ).toEqual([
      "/usr/bin/bun",
      "/opt/claude/cli.js",
      "--print",
      "--allowedTools",
      "Read",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("places script prefix arguments after the SDK script argv", () => {
    expect(
      buildClaudeSdkCommand(
        { command: "/usr/bin/bun", args: ["/opt/claude/cli.js", "--print"] },
        ["/opt/claude/cli.js", "--debug"],
        ["--allowedTools", "Read"],
        ["--mcp-config", "/tmp/mcp.json", "--strict-mcp-config"],
      ),
    ).toEqual([
      "/usr/bin/bun",
      "/opt/claude/cli.js",
      "--debug",
      "--print",
      "--allowedTools",
      "Read",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
    ]);
  });

  test("rejects arguments that can break the SDK protocol or Swarm config", () => {
    for (const args of [
      ["-p", "prompt"],
      ["--input-format=stream-json"],
      ["--resume", "session"],
      ["-r", "session"],
      ["-c"],
      ["--fork-session"],
      ["--resume-session-at", "message"],
      ["--mcp-config", "other.json"],
      ["--append-system-prompt-file=other.md"],
    ]) {
      expect(() => validateClaudeSdkAdditionalArgs(args)).toThrow(/does not accept/);
    }
    expect(() =>
      validateClaudeSdkAdditionalArgs(["--allowedTools", "Read", "--allowedTools", "Write"]),
    ).not.toThrow();
  });

  test("resolves the installed executable before passing it to the SDK", async () => {
    expect(resolveClaudeSdkExecutable(process.execPath)).toBe(process.execPath);
    expect(resolveClaudeSdkExecutable("bun", process.env.PATH)).toBe(
      Bun.which("bun", { PATH: process.env.PATH }),
    );
    expect(() => resolveClaudeSdkExecutable(`missing-${randomUUID()}`)).toThrow(/not found/);

    const directory = await mkdtemp(join(tmpdir(), "claude-sdk-path-"));
    const executableName = `claude-${randomUUID()}`;
    const executable = join(directory, executableName);
    try {
      await Bun.write(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      expect(resolveClaudeSdkExecutable(executableName, directory)).toBe(executable);
      expect(() => resolveClaudeSdkExecutable(executableName, "/usr/bin:/bin")).toThrow(
        /not found/,
      );
      expect(() => resolveClaudeSdkExecutable(executableName, "")).toThrow(/not found/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Claude SDK input queue", () => {
  test("acknowledges a queued message after the consumer requests the next item", async () => {
    const queue = new ClaudeInputQueue();
    const iterator = queue[Symbol.asyncIterator]();
    let accepted = false;
    const acceptance = queue.enqueue("first").then(() => {
      accepted = true;
    });
    expect((await iterator.next()).value?.message.content).toBe("first");
    expect(accepted).toBeFalse();
    const waiting = iterator.next();
    await acceptance;
    expect(accepted).toBeTrue();
    queue.close();
    expect((await waiting).done).toBeTrue();
  });

  test("rejects messages that have not been accepted when the queue closes", async () => {
    const queue = new ClaudeInputQueue();
    const pending = queue.enqueue("pending");
    queue.close("cancelled");
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("shared Claude event normalization", () => {
  test("marks transport metadata and maps SDK cost data", () => {
    const state = {
      taskId: "task",
      agentId: "agent",
      model: "claude-sonnet-4-5",
      contextWindowSize: 200_000,
      transport: "sdk" as const,
    };
    const init = normalizeClaudeMessage(
      { type: "system", subtype: "init", session_id: "session", model: state.model },
      state,
    );
    expect(init.events[0]).toMatchObject({
      type: "session_init",
      providerMeta: { transport: "sdk" },
    });

    const result = normalizeClaudeMessage(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.01,
        duration_ms: 25,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      state,
    );
    expect(result.cost).toMatchObject({
      provider: "claude",
      totalCostUsd: 0.01,
      inputTokens: 10,
      outputTokens: 3,
      isError: false,
    });
  });
});

describe("Claude task file isolation", () => {
  test("cleanup for one concurrent task leaves the other task file intact", async () => {
    const firstKey = `${process.pid}-${randomUUID()}`;
    const secondKey = `${process.pid}-${randomUUID()}`;
    const firstPath = getTaskFilePath(firstKey);
    const secondPath = getTaskFilePath(secondKey);
    await Bun.write(firstPath, "first");
    await Bun.write(secondPath, "second");
    try {
      await cleanupTaskFile(firstKey);
      expect(await Bun.file(firstPath).exists()).toBeFalse();
      expect(await Bun.file(secondPath).text()).toBe("second");
    } finally {
      await cleanupTaskFile(firstKey);
      await cleanupTaskFile(secondKey);
    }
  });
});
