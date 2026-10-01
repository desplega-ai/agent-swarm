import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { validateConfigValue } from "../be/swarm-config-guard";
import {
  type CodemodeLimits,
  createBoundedCodemodeExtension,
  isPiCodemodeEnabled,
  isPiCodemodeModelsEnabled,
  PiMonoAdapter,
  piDefaultToolAdditions,
  piExtensionFactories,
} from "../providers/pi-mono-adapter";

describe("PI_CODEMODE flag", () => {
  test("off by default and for false values", () => {
    expect(isPiCodemodeEnabled({})).toBe(false);
    expect(isPiCodemodeEnabled({ PI_CODEMODE: "false" })).toBe(false);
  });

  test("on when true", () => {
    expect(isPiCodemodeEnabled({ PI_CODEMODE: "true" })).toBe(true);
  });
});

describe("PI_CODEMODE_MODELS flag", () => {
  test("off by default and for false values", () => {
    expect(isPiCodemodeModelsEnabled({ PI_CODEMODE: "true" })).toBe(false);
    expect(isPiCodemodeModelsEnabled({ PI_CODEMODE: "true", PI_CODEMODE_MODELS: "false" })).toBe(
      false,
    );
  });

  test("on only with codemode on", () => {
    expect(isPiCodemodeModelsEnabled({ PI_CODEMODE: "true", PI_CODEMODE_MODELS: "true" })).toBe(
      true,
    );
    expect(isPiCodemodeModelsEnabled({ PI_CODEMODE_MODELS: "true" })).toBe(false);
    expect(isPiCodemodeModelsEnabled({ PI_CODEMODE: "false", PI_CODEMODE_MODELS: "true" })).toBe(
      false,
    );
  });
});

describe("pi pilot flags — config validation", () => {
  test.each([
    "PI_TOOL_DEFERRAL",
    "PI_CODEMODE",
    "PI_CODEMODE_MODELS",
  ])("%s accepts boolean literals and rejects anything else", (key) => {
    expect(validateConfigValue(key, "true")).toBeNull();
    expect(validateConfigValue(key, "false")).toBeNull();
    expect(validateConfigValue(key, "maybe")).toContain(`Invalid ${key}`);
  });
});

describe("pi extension factories and default tools — codemode", () => {
  const swarm: ExtensionFactory = () => {};

  test("codemode adds its extension and +codemode", () => {
    expect(piExtensionFactories(swarm, { toolDeferral: false, codemode: true })).toHaveLength(2);
    expect(piDefaultToolAdditions({ toolDeferral: false, codemode: true })).toEqual(["+codemode"]);
  });

  test("codemode models adds no extension or default tool of its own", () => {
    const features = { toolDeferral: false, codemode: true, codemodeModels: true };
    expect(piExtensionFactories(swarm, features)).toHaveLength(2);
    expect(piDefaultToolAdditions(features)).toEqual(["+codemode"]);
  });

  test("all features together", () => {
    const features = { toolDeferral: true, installedMcp: true, codemode: true };
    expect(piExtensionFactories(swarm, features)).toHaveLength(4);
    expect(piDefaultToolAdditions(features)).toEqual(["+tool_search", "+codemode"]);
  });
});

describe("PiMonoAdapter.createSession — codemode", () => {
  const envKeys = [
    "PI_CODEMODE",
    "PI_CODEMODE_MODELS",
    "PI_TOOL_DEFERRAL",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "pi-codemode-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.OPENROUTER_API_KEY = "example-test-key";
    // The session prompts on creation; keep that request off the network.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    delete process.env.PI_CODEMODE;
    delete process.env.PI_CODEMODE_MODELS;
    delete process.env.PI_TOOL_DEFERRAL;
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function sessionTools(): Promise<{ active: string[]; codemodeDescription: string }> {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/mcp") return Response.json({ servers: [] });
        const body = (await req.json()) as { id?: number; method?: string };
        const result =
          body.method === "tools/list"
            ? {
                tools: [
                  { name: "store-progress", inputSchema: { type: "object" } },
                  { name: "create-page", inputSchema: { type: "object" } },
                ],
              }
            : { protocolVersion: "2025-03-26", capabilities: {} };
        return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
      },
    });
    let session: AgentSession | undefined;
    try {
      const provider = await new PiMonoAdapter().createSession({
        prompt: "hello",
        systemPrompt: "",
        model: "openrouter/google/gemini-3-flash-preview",
        role: "worker",
        agentId: "test-agent",
        taskId: "test-task",
        apiUrl: `http://localhost:${server.port}`,
        apiKey: "example-test-key",
        cwd: dir,
        logFile: join(dir, "session.log"),
      });
      session = (provider as unknown as { agentSession: AgentSession }).agentSession;
      return {
        active: session.getActiveToolNames(),
        codemodeDescription:
          session.getAllTools().find((tool) => tool.name === "codemode")?.description ?? "",
      };
    } finally {
      session?.dispose();
      server.stop(true);
    }
  }

  async function activeTools(): Promise<string[]> {
    return (await sessionTools()).active;
  }

  test("flag on: codemode is added and swarm tools stay declared", async () => {
    process.env.PI_CODEMODE = "true";
    const active = await activeTools();
    expect(active).toContain("codemode");
    expect(active).toContain("store-progress");
    expect(active).toContain("create-page");
  });

  test("models flag: scripts get the models API only when asked, and only with codemode", async () => {
    process.env.PI_CODEMODE = "true";
    expect((await sessionTools()).codemodeDescription).not.toContain("`models`");
    process.env.PI_CODEMODE_MODELS = "true";
    expect((await sessionTools()).codemodeDescription).toContain("`models`");
    process.env.PI_CODEMODE = "false";
    expect(await activeTools()).not.toContain("codemode");
  });

  test("flag off: no codemode", async () => {
    expect(await activeTools()).not.toContain("codemode");
    process.env.PI_CODEMODE = "false";
    expect(await activeTools()).not.toContain("codemode");
  });
});

