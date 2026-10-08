import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionLogs } from "../../apps/ui/src/logs-parser";
import { createProviderAdapter } from "../providers";
import { ACPAdapter } from "../providers/acp-adapter";
import {
  GROK_ISOLATION_ENV,
  grokPromptCost,
  grokReportedModel,
  grokTargetProfile,
  resolveAcpTarget,
} from "../providers/acp-targets";
import {
  buildGrokConfigToml,
  checkGrokCredentials,
  GrokAdapter,
  grokOpenRouterModel,
  installedClaudePluginNames,
} from "../providers/grok-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { getModelAwareCredentialVars } from "../utils/credentials";

/**
 * Recorded from a live `grok agent stdio` session (Grok CLI 1.0.46,
 * grok-build-0.1) running a swarm task that calls get-swarm and
 * store-progress. Long strings are trimmed; `available_commands_update` is
 * dropped. The prompt response carries Grok's usage in `_meta`.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "grok", "acp-updates-recorded.jsonl");
const PROMPT_META = join(import.meta.dir, "fixtures", "grok", "prompt-response-meta.json");
const SDK_PATH = join(process.cwd(), "node_modules/@agentclientprotocol/sdk/dist/acp.js");

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-swarm-grok-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "how many agents?",
    systemPrompt: "You are a swarm worker.",
    model: "grok-4.6",
    role: "worker",
    agentId: "agent-1",
    taskId: "task-1",
    apiUrl: "http://swarm.example",
    apiKey: "api-key",
    cwd: makeTempDir(),
    logFile: "/tmp/grok.log",
    env: { PATH: process.env.PATH ?? "", HOME: makeTempDir() },
    ...overrides,
  };
}

async function startTokenStub(): Promise<{ server: Server; apiUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/sessions/tokens") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tokenId: "tok-1", plaintext: "aseph_grokstubtoken1234567890" }));
    } else if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  return { server, apiUrl: `http://127.0.0.1:${port}` };
}

/**
 * A fake `grok` executable: a shell wrapper around a bun ACP agent. It records
 * its argv, the isolation env, the files in GROK_HOME and the `session/new`
 * params into `capture.json` in its cwd, then replays the fixture.
 */
/**
 * The recorded prompt `_meta` plus a side-model call: a second `modelUsage`
 * entry (grok-4.3) folded into the cumulative totals, the shape Grok sends
 * when a fallback or side model runs inside one prompt.
 */
function promptMetaWithSideModel(dir: string): string {
  const meta = JSON.parse(readFileSync(PROMPT_META, "utf8"));
  const side = {
    inputTokens: 2000,
    outputTokens: 40,
    totalTokens: 2050,
    cachedReadTokens: 500,
    cacheCreationTokens: 0,
    reasoningTokens: 10,
    modelCalls: 1,
    costUsdTicks: 20000000,
  };
  for (const key of Object.keys(side) as (keyof typeof side)[]) meta.usage[key] += side[key];
  meta.usage.modelUsage["grok-4.3"] = side;
  const path = join(dir, "prompt-meta-two-models.json");
  writeFileSync(path, JSON.stringify(meta));
  return path;
}

