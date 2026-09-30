import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { McpHttpClient, McpTool, McpToolCallResult } from "../mcp-client/http-client";
import {
  createPiResourceLoader,
  isCoreSwarmTool,
  isPiToolDeferralEnabled,
  mcpToolsToDefinitions,
  PiMonoAdapter,
  piDefaultToolAdditions,
  piExtensionFactories,
  SWARM_TOOL_NAMESPACE,
} from "../providers/pi-mono-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const inputSchema = { type: "object", properties: {} };

function tool(name: string, extra: Partial<McpTool> = {}): McpTool {
  return { name, description: `${name} tool`, inputSchema, ...extra };
}

function fakeClient(result: McpToolCallResult): McpHttpClient {
  return { callTool: async () => result } as unknown as McpHttpClient;
}

function execute(def: ToolDefinition) {
  return def.execute("call-1", {}, undefined, undefined, undefined as never);
}

function withEnv(key: string, value: string | undefined, fn: () => Promise<void> | void) {
  return async () => {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

describe("pi tool exposure mapping", () => {
  const tools = [
    tool("store-progress"),
    tool("create-page"),
    tool("slack-post", { _meta: { "anthropic/alwaysLoad": true } }),
  ];
  const client = fakeClient({ content: [] });

  test("deferral on: core and manifest-preloaded tools stay direct, the rest defer", () => {
    const defs = mcpToolsToDefinitions(client, tools, { deferNonCore: true });
    const exposure = Object.fromEntries(defs.map((d) => [d.name, d.exposure]));
    expect(exposure).toEqual({
      "store-progress": "direct",
      "create-page": "deferred",
      "slack-post": "direct",
    });
  });

  test("deferral off: no exposure is set, so pi declares every tool", () => {
    const defs = mcpToolsToDefinitions(client, tools);
    expect(defs.map((d) => d.exposure)).toEqual([undefined, undefined, undefined]);
  });

  test("core set follows CORE_TOOLS and alwaysLoad metadata only", () => {
    expect(isCoreSwarmTool(tool("store-progress"))).toBe(true);
    expect(isCoreSwarmTool(tool("create-page"))).toBe(false);
    expect(isCoreSwarmTool(tool("create-page", { _meta: { "anthropic/alwaysLoad": true } }))).toBe(
      true,
    );
    expect(isCoreSwarmTool(tool("create-page", { _meta: { "anthropic/alwaysLoad": false } }))).toBe(
      false,
    );
  });

  test("namespace is applied only when passed", () => {
    const [withNs] = mcpToolsToDefinitions(client, [tool("create-page")], {
      namespace: SWARM_TOOL_NAMESPACE,
    });
    const [withoutNs] = mcpToolsToDefinitions(client, [tool("create-page")]);
    expect(withNs?.namespace).toEqual({ name: "agent-swarm" });
    expect(withoutNs?.namespace).toBeUndefined();
  });
});

describe("pi structuredContent pass-through", () => {
  const outputSchema = {
    type: "object",
    properties: { success: { type: "boolean" }, details: {} },
    additionalProperties: true,
  };

  test("returns structuredContent next to the text and keeps the server outputSchema", async () => {
    const structuredContent = { success: true, message: "ok", details: { id: "t1" } };
    const [def] = mcpToolsToDefinitions(
      fakeClient({ content: [{ type: "text", text: "ok" }], structuredContent }),
      [tool("get-task-details", { outputSchema })],
    );
    expect(def?.outputSchema).toEqual(outputSchema);
    const result = await execute(def!);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.structuredContent).toEqual(structuredContent);
  });

  test("tools without structuredContent or outputSchema are unchanged", async () => {
    const [def] = mcpToolsToDefinitions(fakeClient({ content: [{ type: "text", text: "hi" }] }), [
      tool("legacy"),
    ]);
    expect(def?.outputSchema).toBeUndefined();
    const result = await execute(def!);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("isError still throws so pi reports the failure", async () => {
    const [def] = mcpToolsToDefinitions(
      fakeClient({
        content: [{ type: "text", text: "boom" }],
        structuredContent: { success: false },
        isError: true,
      }),
      [tool("store-progress", { outputSchema })],
    );
    await expect(execute(def!)).rejects.toThrow("boom");
  });
});

describe("pi extension factories and default tools per flag", () => {
  const swarm: ExtensionFactory = () => {};

  test("deferral off: only the swarm extension, no default-tool additions", () => {
    expect(piExtensionFactories(swarm, { toolDeferral: false })).toEqual([swarm]);
    expect(piDefaultToolAdditions({ toolDeferral: false })).toEqual([]);
  });

  test("deferral on: swarm extension plus tool_search", () => {
    const factories = piExtensionFactories(swarm, { toolDeferral: true });
    expect(factories).toHaveLength(2);
    expect(factories[0]).toBe(swarm);
    expect(piDefaultToolAdditions({ toolDeferral: true })).toEqual(["+tool_search"]);
  });
});

describe("pi resource loader trust", () => {
  test("task repo context files never reach the session; the server prompt does", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-loader-"));
    try {
      const cwd = join(root, "repo");
      const agentDir = join(root, "agent");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "ancestor instructions");
      writeFileSync(join(cwd, "AGENTS.md"), "repo instructions");
      writeFileSync(join(cwd, "CLAUDE.md"), "repo claude instructions");

      const { resourceLoader } = await createPiResourceLoader({
        cwd,
        agentDir,
        systemPrompt: "server prompt",
        extensionFactories: [() => {}],
      });

      expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(resourceLoader.getAppendSystemPrompt()).toEqual(["server prompt"]);
      expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PI_TOOL_DEFERRAL flag", () => {
  test("defaults off and parses boolean literals", () => {
    expect(isPiToolDeferralEnabled({})).toBe(false);
    expect(isPiToolDeferralEnabled({ PI_TOOL_DEFERRAL: "true" })).toBe(true);
    expect(isPiToolDeferralEnabled({ PI_TOOL_DEFERRAL: "1" })).toBe(true);
    expect(isPiToolDeferralEnabled({ PI_TOOL_DEFERRAL: "false" })).toBe(false);
  });

  test(
    "traits.hasToolSearch follows the flag live",
    withEnv("PI_TOOL_DEFERRAL", undefined, () => {
      const adapter = new PiMonoAdapter();
      expect(adapter.traits.hasToolSearch).toBe(false);
      process.env.PI_TOOL_DEFERRAL = "true";
      expect(adapter.traits.hasToolSearch).toBe(true);
    }),
  );
});

describe("PiMonoAdapter.createSession — tool deferral wiring", () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  function serveTools() {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          const body = (await req.json()) as { method?: string };
          const tools =
            body.method === "tools/list"
              ? [tool("store-progress"), tool("create-page"), tool("memory-search")]
              : undefined;
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-03-26", capabilities: {}, tools },
          });
        }
        return Response.json({ servers: [] });
      },
    });
  }

  async function captureSessionOptions(): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    spy = spyOn(piCodingAgent, "createAgentSession").mockImplementation((async (
      opts: Record<string, unknown>,
    ) => {
      captured = opts;
      return {
        session: {
          sessionId: "fake-session",
          isStreaming: false,
          model: undefined,
          subscribe: () => () => {},
          dispose: () => {},
        },
      };
    }) as typeof piCodingAgent.createAgentSession);
    const server = serveTools();
    try {
      const config: ProviderSessionConfig = {
        prompt: "hello",
        systemPrompt: "",
        model: "openrouter/google/gemini-3-flash-preview",
        role: "worker",
        agentId: "test-agent",
        taskId: "test-task",
        apiUrl: `http://localhost:${server.port}`,
        apiKey: "example-test-key",
        cwd: "/tmp",
        logFile: `/tmp/pi-deferral-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      };
      await new PiMonoAdapter().createSession(config);
    } finally {
      server.stop(true);
    }
    return captured;
  }

  test(
    "flag on: non-core tools deferred and tool_search enabled by default",
    withEnv("PI_TOOL_DEFERRAL", "true", async () => {
      const opts = await captureSessionOptions();
      const tools = opts.customTools as ToolDefinition[];
      expect(Object.fromEntries(tools.map((t) => [t.name, t.exposure]))).toEqual({
        "store-progress": "direct",
        "create-page": "deferred",
        "memory-search": "direct",
      });
      const settings = opts.settingsManager as piCodingAgent.SettingsManager;
      expect(settings.getDefaultTools()).toContain("tool_search");
    }),
  );

  test(
    "flag off: every tool declared and no tool_search",
    withEnv("PI_TOOL_DEFERRAL", undefined, async () => {
      const opts = await captureSessionOptions();
      const tools = opts.customTools as ToolDefinition[];
      expect(tools.map((t) => t.exposure)).toEqual([undefined, undefined, undefined]);
      const settings = opts.settingsManager as piCodingAgent.SettingsManager;
      expect(settings.getDefaultTools() ?? []).not.toContain("tool_search");
    }),
  );
});

describe("PiMonoAdapter.createSession — real pi session", () => {
  const envKeys = [
    "PI_TOOL_DEFERRAL",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let agentDir = "";

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    agentDir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.OPENROUTER_API_KEY = "example-test-key";
    // The session prompts on creation; keep that request off the network.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function realSession() {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/mcp") return Response.json({ servers: [] });
        const body = (await req.json()) as { id?: number; method?: string };
        const result =
          body.method === "tools/list"
            ? { tools: [tool("store-progress"), tool("create-page")] }
            : { protocolVersion: "2025-03-26", capabilities: {} };
        return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
      },
    });
    try {
      const session = await new PiMonoAdapter().createSession({
        prompt: "hello",
        systemPrompt: "SWARM-PROMPT-MARKER",
        model: "openrouter/google/gemini-3-flash-preview",
        role: "worker",
        agentId: "test-agent",
        taskId: "test-task",
        apiUrl: `http://localhost:${server.port}`,
        apiKey: "example-test-key",
        cwd: agentDir,
        logFile: join(agentDir, "session.log"),
      });
      return (session as unknown as { agentSession: piCodingAgent.AgentSession }).agentSession;
    } finally {
      server.stop(true);
    }
  }

  test("the swarm system prompt reaches the session", async () => {
    const session = await realSession();
    expect(session.systemPrompt).toContain("SWARM-PROMPT-MARKER");
    session.dispose();
  });

  test("extensions in the task repo's .pi/ never load into the worker", async () => {
    const marker = join(agentDir, "repo-extension-ran");
    mkdirSync(join(agentDir, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, ".pi", "extensions", "repo.ts"),
      `import { writeFileSync } from "node:fs";\nexport default () => writeFileSync(${JSON.stringify(marker)}, "1");\n`,
    );
    const session = await realSession();
    expect(session.systemPrompt).toContain("SWARM-PROMPT-MARKER");
    expect(existsSync(marker)).toBe(false);
    session.dispose();
  });

  test("deferral on: deferred tools stay undeclared until tool_search loads them", async () => {
    process.env.PI_TOOL_DEFERRAL = "true";
    const session = await realSession();
    expect(session.getActiveToolNames()).toContain("tool_search");
    expect(session.getActiveToolNames()).toContain("store-progress");
    expect(session.getActiveToolNames()).not.toContain("create-page");
    session.dispose();
  });
});
