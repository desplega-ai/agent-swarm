import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviderCredentials } from "../commands/provider-credentials";
import { createProviderAdapter } from "../providers";
import { ACPAdapter } from "../providers/acp-adapter";
import { AcpTargetResolutionError, resolveAcpTarget } from "../providers/acp-targets";
import { writeClaudeMd } from "../providers/claude-md";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-swarm-acp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "hello",
    systemPrompt: "system",
    model: "fake-model",
    role: "worker",
    agentId: "agent-1",
    taskId: "task-1",
    apiUrl: "http://swarm.example",
    apiKey: "api-key",
    cwd: makeTempDir(),
    logFile: "/tmp/acp.log",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    ...overrides,
  };
}

describe("ACPAdapter", () => {
  test("is registered with MCP and local-environment traits", async () => {
    const adapter = await createProviderAdapter("acp");
    expect(adapter).toBeInstanceOf(ACPAdapter);
    expect(adapter.traits.hasMcp).toBe(true);
    expect(adapter.traits.hasLocalEnvironment).toBe(true);
  });

  test("fails clearly when no target is configured", () => {
    expect(() => resolveAcpTarget(baseConfig()).command(baseConfig())).toThrow(
      AcpTargetResolutionError,
    );
    expect(() => resolveAcpTarget(baseConfig()).command(baseConfig())).toThrow(
      "No ACP target configured",
    );
  });

  test("parses custom command, JSON args, ACP_ENV passthrough, cost provider, and system prompt artifact", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_COMMAND: "bun",
        ACP_ARGS: JSON.stringify(["fake-agent.ts", "--stdio"]),
        ACP_ENV_FAKE_TOKEN: "token-value",
        ACP_SYSTEM_PROMPT_ARTIFACT_PATH: "nested/system-prompt.txt",
        ACP_COST_PROVIDER: "codex",
      },
    });
    const target = resolveAcpTarget(config);

    expect(target.command(config)).toEqual(["bun", "fake-agent.ts", "--stdio"]);
    expect(target.env(config).FAKE_TOKEN).toBe("token-value");
    expect(target.costProvider(config)).toBe("codex");

    await target.writeSystemPromptArtifact(config);
    const artifactPath = join(cwd, "nested/system-prompt.txt");
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toBe("system");
  });

  test("supports explicit user-message system prompt fallback only when configured", () => {
    const fallbackConfig = baseConfig({
      env: { ACP_COMMAND: "bun", ACP_SYSTEM_PROMPT_FALLBACK: "user_message" },
    });
    expect(resolveAcpTarget(fallbackConfig).prompt(fallbackConfig)).toEqual([
      { type: "text", text: "system" },
      { type: "text", text: "hello" },
    ]);

    const defaultConfig = baseConfig({ env: { ACP_COMMAND: "bun" } });
    expect(resolveAcpTarget(defaultConfig).prompt(defaultConfig)).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  test("fails clearly for invalid JSON args and invalid cost provider", () => {
    const invalidArgsConfig = baseConfig({ env: { ACP_COMMAND: "bun", ACP_ARGS: "[not-json" } });
    expect(() => resolveAcpTarget(invalidArgsConfig).command(invalidArgsConfig)).toThrow(
      "Invalid ACP_ARGS JSON",
    );

    const invalidProviderConfig = baseConfig({
      env: { ACP_COMMAND: "bun", ACP_COST_PROVIDER: "unknown" },
    });
    expect(() =>
      resolveAcpTarget(invalidProviderConfig).costProvider(invalidProviderConfig),
    ).toThrow("Unsupported ACP_COST_PROVIDER");
  });

  test("resolves gemini-cli target with default ACP command, scoped env, and GEMINI.md", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      env: {
        PATH: "/bin",
        HOME: "/home/gemini",
        ACP_TARGET: "gemini-cli",
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_CLOUD_PROJECT: "project-1",
        ANTHROPIC_API_KEY: "not-for-gemini",
      },
    });

    const target = resolveAcpTarget(config);
    expect(target.target).toBe("gemini-cli");
    expect(target.command(config)).toEqual(["gemini", "--acp"]);
    expect(target.env(config)).toMatchObject({
      PATH: "/bin",
      HOME: "/home/gemini",
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_CLOUD_PROJECT: "project-1",
    });
    expect(target.env(config).ANTHROPIC_API_KEY).toBeUndefined();

    await target.writeSystemPromptArtifact(config);
    expect(await Bun.file(join(cwd, "GEMINI.md")).text()).toBe("system");
  });

  test("lets gemini-cli command, args, and prompt artifact path be overridden", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      env: {
        PATH: "/bin",
        HOME: "/home/gemini",
        ACP_TARGET: "gemini-cli",
        ACP_GEMINI_COMMAND: "/opt/bin/gemini",
        ACP_GEMINI_ARGS: JSON.stringify(["--acp", "--debug"]),
        ACP_GEMINI_SYSTEM_PROMPT_PATH: ".gemini/GEMINI.md",
      },
    });
    mkdirSync(join(cwd, ".gemini"));

    const target = resolveAcpTarget(config);
    expect(target.command(config)).toEqual(["/opt/bin/gemini", "--acp", "--debug"]);

    await target.writeSystemPromptArtifact(config);
    expect(await Bun.file(join(cwd, ".gemini/GEMINI.md")).text()).toBe("system");
  });

  test("resolves codex-acp with deterministic command, sanitized env, and AGENTS.md prompt", async () => {
    const cwd = makeTempDir();
    await Bun.write(join(cwd, "CLAUDE.md"), "# Repo instructions");
    const config = baseConfig({
      cwd,
      systemPrompt: "codex acp system",
      env: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        SECRET_THAT_MUST_NOT_LEAK: "nope",
        ACP_TARGET: "codex-acp",
        OPENAI_API_KEY: "sk-test",
        CODEX_OAUTH: "{}",
        codex_oauth_0: "pool-token",
      },
    });

    const target = resolveAcpTarget(config);

    expect(target.target).toBe("codex-acp");
    expect(target.command(config)).toEqual(["codex-acp"]);
    const env = target.env(config);
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "sk-test",
      CODEX_OAUTH: "{}",
      codex_oauth_0: "pool-token",
    });
    expect(env.SECRET_THAT_MUST_NOT_LEAK).toBeUndefined();

    await target.writeSystemPromptArtifact(config);
    const agentsMd = await Bun.file(join(cwd, "AGENTS.md")).text();
    expect(agentsMd).toContain("<swarm_system_prompt>");
    expect(agentsMd).toContain("codex acp system");
    expect(agentsMd).toContain("# Repo instructions");
  });

  test("codex-acp honors explicit ACP command overrides before the installed binary", () => {
    const config = baseConfig({
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "codex-acp",
        ACP_COMMAND: "bun",
        ACP_TARGET_ARGS: JSON.stringify(["fake-acp-agent.ts"]),
      },
    });

    expect(resolveAcpTarget(config).command(config)).toEqual(["bun", "fake-acp-agent.ts"]);
  });

  test("invalid custom config does NOT create system prompt artifact on disk", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      systemPrompt: "secret-system-prompt-that-should-not-leak",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_COMMAND: "bun",
        ACP_SYSTEM_PROMPT_ARTIFACT_PATH: "should-not-exist.txt",
        ACP_COST_PROVIDER: "totally-invalid-provider",
      },
    });
    const adapter = new ACPAdapter();
    await expect(adapter.createSession(config)).rejects.toThrow("Unsupported ACP_COST_PROVIDER");
    expect(existsSync(join(cwd, "should-not-exist.txt"))).toBe(false);
  });

  test("runs a configured ACP target through initialize, session/new, and session/prompt", async () => {
    const cwd = makeTempDir();
    const agentPath = join(cwd, "fake-acp-agent.ts");
    const promptLog = join(cwd, "prompt.json");
    const sdkPath = join(process.cwd(), "node_modules/@agentclientprotocol/sdk/dist/acp.js");
    await Bun.write(
      agentPath,
      `
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "${sdkPath}";

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
  }

  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(params) {
    if (!params.mcpServers.some((server) => server.name === "swarm" && server.type === "http")) {
      throw new Error("missing swarm MCP server");
    }
    return { sessionId: "acp-session-1" };
  }

  async prompt(params) {
    await Bun.write(process.env.PROMPT_LOG, JSON.stringify(params.prompt));
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 120,
        size: 1000,
        cost: { amount: 0.01, currency: "USD" },
        _meta: { outputTokens: 20 },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Run command",
        kind: "execute",
        rawInput: { command: "true" },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Run command",
        status: "completed",
        rawOutput: "ok",
      },
    });
    return {
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    };
  }

  async cancel() {}
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = ndJsonStream(input, output);
new AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
    );

    const adapter = new ACPAdapter();
    const session = await adapter.createSession(
      baseConfig({
        cwd,
        systemPrompt: "system from config",
        model: "gpt-5.5",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ACP_COMMAND: "bun",
          ACP_ARGS: JSON.stringify([agentPath]),
          ACP_ENV_PROMPT_LOG: promptLog,
          ACP_COST_PROVIDER: "codex",
          ACP_SYSTEM_PROMPT_FALLBACK: "user_message",
        },
      }),
    );

    const events: ProviderEvent[] = [];
    session.onEvent((event) => events.push(event));
    const result = await session.waitForCompletion();

    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "acp-session-1",
      output: "done",
      isError: false,
    });
    expect(result.cost).toMatchObject({
      provider: "codex",
      model: "gpt-5.5",
      inputTokens: 100,
      outputTokens: 20,
      totalCostUsd: 0.01,
    });
    expect(JSON.parse(readFileSync(promptLog, "utf8"))).toEqual([
      { type: "text", text: "system from config" },
      { type: "text", text: "hello" },
    ]);
    expect(events.some((event) => event.type === "session_init")).toBe(true);
    expect(events.some((event) => event.type === "raw_log")).toBe(true);
    expect(events.some((event) => event.type === "message" && event.content === "done")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "context_usage" &&
          event.contextUsedTokens === 120 &&
          event.contextPercent === 12,
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(true);
  });

  test("startup failures include scrubbed stderr tail", async () => {
    const cwd = makeTempDir();
    const agentPath = join(cwd, "bad-acp-agent.ts");
    await Bun.write(
      agentPath,
      `
console.error("initialize failed for sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa");
process.exit(1);
`,
    );

    const adapter = new ACPAdapter();
    await expect(
      adapter.createSession(
        baseConfig({
          cwd,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ACP_COMMAND: "bun",
            ACP_ARGS: JSON.stringify([agentPath]),
          },
        }),
      ),
    ).rejects.toThrow(/stderr tail: initialize failed for \[REDACTED:openai_proj_key\]/);
  });
});

describe("claude-agent-acp target", () => {
  test("resolves when ACP_TARGET=claude-agent-acp", () => {
    const profile = resolveAcpTarget(
      baseConfig({
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ACP_TARGET: "claude-agent-acp",
          ACP_TARGET_COMMAND: "/usr/bin/fake-claude-acp",
        },
      }),
    );
    expect(profile.target).toBe("claude-agent-acp");
  });

  test("command resolves explicit ACP_TARGET_COMMAND first", () => {
    const config = baseConfig({
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
        ACP_TARGET_COMMAND: "/usr/local/bin/my-claude-acp",
      },
    });
    const profile = resolveAcpTarget(config);
    expect(profile.command(config)).toEqual(["/usr/local/bin/my-claude-acp"]);
  });

  test("command with ACP_TARGET_ARGS splits correctly", () => {
    const config = baseConfig({
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
        ACP_TARGET_COMMAND: "/usr/bin/claude-acp",
        ACP_TARGET_ARGS: JSON.stringify(["--verbose", "--timeout", "30"]),
      },
    });
    const profile = resolveAcpTarget(config);
    expect(profile.command(config)).toEqual([
      "/usr/bin/claude-acp",
      "--verbose",
      "--timeout",
      "30",
    ]);
  });

  test("throws when binary not found and no explicit command", () => {
    const config = baseConfig({
      env: {
        PATH: "/nonexistent/path",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
      },
    });
    const profile = resolveAcpTarget(config);
    expect(() => profile.command(config)).toThrow(AcpTargetResolutionError);
    expect(() => profile.command(config)).toThrow("Could not resolve");
  });

  test("env passes through Claude credential env vars", () => {
    const config = baseConfig({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        ACP_TARGET: "claude-agent-acp",
        ANTHROPIC_API_KEY: "sk-ant-test",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok",
      },
    });
    const profile = resolveAcpTarget(config);
    const env = profile.env(config);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
  });

  test("writeSystemPromptArtifact writes CLAUDE.md with managed block", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      systemPrompt: "You are a helpful assistant.",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
      },
    });
    const profile = resolveAcpTarget(config);
    const handle = await profile.writeSystemPromptArtifact(config);
    const claudeMdPath = join(cwd, "CLAUDE.md");
    expect(existsSync(claudeMdPath)).toBe(true);
    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("<swarm_system_prompt>");
    expect(content).toContain("You are a helpful assistant.");
    expect(content).toContain("</swarm_system_prompt>");

    await handle.cleanup();
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  test("writeSystemPromptArtifact preserves existing CLAUDE.md content", async () => {
    const cwd = makeTempDir();
    await Bun.write(join(cwd, "CLAUDE.md"), "# Existing Repo Instructions\n\nDo things.");
    const config = baseConfig({
      cwd,
      systemPrompt: "Swarm prompt.",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
      },
    });
    const profile = resolveAcpTarget(config);
    const handle = await profile.writeSystemPromptArtifact(config);
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const content = readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("Swarm prompt.");
    expect(content).toContain("# Existing Repo Instructions");
    expect(content.indexOf("<swarm_system_prompt>")).toBeLessThan(
      content.indexOf("# Existing Repo Instructions"),
    );

    await handle.cleanup();
    const after = readFileSync(claudeMdPath, "utf-8");
    expect(after).not.toContain("<swarm_system_prompt>");
    expect(after).toContain("# Existing Repo Instructions");
  });

  test("writeSystemPromptArtifact skips when systemPrompt is empty", async () => {
    const cwd = makeTempDir();
    const config = baseConfig({
      cwd,
      systemPrompt: "",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ACP_TARGET: "claude-agent-acp",
      },
    });
    const profile = resolveAcpTarget(config);
    await profile.writeSystemPromptArtifact(config);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });

  test("unsupported target throws with descriptive error", () => {
    expect(() =>
      resolveAcpTarget(
        baseConfig({
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ACP_TARGET: "nonexistent-target",
          },
        }),
      ),
    ).toThrow(AcpTargetResolutionError);
    expect(() =>
      resolveAcpTarget(
        baseConfig({
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ACP_TARGET: "nonexistent-target",
          },
        }),
      ),
    ).toThrow("Unsupported ACP target");
  });
});

describe("ACP credential check for claude-agent-acp", () => {
  test("ready when ANTHROPIC_API_KEY is set", async () => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "claude-agent-acp",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("env");
  });

  test("ready when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "claude-agent-acp",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok",
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("env");
  });

  test("ready when CLAUDE_API_KEY is set", async () => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "claude-agent-acp",
      CLAUDE_API_KEY: "sk-claude",
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("env");
  });

  test("not ready when no Claude creds with claude-agent-acp target", async () => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "claude-agent-acp",
    });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("ANTHROPIC_API_KEY");
    expect(status.hint).toBeTruthy();
  });

  test("custom ACP target requires ACP_COMMAND to be ready", async () => {
    const notReady = await checkProviderCredentials("acp", {});
    expect(notReady.ready).toBe(false);
    expect(notReady.missing).toContain("ACP_COMMAND");
    expect(notReady.hint).toContain("ACP_COMMAND");

    const ready = await checkProviderCredentials("acp", {
      ACP_COMMAND: "/usr/local/bin/my-agent",
    });
    expect(ready.ready).toBe(true);
    expect(ready.satisfiedBy).toBe("env");
  });

  test("unknown ACP_TARGET is rejected at cred check", async () => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "unsupported-target",
    });
    expect(status.ready).toBe(false);
    expect(status.hint).toContain("unsupported-target");
  });
});

// ─── writeClaudeMd round-trip ─────────────────────────────────────────────────

describe("writeClaudeMd round-trip", () => {
  const tmpDir = `/tmp/claude-md-test-${process.pid}`;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Bun.$`rm -f ${tmpDir}/*`.quiet().nothrow();
  });

  test("no-op when systemPrompt is empty", async () => {
    const handle = await writeClaudeMd(tmpDir, "");
    expect(existsSync(join(tmpDir, "CLAUDE.md"))).toBe(false);
    await handle.cleanup();
    expect(existsSync(join(tmpDir, "CLAUDE.md"))).toBe(false);
  });

  test("no-op when cwd is falsy", async () => {
    const handle = await writeClaudeMd(undefined, "test prompt");
    await handle.cleanup();
    expect(true).toBe(true);
  });

  test("creates fresh CLAUDE.md when none exists", async () => {
    const dir = join(tmpDir, "fresh");
    mkdirSync(dir, { recursive: true });
    const claudeMd = join(dir, "CLAUDE.md");

    const handle = await writeClaudeMd(dir, "my prompt");
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, "utf8");
    expect(content).toContain("<swarm_system_prompt>");
    expect(content).toContain("my prompt");
    expect(content).toContain("</swarm_system_prompt>");

    await handle.cleanup();
    expect(existsSync(claudeMd)).toBe(false);
  });

  test("prepends block above existing CLAUDE.md content", async () => {
    const dir = join(tmpDir, "prepend");
    mkdirSync(dir, { recursive: true });
    const claudeMd = join(dir, "CLAUDE.md");
    await Bun.write(claudeMd, "# Project instructions\n\nDo things.");

    const handle = await writeClaudeMd(dir, "swarm prompt");
    const content = readFileSync(claudeMd, "utf8");
    expect(content.indexOf("<swarm_system_prompt>")).toBeLessThan(
      content.indexOf("# Project instructions"),
    );
    expect(content).toContain("swarm prompt");
    expect(content).toContain("# Project instructions");

    await handle.cleanup();
    const after = readFileSync(claudeMd, "utf8");
    expect(after).not.toContain("<swarm_system_prompt>");
    expect(after).toContain("# Project instructions");
  });

  test("replaces existing managed block in place", async () => {
    const dir = join(tmpDir, "replace");
    mkdirSync(dir, { recursive: true });
    const claudeMd = join(dir, "CLAUDE.md");
    await Bun.write(claudeMd, "<swarm_system_prompt>\nstale\n</swarm_system_prompt>\n\n# Keep me");

    const handle = await writeClaudeMd(dir, "fresh prompt");
    const updated = readFileSync(claudeMd, "utf8");
    expect(updated).toContain("fresh prompt");
    expect(updated).not.toContain("stale");
    expect(updated).toContain("# Keep me");

    await handle.cleanup();
    const after = readFileSync(claudeMd, "utf8");
    expect(after).not.toContain("<swarm_system_prompt>");
    expect(after).toContain("# Keep me");
  });
});