function writeFakeGrok(
  dir: string,
  mode: "ok" | "auth-required" | "wait-for-cancel",
  promptMeta = PROMPT_META,
): string {
  const agentPath = join(dir, "fake-grok-agent.ts");
  writeFileSync(
    agentPath,
    `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "${SDK_PATH}";
const home = process.env.GROK_HOME ?? "";
const read = (name) => (existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : null);
const capture = {
  argv: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GROK_|XAI_|OPENROUTER_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(k))),
  configToml: read("config.toml"),
  requirementsToml: read("requirements.toml"),
};
class FakeGrok {
  constructor(connection) { this.connection = connection; }
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [{ id: "grok.com", name: "grok.com" }] };
  }
  async newSession(params) {
    capture.newSession = { meta: params._meta ?? null, mcpServers: params.mcpServers.map((s) => s.name) };
    writeFileSync("capture.json", JSON.stringify(capture));
    if (${JSON.stringify(mode)} === "auth-required") throw RequestError.authRequired();
    return { sessionId: "grok-session-1" };
  }
  async prompt(params) {
    for (const line of readFileSync(${JSON.stringify(FIXTURE)}, "utf8").trim().split("\\n")) {
      await this.connection.sessionUpdate({ sessionId: params.sessionId, update: JSON.parse(line) });
    }
    if (${JSON.stringify(mode)} === "wait-for-cancel") await new Promise((resolve) => { this.cancelled = resolve; });
    // Grok sends no ACP \`usage\`; its usage rides in \`_meta\`.
    const stopReason = ${JSON.stringify(mode)} === "wait-for-cancel" ? "cancelled" : "end_turn";
    return { stopReason, _meta: JSON.parse(readFileSync(${JSON.stringify(promptMeta)}, "utf8")) };
  }
  async cancel() { this.cancelled?.(); }
}
new AgentSideConnection((c) => new FakeGrok(c), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`,
  );
  const binPath = join(dir, "grok");
  writeFileSync(binPath, `#!/bin/sh\nexec bun ${JSON.stringify(agentPath)} "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("GrokAdapter", () => {
  test("is the grok provider on the ACP client, with no steering", async () => {
    const adapter = await createProviderAdapter("grok");
    expect(adapter).toBeInstanceOf(GrokAdapter);
    expect(adapter.name).toBe("grok");
    expect(adapter.traits.hasMcp).toBe(true);
    expect(adapter.traits.steerModes).toEqual([]);
    expect(await adapter.canResume("any")).toBe(false);
  });

  test("credential readiness needs XAI_API_KEY or OPENROUTER_API_KEY", () => {
    expect(checkGrokCredentials({}).ready).toBe(false);
    expect(checkGrokCredentials({ XAI_API_KEY: " " }).missing).toEqual([
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(checkGrokCredentials({ XAI_API_KEY: "xai-k" })).toMatchObject({
      ready: true,
      satisfiedBy: "env",
    });
    expect(checkGrokCredentials({ OPENROUTER_API_KEY: "or-k" }).ready).toBe(true);
  });

  test("prompt cost reads Grok's _meta.usage; a BYOK model reports no USD", () => {
    expect(grokPromptCost(undefined, "grok-4.6")).toBeUndefined();
    expect(grokPromptCost({ totalTokens: 10 }, "grok-4.6")).toBeUndefined();
    const byok = grokPromptCost(
      { usage: { inputTokens: 1000, cachedReadTokens: 0, outputTokens: 5, modelCalls: 2 } },
      "openrouter/acme/thing",
    );
    expect(byok).toEqual({
      model: "openrouter/acme/thing",
      inputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      numTurns: 2,
    });
  });

  test("reported models keep the session's route namespace", () => {
    expect(grokReportedModel("grok-build-0.1", "grok-4.6")).toBe("grok-build-0.1");
    expect(grokReportedModel("xai/grok-4.3", "grok-4.6")).toBe("grok-4.3");
    expect(grokReportedModel("deepseek/deepseek-v4.1-flash", "openrouter/acme/thing")).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
    expect(
      grokReportedModel("openrouter/deepseek/deepseek-v4.1-flash", "openrouter/acme/thing"),
    ).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    // Per-model rows carry no reasoning field; the final model is the one that ran.
    expect(
      grokPromptCost(
        {
          modelId: "deepseek/deepseek-v4.1-flash",
          usage: {
            inputTokens: 100,
            cachedReadTokens: 40,
            outputTokens: 5,
            reasoningTokens: 3,
            modelUsage: {
              "deepseek/deepseek-v4.1-flash": {
                inputTokens: 100,
                cachedReadTokens: 40,
                outputTokens: 5,
                reasoningTokens: 3,
              },
            },
          },
        },
        "openrouter/acme/thing",
      ),
    ).toMatchObject({
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      models: [
        {
          model: "openrouter/deepseek/deepseek-v4.1-flash",
          inputTokens: 60,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
          outputTokens: 8,
        },
      ],
    });
  });

  test("the credential pool picks the key the model's route bills", () => {
    expect(getModelAwareCredentialVars("grok", "grok-4.3")).toEqual(["XAI_API_KEY"]);
    expect(getModelAwareCredentialVars("grok", "openrouter/acme/thing")).toEqual([
      "OPENROUTER_API_KEY",
    ]);
  });

  test("refuses to start without XAI_API_KEY", async () => {
    const saved = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      await expect(new GrokAdapter().createSession(baseConfig())).rejects.toThrow(
        "grok requires XAI_API_KEY",
      );
    } finally {
      if (saved !== undefined) process.env.XAI_API_KEY = saved;
    }
  });

  test("runs a session as provider grok in an isolated GROK_HOME", async () => {
    const dir = makeTempDir();
    const grok = writeFakeGrok(dir, "ok", promptMetaWithSideModel(dir));
    const { server, apiUrl } = await startTokenStub();
    try {
      const config = baseConfig({
        apiUrl,
        reasoningEffort: "high",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: makeTempDir(),
          GROK_BINARY: grok,
          XAI_API_KEY: "xai-test-key",
          ANTHROPIC_API_KEY: "must-not-leak",
          CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
          OPENAI_API_KEY: "must-not-leak",
          OPENROUTER_API_KEY: "must-not-leak",
          GROK_MODELS_BASE_URL: "https://gateway.example/v1",
        },
      });
      const session = await new GrokAdapter().createSession(config);
      const events: ProviderEvent[] = [];
      session.onEvent((event) => events.push(event));
      const result = await session.waitForCompletion();

      expect(result.isError).toBe(false);
      expect(result.output).toBe("1: grok-e2e-worker");
      // `_meta.usage`: the recorded grok-build-0.1 usage (134378 input incl.
      // 109504 cached, 144 output + 1827 reasoning, 507168000 ticks of 1e-10
      // USD over 6 calls) plus one grok-4.3 side call. The task asked for
      // grok-4.6; `_meta.modelId` says grok-build-0.1 ran, and the cost row
      // says so too.
      expect(result.cost).toMatchObject({
        provider: "grok",
        model: "grok-build-0.1",
        inputTokens: 26374,
        cacheReadTokens: 110004,
        cacheWriteTokens: 0,
        outputTokens: 2021,
        reasoningOutputTokens: 1837,
        totalCostUsd: 0.0527168,
        numTurns: 6,
      });
      expect(result.cost?.models).toEqual([
        {
          model: "grok-build-0.1",
          inputTokens: 24874,
          cacheReadTokens: 109504,
          cacheWriteTokens: 0,
          outputTokens: 1971,
          harnessCostUsd: 0.0507168,
        },
        {
          model: "grok-4.3",
          inputTokens: 1500,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
          outputTokens: 50,
          harnessCostUsd: 0.002,
        },
      ]);

      const init = events.find((e) => e.type === "session_init");
      expect(init).toMatchObject({ provider: "grok", sessionId: "grok-session-1" });
      const toolStarts = events.filter((e) => e.type === "tool_start");
      // Swarm MCP calls arrive through Grok's `use_tool` proxy and are unwrapped.
      expect(toolStarts.map((e) => e.type === "tool_start" && e.toolName)).toEqual([
        "search_tool",
        "search_tool",
        "mcp__swarm__get-swarm",
        "search_tool",
        "mcp__swarm__store-progress",
      ]);
      expect(toolStarts[4]).toMatchObject({
        args: { taskId: "task-1", status: "completed", output: "1: grok-worker" },
      });
      expect(events.filter((e) => e.type === "tool_end")).toHaveLength(5);
      // No `usage_update`: the last model call's `_meta.totalTokens` is the snapshot.
      // The window is grok-build-0.1's (256k), not the requested grok-4.6's (500k).
      expect(events.find((e) => e.type === "context_usage")).toMatchObject({
        contextUsedTokens: 25028,
        contextTotalTokens: 256000,
        contextFormula: "harness-reported",
      });

      // The dashboard reads grok session logs with the ACP normalizer.
      const rows = events
        .filter((e): e is Extract<ProviderEvent, { type: "raw_log" }> => e.type === "raw_log")
        .map((e, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          taskId: "task-1",
          sessionId: "grok-session-1",
          iteration: 1,
          cli: "grok",
          content: e.content,
          lineNumber: i,
          createdAt: new Date(1_800_000_000_000 + i).toISOString(),
        }));
      const transcript = normalizeSessionLogs(rows);
      expect(transcript.gate.passed).toBe(true);
      expect(transcript.pairing.paired).toBe(5);
      // Grok's `variant`-tagged update input does not leak into the call input,
      // and its status-less updates do not render as progress rows.
      const getSwarm = transcript.items.find(
        (item) => item.kind === "tool_call" && item.tool?.name === "mcp__swarm__get-swarm",
      );
      expect(getSwarm?.tool?.input).toEqual({});
      expect(
        transcript.items.filter(
          (item) =>
            item.kind === "lifecycle" && (item.meta as { type?: string })?.type === "progress",
        ),
      ).toEqual([]);
      expect(transcript.items.some((item) => item.kind === "unknown")).toBe(false);
      expect(
        transcript.items.filter((item) => item.kind === "text").map((item) => item.text),
      ).toEqual(["1: grok-e2e-worker"]);

      const capture = JSON.parse(await Bun.file(join(config.cwd, "capture.json")).text());
      expect(capture.argv).toEqual([
        "agent",
        "--no-leader",
        "--always-approve",
        "--model",
        "grok-4.6",
        "--reasoning-effort",
        "high",
        "stdio",
      ]);
      expect(capture.newSession).toEqual({
        meta: { rules: "You are a swarm worker.", yoloMode: true },
        mcpServers: ["swarm"],
      });
      // Only the key and the isolation switches cross the env allowlist.
      expect(capture.env).toEqual({
        ...GROK_ISOLATION_ENV,
        XAI_API_KEY: "xai-test-key",
        GROK_HOME: expect.stringContaining("swarm-grok-"),
        GROK_MODELS_BASE_URL: "https://gateway.example/v1",
      });
      expect(capture.configToml).toContain("[compat.codex]");
      expect(capture.configToml).not.toContain("[model.");
      expect(capture.requirementsToml).toBe("allow_managed_hooks_only = true\n");
      // The per-session GROK_HOME is removed once the session settles.
      await Bun.sleep(50);
      expect(existsSync(capture.env.GROK_HOME)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("runs an openrouter/ model as an OpenAI-compatible model on OPENROUTER_API_KEY", async () => {
    const dir = makeTempDir();
    // A BYOK route reports the endpoint's id and no ticks.
    const metaPath = join(dir, "prompt-meta-openrouter.json");
    const usage = { inputTokens: 900, cachedReadTokens: 100, outputTokens: 20, reasoningTokens: 0 };
    writeFileSync(
      metaPath,
      JSON.stringify({
        totalTokens: 920,
        modelId: "google/gemini-3-flash-preview",
        usage: { ...usage, numTurns: 1, modelUsage: { "google/gemini-3-flash-preview": usage } },
      }),
    );
    const grok = writeFakeGrok(dir, "ok", metaPath);
    const { server, apiUrl } = await startTokenStub();
    const saved = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const config = baseConfig({
        apiUrl,
        model: "openrouter/google/gemini-3-flash-preview",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: makeTempDir(),
          GROK_BINARY: grok,
          OPENROUTER_API_KEY: "or-test-key",
        },
      });
      const session = await new GrokAdapter().createSession(config);
      const result = await session.waitForCompletion();
      expect(result.isError).toBe(false);
      expect(result.cost).toMatchObject({
        provider: "grok",
        model: "openrouter/google/gemini-3-flash-preview",
        inputTokens: 800,
        totalCostUsd: 0,
      });
      // The reported endpoint id keeps the openrouter/ namespace pricing reads.
      expect(result.cost?.models).toEqual([
        {
          model: "openrouter/google/gemini-3-flash-preview",
          inputTokens: 800,
          cacheReadTokens: 100,
          cacheWriteTokens: 0,
          outputTokens: 20,
        },
      ]);

      const capture = JSON.parse(await Bun.file(join(config.cwd, "capture.json")).text());
      expect(capture.argv).toContain("openrouter/google/gemini-3-flash-preview");
      // The OpenRouter route carries its own key and never XAI_API_KEY.
      expect(capture.env).toEqual({
        ...GROK_ISOLATION_ENV,
        OPENROUTER_API_KEY: "or-test-key",
        GROK_HOME: expect.stringContaining("swarm-grok-"),
      });
      expect(capture.configToml).toContain(
        [
          '[model."openrouter/google/gemini-3-flash-preview"]',
          'model = "google/gemini-3-flash-preview"',
          'base_url = "https://openrouter.ai/api/v1"',
          'env_key = "OPENROUTER_API_KEY"',
          'api_backend = "chat_completions"',
          'extra_headers = { "HTTP-Referer" = "https://agent-swarm.dev", "X-OpenRouter-Title" = "Agent Swarm", "X-OpenRouter-Categories" = "personal-agent,cloud-agent" }',
        ].join("\n"),
      );
    } finally {
      if (saved !== undefined) process.env.XAI_API_KEY = saved;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("OpenRouter app attribution rides only on direct openrouter.ai models", () => {
    const toml = (env: Record<string, string>) =>
      buildGrokConfigToml([], grokOpenRouterModel("openrouter/acme/thing", env));
    expect(toml({})).toContain('extra_headers = { "HTTP-Referer" = "https://agent-swarm.dev"');
    expect(toml({ OPENROUTER_BASE_URL: "https://gateway.example/v1" })).not.toContain(
      "extra_headers",
    );
    expect(toml({ OPENROUTER_APP_ATTRIBUTION: "false" })).not.toContain("extra_headers");
    expect(buildGrokConfigToml([], null)).not.toContain("extra_headers");
  });

  test("an xai/-qualified model runs as the bare xAI id", async () => {
    const dir = makeTempDir();
    const grok = writeFakeGrok(dir, "ok");
    const { server, apiUrl } = await startTokenStub();
    try {
      const config = baseConfig({
        apiUrl,
        model: "xai/grok-4.6",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: makeTempDir(),
          GROK_BINARY: grok,
          XAI_API_KEY: "k",
        },
      });
      const result = await (await new GrokAdapter().createSession(config)).waitForCompletion();
      expect(result.isError).toBe(false);
      const capture = JSON.parse(await Bun.file(join(config.cwd, "capture.json")).text());
      expect(capture.argv).toEqual([
        "agent",
        "--no-leader",
        "--always-approve",
        "--model",
        "grok-4.6",
        "stdio",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("an abort keeps the usage of the cancelled prompt", async () => {
    const dir = makeTempDir();
    const grok = writeFakeGrok(dir, "wait-for-cancel");
    const { server, apiUrl } = await startTokenStub();
    try {
      const config = baseConfig({
        apiUrl,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: makeTempDir(),
          GROK_BINARY: grok,
          XAI_API_KEY: "k",
        },
      });
      const session = await new GrokAdapter().createSession(config);
      const events: ProviderEvent[] = [];
      session.onEvent((event) => events.push(event));
      // The server marks the task done (store-progress) while the turn is open.
      while (events.filter((e) => e.type === "tool_end").length < 5) await Bun.sleep(10);
      await session.abort();
      const result = await session.waitForCompletion();
      expect(result.isError).toBe(true);
      expect(result.cost).toMatchObject({ totalCostUsd: 0.0507168, outputTokens: 1971 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("refuses an openrouter/ model without OPENROUTER_API_KEY", async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(
        new GrokAdapter().createSession(
          baseConfig({
            model: "openrouter/acme/thing",
            env: { PATH: process.env.PATH ?? "", XAI_API_KEY: "xai-k" },
          }),
        ),
      ).rejects.toThrow("grok requires OPENROUTER_API_KEY for openrouter/acme/thing");
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  test("maps Grok's auth error to a credential message", async () => {
    const dir = makeTempDir();
    const grok = writeFakeGrok(dir, "auth-required");
    const { server, apiUrl } = await startTokenStub();
    try {
      await expect(
        new GrokAdapter().createSession(
          baseConfig({
            apiUrl,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: makeTempDir(),
              GROK_BINARY: grok,
              XAI_API_KEY: "xai-bad-key",
            },
          }),
        ),
      ).rejects.toThrow(
        "Grok rejected the credentials (XAI_API_KEY or OPENROUTER_API_KEY invalid or missing): Authentication required",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("grok target profile", () => {
  test("is not an operator ACP target", () => {
    expect(() => resolveAcpTarget(baseConfig({ env: { ACP_TARGET: "grok" } }))).toThrow(
      'Unsupported ACP target "grok"',
    );
  });

  test("omits flags it has no value for", () => {
    const config = baseConfig({ model: "", systemPrompt: "" });
    expect(grokTargetProfile.command(config)).toEqual([
      "grok",
      "agent",
      "--no-leader",
      "--always-approve",
      "stdio",
    ]);
    expect(grokTargetProfile.sessionMeta?.(config)).toEqual({ yoloMode: true });
  });

  test("leaves other errors alone", () => {
    expect(grokTargetProfile.describeError?.("rate limited")).toBeUndefined();
    expect(grokTargetProfile.describeError?.("Not signed in. Run grok login")).toContain(
      "OPENROUTER_API_KEY invalid or missing",
    );
  });

  test("existing ACP targets still send no session _meta", () => {
    const opencode = resolveAcpTarget(baseConfig({ env: { ACP_TARGET: "opencode" } }));
    expect(opencode.sessionMeta).toBeUndefined();
    expect(new ACPAdapter().name).toBe("acp");
  });
});

describe("grok config", () => {
  test("disables the worker's Claude plugins by name", async () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "context-mode@context-mode": [], "x@y": [] } }),
    );
    const names = await installedClaudePluginNames(home);
    expect(names).toEqual(["context-mode", "x"]);
    expect(buildGrokConfigToml(names)).toContain('disabled = ["context-mode", "x"]');
    expect(await installedClaudePluginNames(makeTempDir())).toEqual([]);
    expect(buildGrokConfigToml([])).toContain("disabled = []");
  });
});
