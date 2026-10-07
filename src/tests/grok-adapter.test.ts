import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionLogs } from "../../apps/ui/src/logs-parser";
import { createProviderAdapter } from "../providers";
import { ACPAdapter } from "../providers/acp-adapter";
import { GROK_ISOLATION_ENV, grokTargetProfile, resolveAcpTarget } from "../providers/acp-targets";
import {
  buildGrokConfigToml,
  checkGrokCredentials,
  GrokAdapter,
  installedClaudePluginNames,
} from "../providers/grok-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

/**
 * The ACP updates replayed here follow the shapes in the Grok CLI's bundled
 * docs (`15-agent-mode.md`), not a recorded authenticated session: no
 * XAI_API_KEY was available when this harness landed.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "grok", "acp-updates-doc-shaped.jsonl");
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
function writeFakeGrok(dir: string, mode: "ok" | "auth-required"): string {
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
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GROK_|XAI_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(k))),
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
    return { stopReason: "end_turn", usage: { inputTokens: 2000, outputTokens: 300, cachedReadTokens: 1000, totalTokens: 3300 } };
  }
  async cancel() {}
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

  test("credential readiness needs XAI_API_KEY", () => {
    expect(checkGrokCredentials({}).ready).toBe(false);
    expect(checkGrokCredentials({ XAI_API_KEY: " " }).missing).toEqual(["XAI_API_KEY"]);
    expect(checkGrokCredentials({ XAI_API_KEY: "xai-k" })).toMatchObject({
      ready: true,
      satisfiedBy: "env",
    });
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
    const grok = writeFakeGrok(dir, "ok");
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
        },
      });
      const session = await new GrokAdapter().createSession(config);
      const events: ProviderEvent[] = [];
      session.onEvent((event) => events.push(event));
      const result = await session.waitForCompletion();

      expect(result.isError).toBe(false);
      expect(result.output).toBe("The swarm has 2 agents.");
      expect(result.cost).toMatchObject({
        provider: "grok",
        model: "grok-4.6",
        inputTokens: 2000,
        outputTokens: 300,
        cacheReadTokens: 1000,
        totalCostUsd: 0,
      });

      const init = events.find((e) => e.type === "session_init");
      expect(init).toMatchObject({ provider: "grok", sessionId: "grok-session-1" });
      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts.map((e) => e.type === "tool_start" && e.toolName)).toEqual([
        "mcp__swarm__get-swarm",
        "run_terminal_cmd",
      ]);
      expect(events.filter((e) => e.type === "tool_end")).toHaveLength(2);
      expect(events.some((e) => e.type === "context_usage")).toBe(true);

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
      expect(transcript.pairing.paired).toBe(2);
      expect(transcript.items.some((item) => item.kind === "unknown")).toBe(false);
      expect(
        transcript.items.some(
          (item) => item.kind === "text" && item.text === "The swarm has 2 agents.",
        ),
      ).toBe(true);

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
      });
      expect(capture.configToml).toContain("[compat.codex]");
      expect(capture.requirementsToml).toBe("allow_managed_hooks_only = true\n");
      // The per-session GROK_HOME is removed once the session settles.
      await Bun.sleep(50);
      expect(existsSync(capture.env.GROK_HOME)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
        "Grok rejected the credentials (XAI_API_KEY invalid or missing): Authentication required",
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
      "XAI_API_KEY invalid or missing",
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
