import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENAI_COMPATIBLE_PROVIDERS } from "@desplega/model-catalog";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { renderContextBoundNote } from "../prompts/context-bound-note";
import { configureHttpResolver, resetHttpResolver } from "../prompts/resolver";
import {
  checkPiMonoCredentials,
  createPiRuntimeAuth,
  extractPiAssistantText,
  listPiOpencodeGoModelIds,
  PiMonoAdapter,
  resolveModel,
  type SessionModelsJson,
  writeSessionModelsJson,
} from "../providers/pi-mono-adapter";
import type { ProviderSessionConfig } from "../providers/types";
import { HELD_NOTE_TEXT, holdTemplateRender } from "./fixtures/held-template-render";

describe("PiMonoAdapter", () => {
  test("name is 'pi'", () => {
    const adapter = new PiMonoAdapter();
    expect(adapter.name).toBe("pi");
  });
});

// ─── Phase 4 (reasoning-effort plan): createSession sessionOptions wiring ────

describe("PiMonoAdapter.createSession — reasoning_effort", () => {
  function makeReasoningConfig(
    overrides: Partial<ProviderSessionConfig> = {},
  ): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "openrouter/google/gemini-3-flash-preview",
      role: "worker",
      agentId: "test-agent",
      taskId: "test-task",
      apiUrl: "",
      apiKey: "",
      cwd: "/tmp",
      logFile: `/tmp/pi-reasoning-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      ...overrides,
    };
  }

  /** Minimal fake `AgentSession` — mirrors `makeMockAgentSession` below. */
  function makeFakeSession() {
    return {
      sessionId: "fake-session",
      isStreaming: false,
      model: undefined,
      subscribe: () => () => {},
      dispose: () => {},
      bindExtensions: async () => {},
    };
  }

  let createAgentSessionSpy: ReturnType<typeof spyOn>;
  let capturedOptions: Record<string, unknown> | undefined;

  afterEach(() => {
    createAgentSessionSpy?.mockRestore();
    capturedOptions = undefined;
  });

  function spyOnCreateAgentSession() {
    createAgentSessionSpy = spyOn(piCodingAgent, "createAgentSession").mockImplementation((async (
      opts: Record<string, unknown>,
    ) => {
      capturedOptions = opts;
      return { session: makeFakeSession() };
    }) as typeof piCodingAgent.createAgentSession);
  }

  test("reasoningEffort: 'medium' on an openrouter model sets thinkingLevel", async () => {
    spyOnCreateAgentSession();
    const adapter = new PiMonoAdapter();
    await adapter.createSession(makeReasoningConfig({ reasoningEffort: "medium" }));
    expect(capturedOptions?.thinkingLevel).toBe("medium");
  });

  test("undefined reasoningEffort leaves sessionOptions unchanged (no thinkingLevel key)", async () => {
    spyOnCreateAgentSession();
    const adapter = new PiMonoAdapter();
    await adapter.createSession(makeReasoningConfig());
    expect(capturedOptions).not.toHaveProperty("thinkingLevel");
  });
});

// ─── OPENROUTER_BASE_URL gateway routing (session model composition) ─────────

describe("PiMonoAdapter.createSession — OPENROUTER_BASE_URL gateway", () => {
  const GATEWAY = "https://control-plane.example/proxy/v1";
  const agentDir = `/tmp/pi-or-gateway-test-${Date.now()}`;
  const origAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

  let createAgentSessionSpy: ReturnType<typeof spyOn>;
  let capturedOptions: Record<string, unknown> | undefined;

  beforeAll(() => {
    mkdirSync(agentDir, { recursive: true });
    // getAgentDir() reads process.env directly (config.env doesn't reach it).
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterAll(() => {
    if (origAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDirEnv;
    rmSync(agentDir, { recursive: true, force: true });
  });

  afterEach(() => {
    createAgentSessionSpy?.mockRestore();
    capturedOptions = undefined;
  });

  function makeConfig(env: Record<string, string>): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "openrouter/google/gemini-3-flash-preview",
      role: "worker",
      agentId: "test-agent",
      taskId: "test-task",
      apiUrl: "",
      apiKey: "",
      cwd: "/tmp",
      logFile: `/tmp/pi-or-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      env: { OPENROUTER_API_KEY: "sk-or-test", ...env },
    };
  }

  function spyOnCreateAgentSession() {
    createAgentSessionSpy = spyOn(piCodingAgent, "createAgentSession").mockImplementation((async (
      opts: Record<string, unknown>,
    ) => {
      capturedOptions = opts;
      return {
        session: {
          sessionId: "fake-session",
          isStreaming: false,
          model: undefined,
          subscribe: () => () => {},
          dispose: () => {},
          bindExtensions: async () => {},
        },
      };
    }) as typeof piCodingAgent.createAgentSession);
  }

  test("session model carries the gateway baseUrl when OPENROUTER_BASE_URL is set", async () => {
    spyOnCreateAgentSession();
    const adapter = new PiMonoAdapter();
    await adapter.createSession(makeConfig({ OPENROUTER_BASE_URL: GATEWAY }));
    const model = capturedOptions?.model as { baseUrl?: string; id?: string } | undefined;
    expect(model?.id).toBe("google/gemini-3-flash-preview");
    expect(model?.baseUrl).toBe(GATEWAY);
    // The override lives in the session's own copy, never the shared file.
    expect(existsSync(join(agentDir, "models.json"))).toBe(false);
  });

  test("session model keeps the default openrouter.ai baseUrl when env is unset", async () => {
    // Fresh agent dir so the previous test's models.json doesn't leak in.
    const cleanDir = `${agentDir}-clean`;
    mkdirSync(cleanDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = cleanDir;
    try {
      spyOnCreateAgentSession();
      const adapter = new PiMonoAdapter();
      await adapter.createSession(makeConfig({}));
      const model = capturedOptions?.model as { baseUrl?: string } | undefined;
      expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(existsSync(join(cleanDir, "models.json"))).toBe(false);
    } finally {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });
});

// ─── MCP setup and runtime identity ─────────────────────────────────────────

