import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionLogs } from "../../apps/ui/src/logs-parser";
import {
  closeDb,
  createSessionLogs,
  createTaskExtended,
  getSessionLogsByTaskId,
  initDb,
} from "../be/db";
import { createProviderAdapter } from "../providers";
import {
  ACPAdapter,
  applyConfiguredOptions,
  sanitizeAcpConfigOptions,
  toAcpMcpServers,
} from "../providers/acp-adapter";
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

  test("runs a configured ACP target and persists its sanitized diagnostic traffic", async () => {
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
    this.configured = {};
  }

  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(params) {
    if (!params.mcpServers.some((server) => server.name === "swarm" && server.type === "http")) {
      throw new Error("missing swarm MCP server");
    }
    await this.connection.sessionUpdate({
      sessionId: "acp-session-1",
      update: { sessionUpdate: "current_mode_update", currentModeId: "code" },
    });
    return {
      sessionId: "acp-session-1",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "default-model",
          options: [{ value: "fake-model", name: "Fake model" }],
        },
        {
          type: "select",
          id: "thought",
          name: "Thought level",
          currentValue: "low",
          options: [{ value: "high", name: "High" }],
        },
      ],
    };
  }

  async setSessionConfigOption(params) {
    this.configured[params.configId] = params.value;
    return {
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: this.configured.model ?? "default-model",
          options: [{ value: "fake-model", name: "Fake model" }],
        },
        {
          type: "select",
          id: "thought",
          name: "Thought level",
          currentValue: this.configured.thought ?? "low",
          options: [{ value: "high", name: "High" }],
        },
      ],
    };
  }

  async prompt(params) {
    if (this.configured.model !== "fake-model" || this.configured.thought !== "high") {
      throw new Error("config options were not applied before prompt");
    }
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
        messageId: "assistant-1",
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "x".repeat(31_000) },
        messageId: "user-1",
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Run command",
        kind: "execute",
        rawInput: {
          command: "true",
          headers: [
            { name: "Authorization", value: "Bearer opaque-vendor-credential-123456" },
            { name: "X-Debug", value: "kept" },
          ],
          diagnosticToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          chunks: Array.from({ length: 20 }, () => "y".repeat(2_000)),
        },
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Run command",
        status: "failed",
        rawOutput: { chunks: Array.from({ length: 20 }, () => "z".repeat(2_000)) },
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
          ACP_CONFIG_OPTIONS: JSON.stringify({ thought: "high" }),
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
    expect(events.find((event) => event.type === "session_init")).toMatchObject({
      providerMeta: {
        target: "custom",
        configOptions: [
          { id: "model", currentValue: "fake-model" },
          { id: "thought", currentValue: "high" },
        ],
      },
    });
    expect(events.some((event) => event.type === "message" && event.content === "done")).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(true);

    const rawLogs = events
      .filter(
        (event): event is Extract<ProviderEvent, { type: "raw_log" }> => event.type === "raw_log",
      )
      .map((event) => event.content);
    expect(rawLogs.length).toBeGreaterThan(0);
    expect(
      rawLogs.some((content) => {
        const event = JSON.parse(content) as Record<string, unknown>;
        const update = event.update as Record<string, unknown> | undefined;
        return update?.sessionUpdate === "agent_message_chunk";
      }),
    ).toBe(true);
    expect(
      rawLogs.some((content) => {
        const event = JSON.parse(content) as Record<string, unknown>;
        const update = event.update as Record<string, unknown> | undefined;
        return update?.sessionUpdate === "current_mode_update";
      }),
    ).toBe(true);
    expect(
      rawLogs.some((content) => {
        const event = JSON.parse(content) as Record<string, unknown>;
        return event.type === "message" && event.content === "done";
      }),
    ).toBe(true);
    expect(rawLogs.every((content) => content.length <= 30_000)).toBe(true);
    expect(rawLogs.join("\n")).not.toContain("Authorization");
    expect(rawLogs.join("\n")).not.toContain("opaque-vendor-credential-123456");
    expect(rawLogs.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(rawLogs.join("\n")).toContain("[REDACTED:github_token]");
    expect(rawLogs.join("\n")).toContain("… [truncated]");
    expect(rawLogs.join("\n")).not.toContain("x".repeat(30_001));

    initDb(":memory:");
    try {
      const task = await createTaskExtended("ACP persistence test");
      await createSessionLogs({
        taskId: task.id,
        sessionId: session.sessionId,
        iteration: 1,
        cli: "acp",
        lines: rawLogs,
      });
      const persisted = await getSessionLogsByTaskId(task.id);
      expect(persisted).toHaveLength(rawLogs.length);
      expect(persisted.map((entry) => entry.content)).toEqual(rawLogs);
      expect(persisted.every((entry) => entry.cli === "acp")).toBe(true);
      const transcript = normalizeSessionLogs(persisted);
      expect(transcript.items.some((item) => item.kind === "unknown")).toBe(false);
      expect(
        transcript.items.some(
          (item) => item.kind === "text" && item.role === "assistant" && item.text === "done",
        ),
      ).toBe(true);
      expect(
        transcript.items.some((item) => item.kind === "tool_call" && item.tool?.id === "tool-1"),
      ).toBe(true);
      expect(
        transcript.items.find((item) => item.kind === "tool_result" && item.result?.id === "tool-1")
          ?.result?.isError,
      ).toBe(true);
    } finally {
      closeDb();
    }
  });

  test("OpenCode preset supplies command, credentials, and a model environment fallback", () => {
    const target = resolveAcpTarget(
      baseConfig({
        model: "opencode/model",
        env: {
          PATH: "/bin",
          HOME: "/home/test",
          ACP_TARGET: "opencode",
          OPENAI_API_KEY: "test-key",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }),
        },
      }),
    );

    expect(target.command(baseConfig())).toEqual(["opencode", "acp"]);
    expect(
      target.env(
        baseConfig({
          model: "opencode/model",
          env: {
            PATH: "/bin",
            HOME: "/home/test",
            ACP_TARGET: "opencode",
            OPENAI_API_KEY: "test-key",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }),
          },
        }),
      ),
    ).toMatchObject({
      OPENAI_API_KEY: "test-key",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark", model: "opencode/model" }),
    });
  });

  test("custom target passes through only explicitly named env and supports a model env fallback", () => {
    const config = baseConfig({
      model: "custom-model",
      env: {
        PATH: "/bin",
        HOME: "/home/test",
        ACP_TARGET_COMMAND: "agent",
        ACP_TARGET_ENV_KEYS: JSON.stringify(["ALLOWED_TOKEN"]),
        ACP_MODEL_ENV_KEY: "AGENT_MODEL",
        ALLOWED_TOKEN: "allowed",
        BLOCKED_TOKEN: "blocked",
      },
    });
    const env = resolveAcpTarget(config).env(config);

    expect(env.ALLOWED_TOKEN).toBe("allowed");
    expect(env.BLOCKED_TOKEN).toBeUndefined();
    expect(env.AGENT_MODEL).toBe("custom-model");
  });

  test("configured options are nonfatal when absent or rejected", async () => {
    const advertised = [
      {
        type: "select" as const,
        id: "model",
        name: "Model",
        currentValue: "default",
        options: [{ value: "configured", name: "Configured" }],
      },
    ];
    const calls: string[] = [];
    const connection = {
      async setSessionConfigOption(params: { configId: string }) {
        calls.push(params.configId);
        throw new Error("unsupported value");
      },
    };

    expect(
      await applyConfiguredOptions(connection as never, "session-1", advertised, {
        missing: "value",
        model: "configured",
      }),
    ).toEqual(advertised);
    expect(calls).toEqual(["model"]);
  });

  test("sanitizes arbitrary ACP metadata before dashboard persistence", () => {
    expect(
      sanitizeAcpConfigOptions([
        {
          type: "boolean",
          id: "flag",
          name: "Flag",
          currentValue: true,
          _meta: { secret: "not persisted" },
        },
      ]),
    ).toEqual([{ type: "boolean", id: "flag", name: "Flag", currentValue: true }]);
  });

  test("toAcpMcpServers converts installed stdio and http/sse servers to ACP's array shape", () => {
    const servers = toAcpMcpServers({
      "installed-stdio": { command: "/usr/bin/foo", args: ["--flag"], env: { FOO: "bar" } },
      "installed-http": { type: "http", url: "https://example.com/mcp", headers: { X: "1" } },
      "installed-sse": { type: "sse", url: "https://example.com/sse", headers: {} },
    });

    expect(servers).toEqual([
      {
        name: "installed-stdio",
        command: "/usr/bin/foo",
        args: ["--flag"],
        env: [{ name: "FOO", value: "bar" }],
      },
      {
        type: "http",
        name: "installed-http",
        url: "https://example.com/mcp",
        headers: [{ name: "X", value: "1" }],
      },
      {
        type: "sse",
        name: "installed-sse",
        url: "https://example.com/sse",
        headers: [],
      },
    ]);
  });

  test("toAcpMcpServers skips entries with neither command nor url", () => {
    expect(toAcpMcpServers({ broken: { foo: "bar" } })).toEqual([]);
    expect(toAcpMcpServers(null)).toEqual([]);
  });
});
