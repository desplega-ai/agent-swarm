import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeModelKey } from "../be/pricing-normalize";
import { buildPricingSeedRows } from "../be/seed-pricing";
import { createProviderAdapter } from "../providers";
import {
  FX_SYSTEM_PROMPT_HEAD_BYTES,
  FX_SYSTEM_PROMPT_INLINE_MAX_BYTES,
  fxRunDir,
  fxSessionExists,
  fxSystemPrompt,
  fxTargetProfile,
  rewriteFxEvent,
  steerFx,
} from "../providers/acp-targets";
import {
  checkFxCredentials,
  ensureFxSettings,
  FxAdapter,
  mergeFxSettings,
} from "../providers/fx-adapter";
import type { ProviderEvent, ProviderSession, ProviderSessionConfig } from "../providers/types";
import { PROVIDER_STEER_CAPABILITIES } from "../types";
import { getModelAwareCredentialVars } from "../utils/credentials";
import { requireFxRoute, resolveFxRoute } from "../utils/fx-models";

/**
 * Recorded from a live `fx acp` session (fx 0.0.15, openrouter/openai/gpt-5-mini,
 * 2026-10-29) running a prompt that calls the swarm MCP `get-swarm` and a
 * shell command, with one mid-turn steer. Consecutive message and
 * thought chunks are merged, long strings trimmed, ids and paths scrubbed.
 */
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "fx");
const FAKE_FX = join(import.meta.dir, "fixtures", "fake-fx.ts");

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-swarm-fx-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let taskCounter = 0;

function baseConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  taskCounter += 1;
  return {
    prompt: "how many agents?",
    systemPrompt: "You are a swarm worker.",
    model: "openrouter/openai/gpt-5-mini",
    role: "worker",
    agentId: "agent-1",
    taskId: `fx-test-${process.pid}-${taskCounter}`,
    apiUrl: "http://swarm.example",
    apiKey: "api-key",
    cwd: makeTempDir(),
    logFile: "/tmp/fx.log",
    env: { PATH: process.env.PATH ?? "", HOME: makeTempDir() },
    ...overrides,
  };
}

interface ApiStub {
  server: Server;
  /** Resolves once the adapter revoked the session token it minted. */
  revoked: Promise<void>;
  /** Reachable but not an fx loopback name, so the adapter forwards MCP through 127.0.0.1. */
  apiUrl: string;
  mcpRequests: Array<{ authorization: string | undefined; agentId: string | undefined }>;
}

