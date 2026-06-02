import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderAdapter } from "../providers";
import { ACPAdapter } from "../providers/acp-adapter";
import { AcpTargetResolutionError, resolveAcpTarget } from "../providers/acp-targets";
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
