import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

  test("runs a configured ACP target through initialize, session/new, and session/prompt", async () => {
    const cwd = makeTempDir();
    const agentPath = join(cwd, "fake-acp-agent.ts");
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
    return { stopReason: "end_turn" };
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
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ACP_TARGET_COMMAND: "bun",
          ACP_TARGET_ARGS: JSON.stringify([agentPath]),
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
    expect(events.some((event) => event.type === "session_init")).toBe(true);
    expect(events.some((event) => event.type === "message" && event.content === "done")).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(true);
  });
});