async function startApiStub(): Promise<ApiStub> {
  const mcpRequests: ApiStub["mcpRequests"] = [];
  let markRevoked!: () => void;
  const revoked = new Promise<void>((resolve) => {
    markRevoked = resolve;
  });
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/sessions/tokens") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tokenId: "tok-1", plaintext: "aseph_fxstubtoken1234567890" }));
    } else if (req.method === "POST" && req.url === "/mcp") {
      mcpRequests.push({
        authorization: req.headers.authorization,
        agentId: req.headers["x-agent-id"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    } else if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      markRevoked();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  // 0.0.0.0 reaches the 127.0.0.1 listener on Linux, but fx would reject it
  // as an MCP URL, like `http://api:3013` in Docker.
  return { server, revoked, apiUrl: `http://0.0.0.0:${port}`, mcpRequests };
}

/**
 * A fake `fx` executable: a shell wrapper around `fixtures/fake-fx.ts`. The
 * adapter passes fx an env allowlist, so the fake's own settings ride in the
 * wrapper instead.
 */
async function fakeFxBinary(
  mode: "ok" | "steer-ignored" | "wait-for-cancel" = "ok",
  mcpCall = false,
): Promise<string> {
  const binPath = join(makeTempDir(), "fx");
  const fakeEnv = [
    `FAKE_FX_FIXTURE_DIR=${JSON.stringify(FIXTURE_DIR)}`,
    `FAKE_FX_MODE=${mode}`,
    `FAKE_FX_MCP_CALL=${mcpCall ? "1" : "0"}`,
  ].join(" ");
  await Bun.write(binPath, `#!/bin/sh\nexec env ${fakeEnv} bun ${JSON.stringify(FAKE_FX)} "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

function fxEnv(
  binary: string,
  extra: Record<string, string> = {},
  home: string = makeTempDir(),
): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, FX_BINARY: binary, ...extra };
}

interface Capture {
  argv: string[];
  env: Record<string, string>;
  settings: Record<string, unknown> | null;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  mcpCall?: { url: string; status: number };
  childPid?: number;
}

/** The fake rewrites capture.json as requests arrive, so retry a read that lands mid-write. */
async function readCapture(cwd: string): Promise<Capture> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return JSON.parse(await Bun.file(join(cwd, "capture.json")).text());
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

function collect(session: ProviderSession): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  session.onEvent((event) => events.push(event));
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the fake fx");
    await Bun.sleep(10);
  }
}

/** Close the stub once the token revoke landed (bounded, so a failed test still tears down). */
async function closeStub(stub: ApiStub): Promise<void> {
  await Promise.race([stub.revoked, Bun.sleep(3_000)]);
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
}

describe("FxAdapter registration", () => {
  test("is the fx provider on the ACP client, with steer only", async () => {
    const adapter = await createProviderAdapter("fx");
    expect(adapter).toBeInstanceOf(FxAdapter);
    expect(adapter.name).toBe("fx");
    expect(adapter.traits).toMatchObject({
      hasMcp: true,
      hasLocalEnvironment: true,
      nativeSkillDiscovery: true,
      steerModes: ["steer"],
    });
    expect(adapter.traits.steerModes).toEqual(PROVIDER_STEER_CAPABILITIES.fx);
  });

  test("credential readiness needs one of the three route keys", () => {
    expect(checkFxCredentials({})).toMatchObject({
      ready: false,
      missing: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"],
    });
    expect(checkFxCredentials({ OPENROUTER_API_KEY: " " }).ready).toBe(false);
    for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"]) {
      expect(checkFxCredentials({ [key]: "k" })).toMatchObject({ ready: true, satisfiedBy: "env" });
    }
  });
});

describe("fx model routes", () => {
  test("each route names its fx provider, model and key", () => {
    expect(resolveFxRoute("openrouter/deepseek/deepseek-v4.1-flash")).toEqual({
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      fxProvider: "openrouter",
      fxModel: "deepseek/deepseek-v4.1-flash",
      keyVar: "OPENROUTER_API_KEY",
    });
    expect(resolveFxRoute("vercel/anthropic/claude-opus-5.5")).toEqual({
      model: "vercel/anthropic/claude-opus-5.5",
      fxProvider: "gateway",
      fxModel: "anthropic/claude-opus-5.5",
      keyVar: "AI_GATEWAY_API_KEY",
    });
    expect(resolveFxRoute("gpt-5-mini")).toEqual({
      model: "gpt-5-mini",
      fxProvider: "openai",
      fxModel: "gpt-5-mini",
      keyVar: "OPENAI_API_KEY",
    });
    // No model means the regular tier default.
    expect(resolveFxRoute("")).toMatchObject({
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      fxProvider: "openrouter",
    });
  });

  test("nan/, helmcode/ and anthropic/ are rejected with a reason", () => {
    expect(() => requireFxRoute("nan/glm5.3-flash")).toThrow("InconsistentFinishReason");
    expect(() => requireFxRoute("helmcode/qwen3.6")).toThrow("Helmcode is not verified on fx");
    expect(() => requireFxRoute("anthropic/claude-opus-5-5")).toThrow("Anthropic Messages API");
  });

  test("the credential pool picks the key the model's route bills", () => {
    expect(getModelAwareCredentialVars("fx", "openrouter/openai/gpt-5-mini")).toEqual([
      "OPENROUTER_API_KEY",
    ]);
    expect(getModelAwareCredentialVars("fx", "vercel/openai/gpt-5-mini")).toEqual([
      "AI_GATEWAY_API_KEY",
    ]);
    expect(getModelAwareCredentialVars("fx", "gpt-5-mini")).toEqual(["OPENAI_API_KEY"]);
    expect(getModelAwareCredentialVars("fx")).toEqual([
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "AI_GATEWAY_API_KEY",
    ]);
  });

  test("each route's session env carries only that route's key", () => {
    const keys = {
      OPENROUTER_API_KEY: "or-k",
      OPENAI_API_KEY: "oa-k",
      AI_GATEWAY_API_KEY: "gw-k",
      ANTHROPIC_API_KEY: "must-not-leak",
      XAI_API_KEY: "must-not-leak",
    };
    const cases = [
      ["openrouter/openai/gpt-5-mini", "openrouter", "OPENROUTER_API_KEY"],
      ["gpt-5-mini", "openai", "OPENAI_API_KEY"],
      ["vercel/openai/gpt-5-mini", "gateway", "AI_GATEWAY_API_KEY"],
    ] as const;
    for (const [model, fxProvider, keyVar] of cases) {
      const config = baseConfig({ model, env: { PATH: "/bin", HOME: "/home/w", ...keys } });
      const env = fxTargetProfile.env(config);
      expect(env).toMatchObject({
        PATH: "/bin",
        HOME: "/home/w",
        [keyVar]: keys[keyVar],
        FX_PROVIDER: fxProvider,
        FX_PERMISSION_MODE: "full-access",
        FX_AUTO_UPGRADE: "0",
        FX_NO_OPEN_BROWSER: "1",
      });
      expect(Object.keys(env).filter((name) => name.endsWith("_API_KEY"))).toEqual([keyVar]);
    }
  });

  test("effort is set only on the AI Gateway route; mode, provider and model never", () => {
    const gateway = baseConfig({ model: "vercel/openai/gpt-5-mini", reasoningEffort: "high" });
    expect(fxTargetProfile.configuredOptions(gateway)).toEqual({ effort: "high" });
    expect(
      fxTargetProfile.configuredOptions(
        baseConfig({ model: "openrouter/openai/gpt-5-mini", reasoningEffort: "high" }),
      ),
    ).toEqual({});
    expect(fxTargetProfile.configuredOptions(baseConfig({ model: "gpt-5-mini" }))).toEqual({});
  });

  test("pricing strips the route prefix and fx has rows on every route", () => {
    expect(normalizeModelKey("fx", "openrouter/openai/gpt-5-mini")).toBe("openai/gpt-5-mini");
    expect(normalizeModelKey("fx", "vercel/acme/gateway-only")).toBe("acme/gateway-only");
    expect(normalizeModelKey("fx", "gpt-5-mini")).toBe("gpt-5-mini");
    const rows = buildPricingSeedRows({
      openai: { models: { "gpt-5-mini": { cost: { input: 0.25, output: 2 } } } },
      openrouter: { models: { "openai/gpt-5-mini": { cost: { input: 0.25, output: 2 } } } },
      vercel: {
        models: {
          "openai/gpt-5-mini": { cost: { input: 9, output: 9 } },
          "acme/gateway-only": { cost: { input: 1, output: 3 } },
        },
      },
    }).filter((row) => row.provider === "fx" && row.tokenClass === "input");
    expect(Object.fromEntries(rows.map((row) => [row.model, row.pricePerMillionUsd]))).toEqual({
      "gpt-5-mini": 0.25,
      // OpenRouter's row wins where both list the model.
      "openai/gpt-5-mini": 0.25,
      "acme/gateway-only": 1,
    });
  });
});

describe("fx settings", () => {
  const route = requireFxRoute("openrouter/openai/gpt-5-mini");

  test("merges the swarm connections and keeps every user key", () => {
    const user = {
      provider: "gateway",
      theme: "dark",
      providers: {
        local: { protocol: "openai-chat-completions", base_url: "http://localhost:11434/v1" },
        openrouter: {
          base_url: "https://stale.example/v1",
          tool_choice_mode: "send",
          model_metadata: { "openai/gpt-5-mini": { context_window: 1234 } },
        },
      },
      workspaces: { "/repo": { max_agent_steps: 80 } },
    };
    const merged = mergeFxSettings(user, {
      route,
      contextWindow: 400_000,
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
    });
    expect(merged).toEqual({
      provider: "gateway",
      theme: "dark",
      providers: {
        local: user.providers.local,
        openrouter: {
          base_url: "https://openrouter.ai/api/v1",
          tool_choice_mode: "send",
          // An existing entry for the model wins.
          model_metadata: { "openai/gpt-5-mini": { context_window: 1234 } },
          protocol: "openai-chat-completions",
          auth: { type: "bearer", env: "OPENROUTER_API_KEY" },
        },
        openai: {
          protocol: "openai-chat-completions",
          base_url: "https://api.openai.com/v1",
          auth: { type: "bearer", env: "OPENAI_API_KEY" },
        },
      },
      workspaces: user.workspaces,
      auto_upgrade: false,
      session_titles: false,
    });
    // The input is not mutated.
    expect(user.providers.openrouter.base_url).toBe("https://stale.example/v1");
  });

  test("writes atomically, names key vars only, and is idempotent", async () => {
    const home = makeTempDir();
    const input = {
      home,
      route,
      contextWindow: 400_000,
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
    };
    const first = await ensureFxSettings(input);
    expect(first.changed).toBe(true);
    const text = await Bun.file(first.path).text();
    const settings = JSON.parse(text);
    expect(settings.providers.openrouter.model_metadata).toEqual({
      "openai/gpt-5-mini": { context_window: 400_000 },
    });
    expect(text).not.toContain("sk-");
    expect((await Bun.file(first.path).stat()).mode & 0o777).toBe(0o600);
    const second = await ensureFxSettings(input);
    expect(second.changed).toBe(false);
    expect(await Bun.file(first.path).text()).toBe(text);
    // No temp file is left behind.
    expect(readdirSync(join(home, ".fx"))).toEqual(["settings.json"]);
  });

  test("refuses to overwrite a settings file that is not a JSON object", async () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".fx"));
    const path = join(home, ".fx", "settings.json");
    await Bun.write(path, "{ not json");
    await expect(
      ensureFxSettings({ home, route, openRouterBaseUrl: "https://openrouter.ai/api/v1" }),
    ).rejects.toThrow("is not valid JSON");
    expect(await Bun.file(path).text()).toBe("{ not json");
  });
});

describe("fx system prompt", () => {
  test("up to 60 KiB goes inline", async () => {
    const dir = join(makeTempDir(), "run");
    const prompt = "é".repeat(FX_SYSTEM_PROMPT_INLINE_MAX_BYTES / 2);
    expect(await fxSystemPrompt(prompt, dir)).toEqual({ blocks: [{ type: "text", text: prompt }] });
    expect(existsSync(join(dir, "SYSTEM.md"))).toBe(false);
    expect(await fxSystemPrompt("  ", dir)).toBeUndefined();
  });

  test("over 60 KiB sends the first 56 KiB plus a pointer to the full file", async () => {
    const dir = join(makeTempDir(), "run");
    // A two-byte character straddles the 56 KiB cut.
    const prompt = `a${"é".repeat(40_000)}TAIL-MARKER`;
    const plan = await fxSystemPrompt(prompt, dir);
    const artifactPath = join(dir, "SYSTEM.md");
    expect(plan?.artifactPath).toBe(artifactPath);
    expect(await Bun.file(artifactPath).text()).toBe(prompt);
    const block = plan?.blocks[0];
    const text = block?.type === "text" ? block.text : "";
    const [head, pointer] = text.split("\n\n");
    expect(new TextEncoder().encode(head).length).toBeLessThanOrEqual(FX_SYSTEM_PROMPT_HEAD_BYTES);
    expect(new TextEncoder().encode(head).length).toBeGreaterThan(FX_SYSTEM_PROMPT_HEAD_BYTES - 2);
    expect(head).not.toContain("�");
    expect(prompt.startsWith(head ?? "")).toBe(true);
    expect(pointer).toContain(`Read ${artifactPath} before you start`);
    expect(new TextEncoder().encode(text).length).toBeLessThan(64 * 1024);
  });
});

describe("fx events and steering", () => {
  test("the [context] notice becomes a custom event; tool starts carry fx's tool name", () => {
    expect(
      rewriteFxEvent({
        type: "message",
        role: "assistant",
        content: "[context] 114 always-loaded MCP tools exceeded the budget",
        messageId: "m1",
      }),
    ).toEqual({
      type: "custom",
      name: "fx_context_notice",
      data: { text: "[context] 114 always-loaded MCP tools exceeded the budget", messageId: "m1" },
    });
    const plain = { type: "message", role: "assistant", content: "[context] is fine" } as const;
    expect(rewriteFxEvent({ ...plain, content: "Hello" })).toEqual({ ...plain, content: "Hello" });
    const start = { type: "tool_start", toolCallId: "t", toolName: "Running", args: {} } as const;
    expect(
      rewriteFxEvent(start, {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Running",
        name: "shell",
      } as never),
    ).toEqual({ ...start, toolName: "shell" });
    expect(
      rewriteFxEvent(start, {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Get the agent swarm",
        name: "mcp_swarm_get-swarm",
        _meta: { fx: { toolCall: { mcp: { server: "swarm", tool: "get-swarm" } } } },
      } as never),
    ).toEqual({ ...start, toolName: "mcp__swarm__get-swarm" });
  });

  test("steering needs the advertised capability and the steer mode", async () => {
    const prompt = () => Promise.reject(new Error("must not be called"));
    const context = {
      sessionId: "s",
      prompt,
      onUpdate: () => () => {},
    };
    expect(
      await steerFx({
        ...context,
        delivery: { mode: "steer", text: "x" },
        initResult: { protocolVersion: 1 },
      }),
    ).toEqual({ delivered: false, reason: "fx did not advertise _meta.fx.steering" });
    expect(
      await steerFx({
        ...context,
        delivery: { mode: "queue", text: "x" },
        initResult: {
          protocolVersion: 1,
          agentCapabilities: { _meta: { fx: { steering: true } } },
        },
      }),
    ).toEqual({ delivered: false, reason: "fx supports steer only, not queue" });
  });
});

describe("FxAdapter sessions", () => {
  test("runs a recorded session: loopback MCP, system prompt, steer, usage, no mode writes", async () => {
    const fx = await fakeFxBinary("ok", true);
    const stub = await startApiStub();
    try {
      const home = makeTempDir();
      const config = baseConfig({
        apiUrl: stub.apiUrl,
        env: fxEnv(
          fx,
          {
            OPENROUTER_API_KEY: "or-test-key",
            OPENAI_API_KEY: "must-not-leak",
            ANTHROPIC_API_KEY: "must-not-leak",
          },
          home,
        ),
      });
      const session = await new FxAdapter().createSession(config);
      const events = collect(session);
      const getSwarmDone = () =>
        events.some(
          (e) => e.type === "tool_end" && e.toolCallId === "call_kK1rqCaYaXn16uKH9e6fmb7v",
        );
      await waitFor(getSwarmDone);
      expect(session.deliverSteering).toBeDefined();
      const steer = await session.deliverSteering!({ mode: "steer", text: "Also say STEERED." });
      expect(steer).toEqual({ delivered: true, mode: "steer" });
      const result = await session.waitForCompletion();

      expect(result.isError).toBe(false);
      // The [context] notice is not task output.
      expect(result.output).not.toContain("[context]");
      expect(result.output).toContain("STEERED BANANA");
      expect(
        events.find((e) => e.type === "custom" && e.name === "fx_context_notice"),
      ).toBeDefined();
      expect(result.cost).toMatchObject({
        provider: "fx",
        model: "openrouter/openai/gpt-5-mini",
        inputTokens: 58620,
        outputTokens: 1183,
        totalCostUsd: 0,
      });
      expect(events.find((e) => e.type === "session_init")).toMatchObject({
        provider: "fx",
        sessionId: "fxSession001",
        harnessVariantMeta: { version: "0.0.15" },
      });
      expect(
        events
          .filter((e) => e.type === "tool_start")
          .map((e) => e.type === "tool_start" && e.toolName),
      ).toEqual(["mcp__swarm__get-swarm", "shell"]);
      expect(events.find((e) => e.type === "context_usage")).toMatchObject({
        contextUsedTokens: 20196,
        contextTotalTokens: 400000,
      });
      // The steer echo carries the delivered text.
      expect(
        events.some(
          (e) => e.type === "message" && e.role === "user" && e.content === "Also say STEERED.",
        ),
      ).toBe(true);

      const capture = await readCapture(config.cwd);
      expect(capture.argv).toEqual([
        "acp",
        "--model",
        "openai/gpt-5-mini",
        "--log-file",
        join(fxRunDir(config), "acp.log"),
      ]);
      // Only the route's key crosses the env allowlist, next to fx's own switches.
      expect(capture.env).toEqual({
        OPENROUTER_API_KEY: "or-test-key",
        FX_PROVIDER: "openrouter",
        FX_PERMISSION_MODE: "full-access",
        FX_AUTO_UPGRADE: "0",
        FX_NO_OPEN_BROWSER: "1",
      });
      const methods = capture.requests.map((r) => r.method);
      expect(methods).toEqual(["initialize", "session/new", "session/prompt", "session/prompt"]);
      const newSession = capture.requests[1]!.params as {
        systemPrompt: unknown;
        mcpServers: Array<{ name: string; url: string }>;
      };
      expect(newSession.systemPrompt).toEqual([{ type: "text", text: "You are a swarm worker." }]);
      // fx rejects http://<non-loopback>/mcp, so the swarm MCP goes through a 127.0.0.1 forwarder.
      const swarm = newSession.mcpServers.find((s) => s.name === "swarm");
      expect(swarm?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(capture.mcpCall).toMatchObject({ status: 200 });
      expect(stub.mcpRequests).toEqual([
        { authorization: "Bearer aseph_fxstubtoken1234567890", agentId: "agent-1" },
      ]);
      const steerRequest = capture.requests[3]!.params as { _meta: unknown };
      expect(steerRequest._meta).toEqual({ fx: { steer: true } });
      // The settings file names the key's env var, never its value.
      expect(capture.settings).toMatchObject({
        providers: {
          openrouter: {
            auth: { type: "bearer", env: "OPENROUTER_API_KEY" },
            model_metadata: { "openai/gpt-5-mini": { context_window: expect.any(Number) } },
          },
        },
        auto_upgrade: false,
        session_titles: false,
      });
      expect(JSON.stringify(capture.settings)).not.toContain("or-test-key");

      // The forwarder and the per-task run dir are gone once the session settles.
      await Bun.sleep(50);
      await expect(fetch(swarm!.url, { method: "POST", body: "{}" })).rejects.toThrow();
      expect(existsSync(fxRunDir(config))).toBe(false);
    } finally {
      await closeStub(stub);
    }
  });

  test("a steer fx does not absorb is undeliverable", async () => {
    const fx = await fakeFxBinary("steer-ignored");
    const stub = await startApiStub();
    try {
      const config = baseConfig({
        apiUrl: stub.apiUrl,
        env: fxEnv(fx, { OPENROUTER_API_KEY: "k" }),
      });
      const session = await new FxAdapter().createSession(config);
      const events = collect(session);
      await waitFor(() => events.some((e) => e.type === "tool_end"));
      const steer = await session.deliverSteering!({ mode: "steer", text: "ignored" });
      expect(steer).toMatchObject({ delivered: false });
      expect(steer.delivered === false && steer.reason).toContain("fx did not absorb the steer");
      await session.waitForCompletion();
      expect(await session.deliverSteering!({ mode: "steer", text: "too late" })).toEqual({
        delivered: false,
        reason: "The ACP session has already finished",
      });
    } finally {
      await closeStub(stub);
    }
  });

  test("an oversized system prompt is sent cut, with the full prompt on disk", async () => {
    const fx = await fakeFxBinary();
    const stub = await startApiStub();
    try {
      const systemPrompt = `${"x".repeat(FX_SYSTEM_PROMPT_INLINE_MAX_BYTES)}END`;
      const config = baseConfig({
        apiUrl: stub.apiUrl,
        systemPrompt,
        env: fxEnv(fx, { OPENROUTER_API_KEY: "k" }),
      });
      const session = await new FxAdapter().createSession(config);
      const capture = await readCapture(config.cwd);
      const sent = (capture.requests[1]!.params.systemPrompt as Array<{ text: string }>)[0]!.text;
      const artifact = join(fxRunDir(config), "SYSTEM.md");
      expect(sent).toContain(`Read ${artifact} before you start`);
      expect(sent).not.toContain("END");
      expect(await Bun.file(artifact).text()).toBe(systemPrompt);
      await session.waitForCompletion();
      await Bun.sleep(50);
      expect(existsSync(artifact)).toBe(false);
    } finally {
      await closeStub(stub);
    }
  });

  test("resumes a saved session with session/resume instead of session/new", async () => {
    const fx = await fakeFxBinary();
    const stub = await startApiStub();
    try {
      const home = makeTempDir();
      const config = baseConfig({
        apiUrl: stub.apiUrl,
        resumeSessionId: "fxSession001",
        env: fxEnv(fx, { OPENROUTER_API_KEY: "k" }, home),
      });
      const session = await new FxAdapter().createSession(config);
      expect(session.sessionId).toBe("fxSession001");
      await session.waitForCompletion();
      const capture = await readCapture(config.cwd);
      expect(capture.requests.map((r) => r.method)).toEqual([
        "initialize",
        "session/resume",
        "session/prompt",
      ]);
      expect(capture.requests[1]!.params).toMatchObject({
        sessionId: "fxSession001",
        cwd: config.cwd,
        mcpServers: [expect.objectContaining({ name: "swarm" })],
      });
      expect(capture.requests[1]!.params.systemPrompt).toBeUndefined();

      const adapter = new FxAdapter({ home });
      expect(await adapter.canResume("fxSession001")).toBe(false);
      mkdirSync(join(home, ".fx", "sessions", "v2", "fxSession001"), { recursive: true });
      await Bun.write(join(home, ".fx", "sessions", "v2", "fxSession001", "log.jsonl"), "{}\n");
      expect(await adapter.canResume("fxSession001")).toBe(true);
      expect(await adapter.canResume("../escape")).toBe(false);
      expect(await fxSessionExists("fxSession001", undefined)).toBe(false);
    } finally {
      await closeStub(stub);
    }
  });

  test("an abort cancels the turn, keeps its usage and kills fx's process tree", async () => {
    const fx = await fakeFxBinary("wait-for-cancel");
    const stub = await startApiStub();
    try {
      const config = baseConfig({
        apiUrl: stub.apiUrl,
        env: fxEnv(fx, { OPENROUTER_API_KEY: "k" }),
      });
      const session = await new FxAdapter().createSession(config);
      let childPid: number | undefined;
      await waitFor(() => {
        try {
          const text = readFileSync(join(config.cwd, "capture.json"), "utf8");
          childPid = JSON.parse(text).childPid;
        } catch {
          // Not written yet.
        }
        return !!childPid;
      });
      await session.abort();
      const result = await session.waitForCompletion();
      expect(result.isError).toBe(true);
      expect(result.cost).toMatchObject({ inputTokens: 1200, outputTokens: 30 });
      const capture = await readCapture(config.cwd);
      expect(capture.requests.map((r) => r.method)).toContain("session/cancel");
      const deadline = Date.now() + 5_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(childPid!, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await closeStub(stub);
    }
  });

  test("refuses a model with no fx route, and a route without its key", async () => {
    await expect(
      new FxAdapter().createSession(baseConfig({ model: "nan/glm5.3-flash" })),
    ).rejects.toThrow("InconsistentFinishReason");
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        new FxAdapter().createSession(
          baseConfig({
            model: "gpt-5-mini",
            env: { PATH: process.env.PATH ?? "", HOME: makeTempDir(), OPENROUTER_API_KEY: "k" },
          }),
        ),
      ).rejects.toThrow("fx requires OPENAI_API_KEY for gpt-5-mini");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