describe("PiMonoAdapter.createSession — MCP setup", () => {
  let createAgentSessionSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    createAgentSessionSpy?.mockRestore();
  });

  function spyOnCreateAgentSession() {
    createAgentSessionSpy = spyOn(piCodingAgent, "createAgentSession").mockImplementation((async (
      _opts: Record<string, unknown>,
    ) => {
      return {
        session: {
          sessionId: "fake-session",
          isStreaming: false,
          model: undefined,
          subscribe: () => () => {},
          dispose: () => {},
          bindExtensions: async () => {},
        },
      };
    }) as typeof piCodingAgent.createAgentSession);
  }

  function makeMcpConfig(apiUrl: string): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "openrouter/google/gemini-3-flash-preview",
      role: "worker",
      agentId: "test-agent",
      taskId: "test-task",
      apiUrl,
      apiKey: "example-test-key",
      cwd: "/tmp",
      logFile: `/tmp/pi-mcp-header-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    };
  }

  /** Stub swarm API: records headers and fails the requested setup steps once. */
  function serveStub(
    seen: Array<string | null>,
    failures: string[] = [],
    initializeSessions: Array<string | null> = [],
  ) {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          seen.push(req.headers.get("x-runtime-instance-id"));
          const body = (await req.json()) as { id?: number; method: string };
          if (body.method === "initialize") {
            initializeSessions.push(req.headers.get("mcp-session-id"));
          }
          if (body.method === failures[0]) {
            failures.shift();
            return new Response("Temporary MCP failure", { status: 503 });
          }
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result:
                body.method === "tools/list"
                  ? { tools: [{ name: "get-tasks", inputSchema: { type: "object" } }] }
                  : { protocolVersion: "2025-03-26", capabilities: {} },
            },
            body.method === "initialize"
              ? { headers: { "mcp-session-id": `test-session-${initializeSessions.length}` } }
              : undefined,
          );
        }
        return Response.json({ servers: [] });
      },
    });
  }

  test("swarm MCP requests carry the per-boot X-Runtime-Instance-ID", async () => {
    const seen: Array<string | null> = [];
    const server = serveStub(seen);
    const prev = process.env.SWARM_RUNTIME_INSTANCE_ID;
    process.env.SWARM_RUNTIME_INSTANCE_ID = "pi-runtime-1";
    try {
      spyOnCreateAgentSession();
      const adapter = new PiMonoAdapter();
      await adapter.createSession(makeMcpConfig(`http://localhost:${server.port}`));
      // initialize + initialized + tools/list all hit /mcp — every one must
      // present the same per-boot identity.
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(["pi-runtime-1"]));
    } finally {
      if (prev === undefined) delete process.env.SWARM_RUNTIME_INSTANCE_ID;
      else process.env.SWARM_RUNTIME_INSTANCE_ID = prev;
      server.stop(true);
    }
  });

  test("no per-boot identity in the environment → no runtime header", async () => {
    const seen: Array<string | null> = [];
    const server = serveStub(seen);
    const prev = process.env.SWARM_RUNTIME_INSTANCE_ID;
    delete process.env.SWARM_RUNTIME_INSTANCE_ID;
    try {
      spyOnCreateAgentSession();
      const adapter = new PiMonoAdapter();
      await adapter.createSession(makeMcpConfig(`http://localhost:${server.port}`));
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set([null]));
    } finally {
      if (prev === undefined) delete process.env.SWARM_RUNTIME_INSTANCE_ID;
      else process.env.SWARM_RUNTIME_INSTANCE_ID = prev;
      server.stop(true);
    }
  });

  test.each([
    "initialize",
    "notifications/initialized",
    "tools/list",
  ])("retries a transient %s failure and registers swarm tools with a fresh MCP session", async (failedMethod) => {
    const seen: Array<string | null> = [];
    const initializeSessions: Array<string | null> = [];
    const server = serveStub(seen, [failedMethod], initializeSessions);
    const prev = process.env.SWARM_RUNTIME_INSTANCE_ID;
    process.env.SWARM_RUNTIME_INSTANCE_ID = "pi-retry-runtime";
    try {
      spyOnCreateAgentSession();
      const adapter = new PiMonoAdapter();
      await adapter.createSession(makeMcpConfig(`http://localhost:${server.port}`));
      const options = createAgentSessionSpy.mock.calls[0]?.[0];
      expect(options?.customTools?.map((tool) => tool.name)).toEqual(["get-tasks", "bash"]);
      expect(initializeSessions).toEqual([null, null]);
      expect(new Set(seen)).toEqual(new Set(["pi-retry-runtime"]));
    } finally {
      if (prev === undefined) delete process.env.SWARM_RUNTIME_INSTANCE_ID;
      else process.env.SWARM_RUNTIME_INSTANCE_ID = prev;
      server.stop(true);
    }
  });

  test("stops after three failed MCP setup attempts and retains the no-tools fallback", async () => {
    const initializeSessions: Array<string | null> = [];
    const failures = ["initialize", "initialize", "initialize", "initialize"];
    const server = serveStub([], failures, initializeSessions);
    try {
      spyOnCreateAgentSession();
      const adapter = new PiMonoAdapter();
      await adapter.createSession(makeMcpConfig(`http://localhost:${server.port}`));
      expect(initializeSessions).toEqual([null, null, null]);
      expect(failures).toEqual(["initialize"]);
      expect(
        createAgentSessionSpy.mock.calls[0]?.[0]?.customTools?.map((tool) => tool.name),
      ).toEqual(["bash"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("AGENTS.md symlink management", () => {
  const tmpDir = `/tmp/pi-mono-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates symlink when CLAUDE.md exists but AGENTS.md does not", () => {
    const testDir = join(tmpDir, "symlink-create");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Test");

    // Simulate what createAgentsMdSymlink does
    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(true);
  });

  test("does not overwrite existing AGENTS.md", () => {
    const testDir = join(tmpDir, "no-overwrite");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Claude");
    writeFileSync(join(testDir, "AGENTS.md"), "# Real AGENTS.md");

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    // Simulate createAgentsMdSymlink — should NOT overwrite existing AGENTS.md
    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    // AGENTS.md should still be a real file, not a symlink
    expect(existsSync(agentsMd)).toBe(true);
    const content = readFileSync(agentsMd, "utf-8");
    expect(content).toBe("# Real AGENTS.md");
  });

  test("no-op when CLAUDE.md does not exist", () => {
    const testDir = join(tmpDir, "no-claudemd");
    mkdirSync(testDir);

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(false);
  });
});

describe("Model name mapping", () => {
  // Test the shortname → full ID mapping logic that resolveModel uses
  const shortnames: Record<string, [string, string]> = {
    opus: ["anthropic", "claude-opus-4-8"],
    sonnet: ["anthropic", "claude-sonnet-5"],
    haiku: ["anthropic", "claude-haiku-4-5-20251001"],
  };

  test("opus maps to anthropic/claude-opus-4-8", () => {
    const mapping = shortnames.opus;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-opus-4-8");
  });

  test("sonnet maps to anthropic/claude-sonnet-5", () => {
    const mapping = shortnames.sonnet;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-sonnet-5");
  });

  test("haiku maps to anthropic/claude-haiku-4-5-20251001", () => {
    const mapping = shortnames.haiku;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-haiku-4-5-20251001");
  });

  test("unknown shortname returns undefined", () => {
    const mapping = shortnames.gpt4;
    expect(mapping).toBeUndefined();
  });

  test("provider/model-id format is parseable", () => {
    const modelStr = "anthropic/claude-opus-4-8";
    expect(modelStr.includes("/")).toBe(true);
    const [provider, modelId] = modelStr.split("/", 2);
    expect(provider).toBe("anthropic");
    expect(modelId).toBe("claude-opus-4-8");
  });
});

describe("listPiOpencodeGoModelIds", () => {
  test("every reported opencode-go id resolves, so a picked id never falls back", () => {
    const ids = listPiOpencodeGoModelIds();
    expect(ids).toContain("deepseek-v4.1-flash");
    for (const id of ids) {
      expect(resolveModel(`opencode-go/${id}`, {})?.id).toBe(id);
    }
    expect(ids).not.toContain("deepseek-v4-flash");
    expect(resolveModel("opencode-go/deepseek-v4-flash", {})).toBeUndefined();
  });
});

describe("resolveModel — OpenRouter reroute for anthropic shortnames", () => {
  // Regression coverage for task 37a4a87a: workers spawned with
  // `provider: pi` + `OPENROUTER_API_KEY` (no ANTHROPIC_API_KEY) and a task
  // model of `sonnet` / `haiku` / `opus` previously crashed at
  // session-start with "No API key found for anthropic" because pi-ai's
  // anthropic provider only checks ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY.
  // The adapter now reroutes the shortname through the OpenRouter mirror.

  test("sonnet → openrouter/anthropic/claude-sonnet-5 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-sonnet-5");
  });

  test("haiku → openrouter/anthropic/claude-haiku-4.5 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("haiku", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-haiku-4.5");
  });

  test("opus → openrouter/anthropic/claude-opus-4.8 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("opus", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-opus-4.8");
  });

  test("anthropic native path wins when ANTHROPIC_API_KEY is set (even alongside OPENROUTER_API_KEY)", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-...", OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-5");
  });

  test("ANTHROPIC_OAUTH_TOKEN alone also wins over OPENROUTER reroute", () => {
    const env = { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-...", OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("anthropic");
  });

  test("no rerouting for non-shortname `anthropic/<model>` strings", () => {
    // Explicit provider prefix should not be silently swapped — that path is
    // the caller's explicit choice, surface as-is.
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("anthropic/claude-sonnet-5", env);
    expect(model?.provider).toBe("anthropic");
  });

  test("default env arg falls back to process.env (smoke test — no creds set)", () => {
    // Just confirm the default parameter doesn't throw — the actual model
    // resolution depends on the test runner's env.
    expect(() => resolveModel("unknown-model-id")).not.toThrow();
  });
});

describe("createPiRuntimeAuth", () => {
  test("threads resolved OpenRouter key into pi runtime auth without process.env", async () => {
    const modelRuntime = await createPiRuntimeAuth({ OPENROUTER_API_KEY: "example-sk-or-runtime" });

    await expect(modelRuntime.getAuth("openrouter")).resolves.toMatchObject({
      auth: { apiKey: "example-sk-or-runtime" },
    });
  });

  test("supports all pi env-backed providers", async () => {
    const modelRuntime = await createPiRuntimeAuth({
      ANTHROPIC_API_KEY: "example-sk-ant-runtime",
      OPENAI_API_KEY: "example-sk-openai-runtime",
      GOOGLE_API_KEY: "example-sk-google-runtime",
    });

    await expect(modelRuntime.getAuth("anthropic")).resolves.toMatchObject({
      auth: { apiKey: "example-sk-ant-runtime" },
    });
    await expect(modelRuntime.getAuth("openai")).resolves.toMatchObject({
      auth: { apiKey: "example-sk-openai-runtime" },
    });
    await expect(modelRuntime.getAuth("google")).resolves.toMatchObject({
      auth: { apiKey: "example-sk-google-runtime" },
    });
  });

  test("passes OPENCODE_API_KEY to pi opencode-go runtime auth", async () => {
    const modelRuntime = await createPiRuntimeAuth({
      OPENCODE_API_KEY: "example-opencode-runtime",
    });

    await expect(modelRuntime.getAuth("opencode-go")).resolves.toMatchObject({
      auth: { apiKey: "example-opencode-runtime" },
    });
  });

  test("passes GEMINI_API_KEY to pi google runtime auth", async () => {
    const modelRuntime = await createPiRuntimeAuth({
      GEMINI_API_KEY: "example-gemini-runtime",
    });

    await expect(modelRuntime.getAuth("google")).resolves.toMatchObject({
      auth: { apiKey: "example-gemini-runtime" },
    });
  });
});

// ─── NaN / Helmcode custom providers (models.json, runtime keys, resolve) ───

const NAN_ENV = { NAN_API_KEY: "example-nan-picked" };
const HELMCODE_ENV = { HELMCODE_API_KEY: "example-helmcode-picked" };
async function readModelsJson(path: string | undefined): Promise<Record<string, any>> {
  if (!path) throw new Error("expected a per-session models.json");
  return JSON.parse(await Bun.file(path).text());
}

function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Compose a session's models.json and always remove it afterwards. */
async function withSessionModels(
  dir: string,
  env: Record<string, string | undefined>,
  model: string | undefined,
  fn: (session: SessionModelsJson) => Promise<void>,
): Promise<void> {
  const session = await writeSessionModelsJson(dir, env, model);
  try {
    await fn(session);
  } finally {
    await session.dispose();
  }
}

describe("writeSessionModelsJson (pi)", () => {
  test(
    "writes both blocks with $VAR apiKeys to a private file, never the key value or the shared file",
    withTempDir("pi-custom-fresh-", async (dir) => {
      await withSessionModels(dir, { ...NAN_ENV, ...HELMCODE_ENV }, undefined, async (s) => {
        expect(s.modelsPath).toBeDefined();
        expect(s.modelsPath?.startsWith(dir)).toBe(false);
        expect(existsSync(join(dir, "models.json"))).toBe(false);
        const raw = await Bun.file(s.modelsPath as string).text();
        expect(raw).not.toContain("example-nan-picked");
        expect(raw).not.toContain("example-helmcode-picked");
        const written = JSON.parse(raw);
        expect(written.providers.nan).toMatchObject({
          baseUrl: OPENAI_COMPATIBLE_PROVIDERS.nan.baseUrl,
          api: "openai-completions",
          apiKey: "$NAN_API_KEY",
        });
        expect(written.providers.helmcode).toMatchObject({
          baseUrl: OPENAI_COMPATIBLE_PROVIDERS.helmcode.baseUrl,
          api: "openai-completions",
          apiKey: "$HELMCODE_API_KEY",
        });
        expect(written.providers.helmcode.models.map((m: { id: string }) => m.id)).toEqual(
          OPENAI_COMPATIBLE_PROVIDERS.helmcode.models.map((m) => m.id),
        );
        const glm = written.providers.nan.models.find((m: { id: string }) => m.id === "glm5.3");
        expect(glm).toMatchObject({
          contextWindow: 1000000,
          maxTokens: 131072,
          reasoning: true,
          compat: { supportsDeveloperRole: true },
        });
      });
    }),
  );

  test(
    "dispose removes the private file",
    withTempDir("pi-custom-dispose-", async (dir) => {
      const s = await writeSessionModelsJson(dir, NAN_ENV);
      expect(existsSync(s.modelsPath as string)).toBe(true);
      await s.dispose();
      await s.dispose();
      expect(existsSync(s.modelsPath as string)).toBe(false);
    }),
  );

  test(
    "only the HELMCODE_API_NAN alias set: nan block still uses $NAN_API_KEY",
    withTempDir("pi-custom-alias-", async (dir) => {
      await withSessionModels(dir, { HELMCODE_API_NAN: "example-alias" }, undefined, async (s) => {
        const written = await readModelsJson(s.modelsPath);
        expect(written.providers.nan.apiKey).toBe("$NAN_API_KEY");
        expect(written.providers.helmcode).toBeUndefined();
        expect(JSON.stringify(written)).not.toContain("example-alias");
      });
    }),
  );

  test(
    "no key, default gateway, no marker: the session loads the shared file",
    withTempDir("pi-custom-noop-", async (dir) => {
      const userConfig = { providers: { nan: { baseUrl: "https://mine.example/v1" } } };
      await Bun.write(join(dir, "models.json"), JSON.stringify(userConfig));
      const s = await writeSessionModelsJson(dir, {});
      expect(s.modelsPath).toBeUndefined();
      expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"))).toEqual(userConfig);
    }),
  );

  test(
    "a user-authored providers.nan in the shared file wins; helmcode is still added",
    withTempDir("pi-custom-user-", async (dir) => {
      const userNan = { baseUrl: "https://mine.example/v1", apiKey: "$MY_VAR", models: [] };
      const shared = JSON.stringify({ providers: { nan: userNan } });
      await Bun.write(join(dir, "models.json"), shared);
      await withSessionModels(dir, { ...NAN_ENV, ...HELMCODE_ENV }, undefined, async (s) => {
        const written = await readModelsJson(s.modelsPath);
        expect(written.providers.nan).toEqual(userNan);
        expect(written.providers.helmcode.apiKey).toBe("$HELMCODE_API_KEY");
      });
      expect(readFileSync(join(dir, "models.json"), "utf-8")).toBe(shared);
    }),
  );

  test(
    "keeps other providers and top-level keys; the gateway comes from this session's env",
    withTempDir("pi-custom-merge-", async (dir) => {
      const gateway = "https://control-plane.example/proxy/v1";
      await Bun.write(
        join(dir, "models.json"),
        JSON.stringify({
          $schema: "https://pi.dev/schemas/models.schema.json",
          providers: {
            custom: { baseUrl: "https://custom.example/v1", api: "openai-completions" },
            openrouter: { baseUrl: gateway },
          },
        }),
      );
      // An earlier version wrote that gateway into the shared file.
      await Bun.write(
        join(dir, ".agent-swarm-openrouter-override.json"),
        JSON.stringify({ baseUrl: gateway }),
      );
      const sharedBefore = readFileSync(join(dir, "models.json"), "utf-8");
      await withSessionModels(dir, NAN_ENV, undefined, async (s) => {
        // This session uses the default gateway: the leftover override
        // recorded in the legacy marker is reverted in its copy.
        const written = await readModelsJson(s.modelsPath);
        expect(written.$schema).toBe("https://pi.dev/schemas/models.schema.json");
        expect(written.providers.openrouter).toBeUndefined();
        expect(written.providers.custom.baseUrl).toBe("https://custom.example/v1");
        expect(written.providers.nan.apiKey).toBe("$NAN_API_KEY");
      });
      const other = "https://other-gateway.example/v1";
      await withSessionModels(dir, { OPENROUTER_BASE_URL: other }, undefined, async (s) => {
        expect((await readModelsJson(s.modelsPath)).providers.openrouter).toEqual({
          baseUrl: other,
        });
      });
      // The shared file is never written by the composer.
      expect(readFileSync(join(dir, "models.json"), "utf-8")).toBe(sharedBefore);
    }),
  );

  test(
    "sibling sessions get their own endpoints, providers and model ids",
    withTempDir("pi-custom-siblings-", async (dir) => {
      const a = await writeSessionModelsJson(
        dir,
        { HELMCODE_API_KEY: "a", HELMCODE_BASE_URL: "http://127.0.0.1:1/v1", ...NAN_ENV },
        "nan/glm5.2",
      );
      const b = await writeSessionModelsJson(
        dir,
        { HELMCODE_API_KEY: "b", HELMCODE_BASE_URL: "http://127.0.0.1:2/v1" },
        "helmcode/glm5.3",
      );
      try {
        expect(a.modelsPath).not.toBe(b.modelsPath);
        const first = await readModelsJson(a.modelsPath);
        const second = await readModelsJson(b.modelsPath);
        expect(first.providers.helmcode.baseUrl).toBe("http://127.0.0.1:1/v1");
        expect(second.providers.helmcode.baseUrl).toBe("http://127.0.0.1:2/v1");
        // B has no NaN key: no nan block, even while A's session holds one.
        expect(first.providers.nan.models.map((m: { id: string }) => m.id)).toContain("glm5.2");
        expect(second.providers.nan).toBeUndefined();
      } finally {
        await a.dispose();
        await b.dispose();
      }
    }),
  );

  test(
    "corrupt shared models.json: the copy holds our blocks only, the shared file is untouched",
    withTempDir("pi-custom-corrupt-", async (dir) => {
      await Bun.write(join(dir, "models.json"), "{not json");
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withSessionModels(dir, NAN_ENV, undefined, async (s) => {
          expect((await readModelsJson(s.modelsPath)).providers.nan.apiKey).toBe("$NAN_API_KEY");
        });
      } finally {
        warn.mockRestore();
      }
      expect(readFileSync(join(dir, "models.json"), "utf-8")).toBe("{not json");
    }),
  );

  test(
    "ModelRuntime resolves the written blocks as nan/<id> and helmcode/<id>",
    withTempDir("pi-custom-runtime-", async (dir) => {
      await withSessionModels(dir, { ...NAN_ENV, ...HELMCODE_ENV }, undefined, async (s) => {
        const runtime = await piCodingAgent.ModelRuntime.create({
          authPath: join(dir, "auth.json"),
          modelsPath: s.modelsPath,
        });
        expect(runtime.getError()).toBeUndefined();
        expect(runtime.getModel("nan", "qwen3.8-flash")?.baseUrl).toBe(
          OPENAI_COMPATIBLE_PROVIDERS.nan.baseUrl,
        );
        expect(runtime.getModel("helmcode", "glm5.3")?.contextWindow).toBe(1048576);
      });
    }),
  );
});

describe("createPiRuntimeAuth — NaN and Helmcode", () => {
  test(
    "HELMCODE_API_NAN alone sets the nan runtime key; NAN_API_KEY wins when both are set",
    withTempDir("pi-custom-auth-", async (dir) => {
      const models = await writeSessionModelsJson(dir, { NAN_API_KEY: "x", HELMCODE_API_KEY: "y" });
      // pi's own agent-dir env var points auth.json at the temp dir.
      const origAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      try {
        const path = models.modelsPath;
        const aliasOnly = await createPiRuntimeAuth({ HELMCODE_API_NAN: "a" }, path);
        await expect(aliasOnly.getAuth("nan")).resolves.toMatchObject({ auth: { apiKey: "a" } });

        const both = await createPiRuntimeAuth({ HELMCODE_API_NAN: "a", NAN_API_KEY: "b" }, path);
        await expect(both.getAuth("nan")).resolves.toMatchObject({ auth: { apiKey: "b" } });

        const helm = await createPiRuntimeAuth({ HELMCODE_API_KEY: "h" }, path);
        await expect(helm.getAuth("helmcode")).resolves.toMatchObject({ auth: { apiKey: "h" } });
      } finally {
        await models.dispose();
        if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = origAgentDir;
      }

      // Runtime keys never land in auth.json.
      const auth = (await Bun.file(join(dir, "auth.json")).exists())
        ? await Bun.file(join(dir, "auth.json")).text()
        : "";
      expect(auth).not.toContain('"a"');
      expect(auth).not.toContain('"b"');
      expect(auth).not.toContain('"h"');
    }),
  );
});

describe("resolveModel — models.json custom providers", () => {
  test(
    "falls back to the runtime for nan/qwen3.8-flash and helmcode/glm5.3",
    withTempDir("pi-custom-resolve-", async (dir) => {
      const models = await writeSessionModelsJson(dir, { ...NAN_ENV, ...HELMCODE_ENV });
      const runtime = await piCodingAgent.ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: models.modelsPath,
      });
      await models.dispose();
      const nan = resolveModel("nan/qwen3.8-flash", NAN_ENV, runtime);
      expect(nan?.provider).toBe("nan");
      expect(nan?.id).toBe("qwen3.8-flash");
      const helm = resolveModel("helmcode/glm5.3", HELMCODE_ENV, runtime);
      expect(helm?.provider).toBe("helmcode");
      expect(helm?.id).toBe("glm5.3");
      expect(helm?.baseUrl).toBe(OPENAI_COMPATIBLE_PROVIDERS.helmcode.baseUrl);
    }),
  );

  test(
    "a nan/<id> outside the table (nan/glm5.2) gets a bare entry and resolves",
    withTempDir("pi-custom-bare-", async (dir) => {
      await withSessionModels(dir, NAN_ENV, "nan/glm5.2", async (s) => {
        const written = await readModelsJson(s.modelsPath);
        const ids = written.providers.nan.models.map((m: { id: string }) => m.id);
        expect(ids).toContain("glm5.2");
        expect(ids).toContain("glm5.3");
        const runtime = await piCodingAgent.ModelRuntime.create({
          authPath: join(dir, "auth.json"),
          modelsPath: s.modelsPath,
        });
        const model = resolveModel("nan/glm5.2", NAN_ENV, runtime);
        expect(model?.provider).toBe("nan");
        expect(model?.id).toBe("glm5.2");
        expect(model?.baseUrl).toBe(OPENAI_COMPATIBLE_PROVIDERS.nan.baseUrl);
      });

      // The bare entry belongs to that session: the next task's model never sees it.
      await withSessionModels(dir, NAN_ENV, "nan/glm5.3", async (s) => {
        const next = await readModelsJson(s.modelsPath);
        expect(next.providers.nan.models.map((m: { id: string }) => m.id)).not.toContain("glm5.2");
      });
    }),
  );

  test("builtin hits are unchanged when a runtime is passed", async () => {
    const runtime = { getModel: () => undefined };
    const model = resolveModel("anthropic/claude-sonnet-5", {}, runtime);
    expect(model?.provider).toBe("anthropic");
  });

  test("an unknown provider returns undefined and logs a scrubbed warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = { getModel: () => undefined };
      expect(resolveModel("nope/model-x", {}, runtime)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('"nope/model-x"');
      expect(String(warn.mock.calls[0]?.[0])).toContain("default model");
    } finally {
      warn.mockRestore();
    }
  });

  test("without a runtime, nan/<id> does not resolve (pi-ai has no builtin nan)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveModel("nan/glm5.3", NAN_ENV)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("checkPiMonoCredentials — NaN and Helmcode", () => {
  const opts = { homeDir: "/home/worker", fs: { existsSync: () => false } };

  test("MODEL_OVERRIDE=nan/* accepts NAN_API_KEY or the HELMCODE_API_NAN alias", async () => {
    const env = { MODEL_OVERRIDE: "nan/glm5.3" };
    expect((await checkPiMonoCredentials(env, opts)).ready).toBe(false);
    expect((await checkPiMonoCredentials({ ...env, NAN_API_KEY: "x" }, opts)).ready).toBe(true);
    expect((await checkPiMonoCredentials({ ...env, HELMCODE_API_NAN: "x" }, opts)).ready).toBe(
      true,
    );
    // An OpenRouter key does not satisfy a nan/* model.
    expect((await checkPiMonoCredentials({ ...env, OPENROUTER_API_KEY: "x" }, opts)).ready).toBe(
      false,
    );
  });

  test("MODEL_OVERRIDE=helmcode/* requires HELMCODE_API_KEY", async () => {
    const env = { MODEL_OVERRIDE: "helmcode/glm5.3" };
    const missing = await checkPiMonoCredentials({ ...env, NAN_API_KEY: "x" }, opts);
    expect(missing.ready).toBe(false);
    expect(missing.missing).toContain("HELMCODE_API_KEY");
    expect((await checkPiMonoCredentials({ ...env, HELMCODE_API_KEY: "x" }, opts)).ready).toBe(
      true,
    );
  });

  test("permissive case accepts a NaN-only or Helmcode-only worker", async () => {
    expect((await checkPiMonoCredentials({ HELMCODE_API_NAN: "x" }, opts)).ready).toBe(true);
    expect((await checkPiMonoCredentials({ HELMCODE_API_KEY: "x" }, opts)).ready).toBe(true);
  });
});

describe("Pi-mono event normalization", () => {
  test("extractPiAssistantText ignores user messages", () => {
    const text = extractPiAssistantText({
      role: "user",
      content: "/skill:work-on-task task-123\n\nTask: hello",
    });

    expect(text).toBe("");
  });

  test("extractPiAssistantText extracts assistant text blocks", () => {
    const text = extractPiAssistantText({
      role: "assistant",
      content: [
        { type: "text", text: "Hello, " },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "world!" },
      ],
    });

    expect(text).toBe("Hello, world!");
  });

  test("extractPiAssistantText supports string assistant content", () => {
    const text = extractPiAssistantText({
      role: "assistant",
      content: "Plain assistant output",
    });

    expect(text).toBe("Plain assistant output");
  });

  test("message_update with text content produces raw_log-style data", () => {
    // Simulates what PiMonoSession.handleAgentEvent does
    const event = {
      type: "message_update" as const,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello, world!" },
          { type: "text", text: " More text." },
        ],
      },
    };

    const content = event.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("");

    expect(content).toBe("Hello, world! More text.");
  });

  test("tool_execution_start produces tool_use log", () => {
    const event = {
      type: "tool_execution_start" as const,
      toolName: "write",
      toolCallId: "tc-123",
    };

    const logEntry = JSON.stringify({
      type: "tool_use",
      name: event.toolName,
      id: event.toolCallId,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_use");
    expect(parsed.name).toBe("write");
    expect(parsed.id).toBe("tc-123");
  });

  test("tool_execution_end produces tool_result log", () => {
    const event = {
      type: "tool_execution_end" as const,
      toolName: "write",
      toolCallId: "tc-123",
      isError: false,
    };

    const logEntry = JSON.stringify({
      type: "tool_result",
      name: event.toolName,
      id: event.toolCallId,
      isError: event.isError,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_result");
    expect(parsed.isError).toBe(false);
  });
});

describe("Cost aggregation from SessionStats", () => {
  test("builds CostData from SessionStats shape", () => {
    const stats = {
      tokens: {
        input: 5000,
        output: 2000,
        cacheRead: 1000,
        cacheWrite: 500,
        total: 8500,
      },
      cost: 0.0456,
      userMessages: 1,
      assistantMessages: 4,
    };

    const cost = {
      sessionId: "",
      taskId: "task-1",
      agentId: "agent-1",
      totalCostUsd: stats.cost || 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      durationMs: 0,
      numTurns: stats.userMessages + stats.assistantMessages,
      model: "opus",
      isError: false,
    };

    expect(cost.totalCostUsd).toBe(0.0456);
    expect(cost.inputTokens).toBe(5000);
    expect(cost.outputTokens).toBe(2000);
    expect(cost.cacheReadTokens).toBe(1000);
    expect(cost.cacheWriteTokens).toBe(500);
    expect(cost.numTurns).toBe(5);
  });

  test("handles zero-cost stats", () => {
    const stats = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
    };

    const cost = {
      totalCostUsd: stats.cost || 0,
      numTurns: stats.userMessages + stats.assistantMessages,
    };

    expect(cost.totalCostUsd).toBe(0);
    expect(cost.numTurns).toBe(0);
  });
});

// ============================================================================
// AWS SDK error detection — event-driven PiMonoSession + classifyAwsSdkError
//
// Redesign (2026-06): detection is driven entirely by structured
// pi-coding-agent events, NOT stderr scraping or auto_retry_start inference:
//   - `message_end` with an assistant `stopReason:'error'` → the ONLY signal
//     for NON-retryable failures, critically AWS auth (ExpiredToken /
//     CredentialsProviderError), which never enter pi's _isRetryableError loop.
//   - `auto_retry_end` with `success:false` + `finalError` → the definitive
//     terminal failure for the RETRYABLE class (throttle / 5xx / timeout).
//   - recovery (`message_end` success, or `auto_retry_end` success:true) clears
//     the tracked error so a recovered turn never surfaces as a false failure.
// ============================================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiMonoSession } from "../providers/pi-mono-adapter";
import type { ProviderEvent, ProviderResult } from "../providers/types";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";

function makeSessionConfig(logFile: string): ProviderSessionConfig {
  return {
    prompt: "test prompt",
    systemPrompt: "",
    model: "amazon-bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
    role: "worker",
    agentId: "test-agent-id",
    taskId: "test-task-id",
    apiUrl: "http://localhost:3013",
    apiKey: "example-test-key",
    cwd: "/tmp",
    logFile,
    iteration: 1,
  };
}

type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** Build a `message_end` event for an assistant turn that ended in error. */
function errorMessageEnd(errorMessage: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage,
    },
  } as unknown as AgentSessionEvent;
}

/** Build a `message_end` event for a successful assistant turn. */
function successMessageEnd(text: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  } as unknown as AgentSessionEvent;
}

/** Build an `auto_retry_end` event (terminal retryable failure / recovery). */
function autoRetryEnd(success: boolean, finalError?: string): AgentSessionEvent {
  return {
    type: "auto_retry_end",
    success,
    attempt: 3,
    ...(finalError ? { finalError } : {}),
  } as unknown as AgentSessionEvent;
}

/**
 * Mock AgentSession that replays a fixed list of structured events to its
 * subscribers when `prompt()` is called, then resolves (no throw). This mirrors
 * the real pi-coding-agent: AWS failures arrive as DATA via events, there is no
 * exception to catch at the agent-swarm layer.
 */
function makeMockAgentSession(opts: {
  /** Events replayed by the first `prompt()` call. */
  events?: AgentSessionEvent[];
  /** Events replayed per `prompt()` call (index = call number); wins over `events`. */
  turns?: AgentSessionEvent[][];
  /** Text of every `prompt()` call, in order. */
  promptCalls?: string[];
  /** Zero-based `prompt()` call that throws instead of replaying events. */
  throwOnCall?: number;
  /** The first `prompt()` call waits for this before replaying events. */
  holdFirstPrompt?: Promise<void>;
  throwError?: string;
  steerCalls?: string[];
  followUpCalls?: string[];
  steeringError?: string;
  /** Awaited after each call's events, as a real turn keeps running its tools. */
  afterEvents?: () => Promise<unknown>;
}): AgentSession {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const scripts = opts.turns ?? [opts.events ?? []];
  let promptIndex = 0;
  return {
    sessionId: "mock-session-id",
    isStreaming: false,
    model: undefined,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    async prompt(text: string) {
      const call = promptIndex++;
      opts.promptCalls?.push(text);
      if (call === 0) await opts.holdFirstPrompt;
      if (opts.throwOnCall === call) throw new Error("prompt rejected");
      for (const event of scripts[call] ?? []) {
        for (const l of listeners) l(event);
      }
      await opts.afterEvents?.();
      if (opts.throwError) throw new Error(opts.throwError);
    },
    getContextUsage: () => null,
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
    }),
    abort: async () => {},
    async steer(text: string) {
      opts.steerCalls?.push(text);
      if (opts.steeringError) throw new Error(opts.steeringError);
    },
    async followUp(text: string) {
      opts.followUpCalls?.push(text);
      if (opts.steeringError) throw new Error(opts.steeringError);
    },
    dispose: () => {},
  } as unknown as AgentSession;
}

const tmpLogDir = `/tmp/pi-mono-aws-test-${Date.now()}`;

beforeAll(() => {
  mkdirSync(tmpLogDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
});

async function runWithEvents(events: AgentSessionEvent[]): Promise<{
  events: ProviderEvent[];
  result: ProviderResult;
}> {
  const logFile = join(tmpLogDir, `evt-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const session = new PiMonoSession(
    makeMockAgentSession({ events }),
    makeSessionConfig(logFile),
    false,
  );
  const emitted: ProviderEvent[] = [];
  session.onEvent((e) => emitted.push(e));
  const result = await session.waitForCompletion();
  return { events: emitted, result };
}

describe("PiMonoSession — empty final turn reprompt", () => {
  const STORE_PROGRESS_OUTPUT = '{"result":"ok"}';
  // Pi's thinking block; the text is a canary that must never reach a log line.
  const THINKING_CANARY = "private-reasoning-canary";

  function assistantEnd(
    content: unknown[],
    stopReason = "stop",
    usage?: { output: number },
  ): AgentSessionEvent {
    return {
      type: "message_end",
      message: { role: "assistant", content, stopReason, ...(usage ? { usage } : {}) },
    } as unknown as AgentSessionEvent;
  }

  const thinkingOnly = () => assistantEnd([{ type: "thinking", thinking: THINKING_CANARY }]);
  const emptyContent = () => assistantEnd([]);

  function toolStart(toolCallId: string, toolName: string, args: unknown): AgentSessionEvent {
    return { type: "tool_execution_start", toolCallId, toolName, args } as AgentSessionEvent;
  }

  function toolEnd(toolCallId: string, toolName: string, isError = false): AgentSessionEvent {
    return {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: {},
      isError,
    } as AgentSessionEvent;
  }

  async function runTurns(
    turns: AgentSessionEvent[][],
    extra: { throwOnCall?: number } = {},
  ): Promise<{ events: ProviderEvent[]; result: ProviderResult; promptCalls: string[] }> {
    const promptCalls: string[] = [];
    const logFile = join(
      tmpLogDir,
      `reprompt-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
    const session = new PiMonoSession(
      makeMockAgentSession({ turns, promptCalls, ...extra }),
      makeSessionConfig(logFile),
      false,
    );
    const events: ProviderEvent[] = [];
    session.onEvent((e) => events.push(e));
    const result = await session.waitForCompletion();
    return { events, result, promptCalls };
  }

  const stderrLines = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === "raw_stderr" ? [e.content] : []));

  // The final turn carries only a thinking block, or nothing at all. pi ends the
  // session cleanly on both, which left a schema-bound task without a result.
  test.each([
    ["a thinking-only", thinkingOnly],
    ["an empty-content", emptyContent],
  ])("%s final turn gets exactly one reprompt and output comes from the second turn", async (_, firstTurn) => {
    const { result, promptCalls } = await runTurns([
      [firstTurn()],
      [successMessageEnd(STORE_PROGRESS_OUTPUT)],
    ]);
    expect(promptCalls).toHaveLength(2);
    expect(promptCalls[0]).toBe("test prompt");
    expect(promptCalls[1]).toContain("no text and no tool call");
    expect(promptCalls[1]).toContain("store-progress");
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(STORE_PROGRESS_OUTPUT);
  });

  test("an empty turn that follows tool calls is reprompted too", async () => {
    const { result, promptCalls } = await runTurns([
      [
        assistantEnd([{ type: "toolCall", id: "t1", name: "get-task-details", arguments: {} }]),
        toolStart("t1", "get-task-details", {}),
        toolEnd("t1", "get-task-details"),
        assistantEnd([{ type: "toolCall", id: "t2", name: "memory-search", arguments: {} }]),
        toolStart("t2", "memory-search", {}),
        toolEnd("t2", "memory-search"),
        thinkingOnly(),
      ],
      [successMessageEnd(STORE_PROGRESS_OUTPUT)],
    ]);
    expect(promptCalls).toHaveLength(2);
    expect(result.output).toBe(STORE_PROGRESS_OUTPUT);
  });

  test("an empty final turn leaves a diagnostic with stopReason and block types, never content", async () => {
    const { events } = await runTurns([
      [assistantEnd([{ type: "thinking", thinking: THINKING_CANARY }], "stop", { output: 365 })],
      [successMessageEnd(STORE_PROGRESS_OUTPUT)],
    ]);
    const diagnostic = stderrLines(events).find((l) => l.includes("no text and no tool call ("));
    expect(diagnostic).toContain("stopReason=stop");
    expect(diagnostic).toContain("content=[thinking]");
    expect(diagnostic).toContain("outputTokens=365");
    expect(stderrLines(events).join("")).not.toContain(THINKING_CANARY);
  });

  test("a normal final text turn is not reprompted and emits no empty-turn diagnostic", async () => {
    const { events, result, promptCalls } = await runTurns([[successMessageEnd("All done")]]);
    expect(promptCalls).toEqual(["test prompt"]);
    expect(result.output).toBe("All done");
    expect(stderrLines(events)).toEqual([]);
  });

  test("a second empty turn after the reprompt is not reprompted again", async () => {
    const { result, promptCalls } = await runTurns([
      [thinkingOnly()],
      [emptyContent()],
      [thinkingOnly()],
    ]);
    expect(promptCalls).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBeUndefined();
  });

  // The reprompt asks for a store-progress call; after a terminal one has
  // succeeded the task is already finished, so another turn is wasted at best.
  test.each([
    "completed",
    "failed",
  ])("no reprompt after a successful terminal store-progress call (status %s)", async (status) => {
    const { promptCalls } = await runTurns([
      [
        toolStart("sp", "store-progress", { status }),
        toolEnd("sp", "store-progress"),
        emptyContent(),
      ],
    ]);
    expect(promptCalls).toHaveLength(1);
  });

  test.each([
    ["a progress-only call", { status: "in_progress" }, false],
    ["a terminal call the server rejected", { status: "completed" }, true],
  ])("still reprompts after %s", async (_, args, isError) => {
    const { promptCalls } = await runTurns([
      [
        toolStart("sp", "store-progress", args),
        toolEnd("sp", "store-progress", isError),
        emptyContent(),
      ],
      [successMessageEnd(STORE_PROGRESS_OUTPUT)],
    ]);
    expect(promptCalls).toHaveLength(2);
  });

  test("a final turn that ends in a tool call is not reprompted", async () => {
    const { promptCalls } = await runTurns([
      [
        assistantEnd(
          [{ type: "toolCall", id: "t1", name: "store-progress", arguments: {} }],
          "toolUse",
        ),
      ],
    ]);
    expect(promptCalls).toHaveLength(1);
  });

  test("an errored final turn fails the session without a reprompt", async () => {
    const { result, promptCalls } = await runTurns([
      [errorMessageEnd("provider returned error: 503")],
    ]);
    expect(promptCalls).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  test("an aborted final turn is not reprompted", async () => {
    const { promptCalls } = await runTurns([[assistantEnd([], "aborted")]]);
    expect(promptCalls).toHaveLength(1);
  });

  test("abort() before the final turn lands suppresses the reprompt", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptCalls: string[] = [];
    const session = new PiMonoSession(
      makeMockAgentSession({ turns: [[emptyContent()]], promptCalls, holdFirstPrompt: gate }),
      makeSessionConfig(join(tmpLogDir, `reprompt-abort-${Date.now()}.log`)),
      false,
    );
    await session.abort();
    release();
    await session.waitForCompletion();
    expect(promptCalls).toHaveLength(1);
  });

  // Workers render the nudge template over HTTP. abort() can land while that
  // request is pending, after the first guard check and before prompt().
  test("abort() while the reprompt template is rendering does not start a new turn", async () => {
    let releaseRender = () => {};
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let renderStarted = () => {};
    const renderRequested = new Promise<void>((resolve) => {
      renderStarted = resolve;
    });
    const realFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!String(input).endsWith("/api/prompt-templates/render")) return realFetch(input, init);
      renderStarted();
      await renderGate;
      return Response.json({ text: "Please call store-progress.", skipped: false, unresolved: [] });
    }) as unknown as typeof fetch);
    configureHttpResolver("http://resolver.test", "test-key");
    try {
      const promptCalls: string[] = [];
      const session = new PiMonoSession(
        makeMockAgentSession({ turns: [[emptyContent()]], promptCalls }),
        makeSessionConfig(join(tmpLogDir, `reprompt-abort-render-${Date.now()}.log`)),
        false,
      );
      const events: ProviderEvent[] = [];
      session.onEvent((e) => events.push(e));
      await renderRequested;
      await session.abort();
      releaseRender();
      await session.waitForCompletion();
      expect(promptCalls).toHaveLength(1);
      expect(stderrLines(events).some((l) => l.includes("sending one reprompt"))).toBe(false);
    } finally {
      resetHttpResolver();
      fetchSpy.mockRestore();
    }
  });

  test("a rejected reprompt keeps the original outcome instead of failing the session", async () => {
    const { events, result, promptCalls } = await runTurns([[thinkingOnly()]], { throwOnCall: 1 });
    expect(promptCalls).toHaveLength(2);
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stderrLines(events).some((l) => l.includes("empty-turn reprompt failed"))).toBe(true);
  });
});

describe("PiMonoSession.deliverSteering", () => {
  test("steer mode calls the native steer API", async () => {
    const steerCalls: string[] = [];
    const session = new PiMonoSession(
      makeMockAgentSession({ steerCalls }),
      makeSessionConfig(join(tmpLogDir, "steering-steer.log")),
      false,
    );

    await expect(
      session.deliverSteering({ mode: "steer", text: "Change the implementation approach." }),
    ).resolves.toEqual({ delivered: true, mode: "steer" });
    expect(steerCalls).toEqual(["Change the implementation approach."]);
    await session.waitForCompletion();
  });

  test("queue mode calls the native followUp API", async () => {
    const followUpCalls: string[] = [];
    const session = new PiMonoSession(
      makeMockAgentSession({ followUpCalls }),
      makeSessionConfig(join(tmpLogDir, "steering-queue.log")),
      false,
    );

    await expect(
      session.deliverSteering({ mode: "queue", text: "Continue with this additional context." }),
    ).resolves.toEqual({ delivered: true, mode: "queue" });
    expect(followUpCalls).toEqual(["Continue with this additional context."]);
    await session.waitForCompletion();
  });

  test("returns an undeliverable result when the pi SDK rejects steering", async () => {
    const session = new PiMonoSession(
      makeMockAgentSession({ steeringError: "pi steering rejected" }),
      makeSessionConfig(join(tmpLogDir, "steering-rejected.log")),
      false,
    );

    await expect(
      session.deliverSteering({ mode: "steer", text: "Try a different approach." }),
    ).resolves.toEqual({
      delivered: false,
      reason: "Error: pi steering rejected",
    });
    await session.waitForCompletion();
  });

  test("returns an undeliverable result after the session has completed", async () => {
    // followUp() on a finished AgentSession enqueues into a dead agent loop
    // without throwing — the liveness gate must fail closed so the server
    // promotes the message to a follow-up task instead.
    const followUpCalls: string[] = [];
    const session = new PiMonoSession(
      makeMockAgentSession({ followUpCalls }),
      makeSessionConfig(join(tmpLogDir, "steering-dead-session.log")),
      false,
    );
    await session.waitForCompletion();

    await expect(
      session.deliverSteering({ mode: "queue", text: "Too late for this run." }),
    ).resolves.toEqual({
      delivered: false,
      reason: "pi session already completed",
    });
    expect(followUpCalls).toEqual([]);
  });
});

function findError(events: ProviderEvent[]): Extract<ProviderEvent, { type: "error" }> | undefined {
  return events.find((e) => e.type === "error") as
    | Extract<ProviderEvent, { type: "error" }>
    | undefined;
}

describe("PiMonoSession — NON-retryable AWS auth via message_end stopReason:'error'", () => {
  // ORIGINAL-BUG REGRESSION TEST. AWS auth errors (ExpiredToken /
  // CredentialsProviderError) are non-retryable: pi's _isRetryableError regex
  // matches throttle/429/5xx/timeout but NOT auth tokens, so they never enter
  // the retry loop. The ONLY structured signal is a `message_end` assistant
  // turn with stopReason:'error'. This is the Commander's original silent-fail.
  test("ExpiredToken stopReason:'error' → type:error category aws-auth + terminal isError", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd(
        "ExpiredTokenException: The security token included in the request is expired",
      ),
    ]);
    const errorEvent = findError(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.category).toBe("aws-auth");
    expect(errorEvent?.message).toContain("aws sso login");
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("aws-auth");
    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toContain("aws sso login");
  });

  test("CredentialsProviderError stopReason:'error' → aws-auth terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("CredentialsProviderError: Could not load credentials from any providers"),
    ]);
    expect(findError(events)?.category).toBe("aws-auth");
    expect(result.errorCategory).toBe("aws-auth");
    expect(result.isError).toBe(true);
  });

  test("AccessDeniedException stopReason:'error' → aws-access terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("AccessDeniedException: not authorized to perform: bedrock:InvokeModel"),
    ]);
    expect(findError(events)?.category).toBe("aws-access");
    expect(result.errorCategory).toBe("aws-access");
  });

  test("ValidationException stopReason:'error' → aws-model terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd(
        "ValidationException: Invocation of model ID x with on-demand throughput isn't supported",
      ),
    ]);
    expect(findError(events)?.category).toBe("aws-model");
    expect(result.errorCategory).toBe("aws-model");
  });

  test("non-AWS stopReason:'error' → still terminal failure, no AWS category", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("Some unrecognized provider failure"),
    ]);
    const errorEvent = findError(events);
    // A terminal stopReason:'error' is a genuine failure by definition — it must
    // surface (no silent green), but it carries no AWS category.
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.category).toBeUndefined();
    expect(errorEvent?.message).toContain("Some unrecognized provider failure");
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("PiMonoSession — RETRYABLE failure via auto_retry_end success:false", () => {
  test("throttle finalError after exhausted retries → aws-throttle terminal failure", async () => {
    const { events, result } = await runWithEvents([
      // Each retry attempt also produces an errored message_end before retrying;
      // the definitive terminal marker is auto_retry_end success:false.
      errorMessageEnd("ThrottlingException: Rate exceeded"),
      autoRetryEnd(false, "ThrottlingException: Rate exceeded"),
    ]);
    const errorEvent = findError(events);
    expect(errorEvent?.category).toBe("aws-throttle");
    expect(result.errorCategory).toBe("aws-throttle");
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("5xx finalError (non-AWS) → terminal failure surfaced, no AWS category", async () => {
    const { events, result } = await runWithEvents([
      autoRetryEnd(false, "provider returned error: 503 service unavailable"),
    ]);
    expect(findError(events)).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("PiMonoSession — recovery clears the tracked error (no false failure)", () => {
  // The never-cleared-on-recovery false-fail bug the redesign eliminates.
  test("errored turn then successful auto_retry_end → success, output, no error", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("ThrottlingException: Rate exceeded"),
      autoRetryEnd(true),
      successMessageEnd("Recovered answer"),
    ]);
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Recovered answer");
  });

  test("errored turn then a later successful message_end → success, no error", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("ExpiredTokenException: token expired"),
      successMessageEnd("Final answer after creds refreshed"),
    ]);
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Final answer after creds refreshed");
  });

  test("clean success path emits a result event and no error", async () => {
    const { events, result } = await runWithEvents([successMessageEnd("All done")]);
    expect(findError(events)).toBeUndefined();
    expect(events.some((e) => e.type === "result")).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("All done");
  });
});

describe("PiMonoSession — thrown-exception catch path (defense-in-depth)", () => {
  // AWS failures arrive as events, not throws, but a genuine unexpected throw
  // (MCP/transport) must still fail the task; an AWS signature that reaches the
  // catch is still classified.
  async function runWithThrow(message: string) {
    const logFile = join(
      tmpLogDir,
      `throw-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
    const session = new PiMonoSession(
      makeMockAgentSession({ throwError: message }),
      makeSessionConfig(logFile),
      false,
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { events: emitted, result };
  }

  test("thrown ExpiredToken → aws-auth error event + terminal failure", async () => {
    const { events, result } = await runWithThrow(
      "ExpiredTokenException: The security token is expired",
    );
    expect(findError(events)?.category).toBe("aws-auth");
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("aws-auth");
  });

  test("thrown non-AWS error → no AWS category, still terminal failure", async () => {
    const { events, result } = await runWithThrow("ECONNREFUSED 127.0.0.1:3013");
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("classifyAwsSdkError — all 4 categories (quick summary)", () => {
  test("all four categories are reachable", () => {
    const cases: Array<[string, string]> = [
      ["ExpiredTokenException: token expired", "aws-auth"],
      ["ThrottlingException: rate exceeded", "aws-throttle"],
      ["AccessDeniedException: no permission", "aws-access"],
      ["ValidationException: bad model", "aws-model"],
    ];
    for (const [msg, expected] of cases) {
      const r = classifyAwsSdkError(msg);
      expect(r?.category).toBe(expected);
    }
  });
});

describe("PiMonoSession context-bound note", () => {
  /** An assistant `message_end` with this request usage; a tool call unless `final`. */
  function assistantTurn(usage: unknown, final = false): AgentSessionEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: final
          ? [{ type: "text", text: "Done" }]
          : [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        stopReason: final ? "stop" : "toolUse",
        usage,
      },
    } as unknown as AgentSessionEvent;
  }

  const usage = (input: number) => ({ input, cacheRead: 300, cacheWrite: 200, output: 50 });

  async function steersFor(
    threshold: string,
    events: AgentSessionEvent[],
    afterEvents: () => Promise<unknown> = () => Bun.sleep(50),
    model?: string,
  ): Promise<string[]> {
    const steerCalls: string[] = [];
    const session = new PiMonoSession(
      makeMockAgentSession({ events, steerCalls, afterEvents }),
      {
        ...makeSessionConfig(join(tmpLogDir, `bound-note-${crypto.randomUUID()}.log`)),
        env: { CONTEXT_BOUND_NOTE_TOKENS: threshold },
        ...(model ? { model } : {}),
      },
      false,
    );
    await session.waitForCompletion();
    return steerCalls;
  }

  test("steers the note once when a tool-call request reaches the threshold", async () => {
    const steers = await steersFor("1000", [
      assistantTurn(usage(400)),
      assistantTurn(usage(500)),
      assistantTurn(usage(900)),
      assistantTurn(usage(1500), true),
    ]);
    // 500 + 300 + 200 reaches 1000; the larger later request does not steer again.
    expect(steers).toEqual([await renderContextBoundNote(1000)]);
  });

  test("the note shows the window share for a known model and omits it for an unknown one", async () => {
    const events = () => [assistantTurn(usage(209_500)), assistantTurn(usage(400), true)];
    const rest =
      "Keep this task bounded: finish the current step, store-progress, and complete or defer instead of starting new exploration.";
    expect(await steersFor("200000", events(), undefined, "anthropic/claude-sonnet-4-6")).toEqual([
      `Context is 210,000 tokens (21% of the 1,000,000-token window). ${rest}`,
    ]);
    expect(await steersFor("200000", events(), undefined, "made-up/model")).toEqual([
      `Context is 210,000 tokens. ${rest}`,
    ]);
  });

  test("no-op below the threshold and when disabled at 0", async () => {
    const events = [assistantTurn(usage(400)), assistantTurn(usage(400), true)];
    expect(await steersFor("1000", events)).toEqual([]);
    expect(await steersFor("0", events)).toEqual([]);
  });

  test("fails open on missing or corrupt usage", async () => {
    const events = [
      assistantTurn(undefined),
      assistantTurn({ input: "lots", cacheRead: {}, cacheWrite: null }),
      assistantTurn(undefined, true),
    ];
    expect(await steersFor("1", events)).toEqual([]);
  });

  test("never steers after the final reply, which would start another turn", async () => {
    expect(await steersFor("1", [assistantTurn(usage(5000), true)])).toEqual([]);
  });

  test("a note rendered after its tool turn ended is dropped", async () => {
    const turnEnd = { type: "turn_end" } as unknown as AgentSessionEvent;
    const lateSteers = async (events: AgentSessionEvent[]) => {
      const held = holdTemplateRender();
      try {
        return await steersFor("1", events, async () => {
          held.release();
          await Bun.sleep(50);
        });
      } finally {
        held.stop();
      }
    };
    // Pi already read steering for that turn; the next reply could be the final one.
    expect(await lateSteers([assistantTurn(usage(5000)), turnEnd])).toEqual([]);
    // Control: ready while the tool turn is still running.
    expect(await lateSteers([assistantTurn(usage(5000))])).toEqual([HELD_NOTE_TEXT]);
  });
});