describe("bounded codemode", () => {
  type Registered = ToolDefinition;

  function registerCodemode(limits: CodemodeLimits, options?: { models?: boolean }): Registered {
    let registered: Registered | undefined;
    const pi = {
      registerTool: (tool: Registered) => {
        registered = tool;
      },
      getSettings: () => ({}),
      getAllTools: () => [],
      appendEntry: () => {},
    } as unknown as ExtensionAPI;
    createBoundedCodemodeExtension(limits, options)(pi);
    if (!registered) throw new Error("codemode tool was not registered");
    return registered;
  }

  function fakeCtx(onCall: () => Promise<void> = async () => {}) {
    const calls: string[] = [];
    let running = 0;
    let peak = 0;
    // Same shape as pi's createToolContext(): executeTool is defined
    // non-writable and non-configurable, so a Proxy cannot swap it.
    const ctx = Object.defineProperties(
      {
        tools: [{ name: "noop", description: "does nothing", parameters: { type: "object" } }],
        sessionManager: { getBranch: () => [] },
      },
      {
        executeTool: {
          value: async (name: string) => {
            calls.push(name);
            running++;
            peak = Math.max(peak, running);
            try {
              await onCall();
            } finally {
              running--;
            }
            return {
              toolCall: { id: `call-${calls.length}` },
              result: { content: [{ type: "text", text: "ok" }] },
              isError: false,
            };
          },
        },
      },
    ) as unknown as ExtensionToolContext;
    return { ctx, calls, peak: () => peak };
  }

  function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((item) => item.text ?? "").join("\n");
  }

  const limits = { timeoutMs: 30_000, maxNestedCalls: 32, maxConcurrentCalls: 4 };

  test("scripts have no models API unless models is on", async () => {
    const code = "return typeof models;";
    const off = await registerCodemode(limits).execute(
      "m1",
      { code },
      undefined,
      undefined,
      fakeCtx().ctx,
    );
    expect(textOf(off)).toContain("undefined");
    const on = await registerCodemode(limits, { models: true }).execute(
      "m2",
      { code },
      undefined,
      undefined,
      fakeCtx().ctx,
    );
    expect(textOf(on)).toContain("object");
  }, 20_000);

  test("a non-terminating script is interrupted at the deadline", async () => {
    const tool = registerCodemode({ ...limits, timeoutMs: 300 });
    const started = Date.now();
    const result = await tool.execute(
      "t1",
      { code: "while (true) {}" },
      undefined,
      undefined,
      fakeCtx().ctx,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(textOf(result)).toContain("300 ms deadline");
  }, 20_000);

  test("the deadline also caps a script that asks for a longer timeout_ms", async () => {
    const tool = registerCodemode({ ...limits, timeoutMs: 300 });
    const code = '// @options: {"timeout_ms": 600000}\nwhile (true) {}';
    const result = await tool.execute("t2", { code }, undefined, undefined, fakeCtx().ctx);
    expect(textOf(result)).toContain("300 ms deadline");
  }, 20_000);

  test("nested calls past the budget fail the script", async () => {
    const tool = registerCodemode({ ...limits, maxNestedCalls: 3 });
    const fake = fakeCtx();
    const code =
      "for (let i = 0; i < 10; i++) { try { await tools.noop({}); } catch {} }\nreturn 'done';";
    const result = await tool.execute("t3", { code }, undefined, undefined, fake.ctx);
    expect(fake.calls).toHaveLength(3);
    expect(textOf(result)).toStartWith("Script failed");
    expect(textOf(result)).toContain("budget of 3 nested tool calls");
  }, 20_000);

  test("nested calls run at most maxConcurrentCalls at once", async () => {
    const tool = registerCodemode({ ...limits, maxConcurrentCalls: 2 });
    const fake = fakeCtx(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const code =
      "await Promise.all(Array.from({ length: 6 }, () => tools.noop({})));\nreturn 'done';";
    const result = await tool.execute("t4", { code }, undefined, undefined, fake.ctx);
    expect(textOf(result)).toStartWith("Script completed");
    expect(fake.calls).toHaveLength(6);
    expect(fake.peak()).toBe(2);
  }, 20_000);

  test("cancelling the task aborts a running script", async () => {
    const tool = registerCodemode(limits);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("task cancelled")), 200);
    const result = await tool.execute(
      "t5",
      { code: "while (true) {}" },
      controller.signal,
      undefined,
      fakeCtx().ctx,
    );
    expect(textOf(result)).toContain("task cancelled");
  }, 20_000);
});
