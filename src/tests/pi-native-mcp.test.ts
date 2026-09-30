import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PiMonoAdapter, piExtensionFactories, toPiMcpServers } from "../providers/pi-mono-adapter";

describe("toPiMcpServers", () => {
  test("maps stdio, http and sse entries to pi configs with direct exposure", () => {
    const servers = toPiMcpServers({
      local: { command: "context-mode", args: ["--stdio"], env: { TOKEN: "abc" } },
      remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Key": "k1" } },
      legacy: { type: "sse", url: "https://sse.example.com/mcp", headers: {} },
    });
    expect(servers).toEqual({
      local: {
        type: "stdio",
        command: "context-mode",
        args: ["--stdio"],
        env: { TOKEN: "abc" },
        exposure: "direct",
      },
      remote: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Key": "k1" },
        exposure: "direct",
      },
      legacy: { type: "http", url: "https://sse.example.com/mcp", headers: {}, exposure: "direct" },
    });
  });

  test("no installed servers maps to an empty set", () => {
    expect(toPiMcpServers(null)).toEqual({});
  });

  test("secret values are escaped for pi's config-value resolver", () => {
    const servers = toPiMcpServers({
      remote: { url: "https://x.example.com", headers: { Authorization: "!rm -rf ~ $HOME" } },
    });
    const remote = servers.remote as { headers: Record<string, string> };
    expect(remote.headers.Authorization).toBe("$!rm -rf ~ $$HOME");
  });
});

describe("piExtensionFactories — installed MCP", () => {
  const swarm: ExtensionFactory = () => {};
  test("adds pi's MCP extension only when the agent has installed servers", () => {
    expect(piExtensionFactories(swarm, { toolDeferral: false })).toHaveLength(1);
    expect(piExtensionFactories(swarm, { toolDeferral: false, installedMcp: true })).toHaveLength(
      2,
    );
  });
});

describe("PiMonoAdapter.createSession — native MCP for installed servers", () => {
  const envKeys = [
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "PI_TOOL_DEFERRAL",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeEach(() => {
    for (const key of envKeys) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "pi-native-mcp-"));
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.OPENROUTER_API_KEY = "example-test-key";
    // The session prompts on creation; keep that request off the network.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    delete process.env.PI_TOOL_DEFERRAL;
    mkdirSync(join(dir, "agent"), { recursive: true });
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Minimal streamable-HTTP MCP server with one `echo` tool; records a header. */
  function serveThirdParty(seen: Array<string | null>) {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST") return new Response(null, { status: 405 });
        seen.push(req.headers.get("x-test"));
        const body = (await req.json()) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string };
        };
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: body.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "third", version: "1" },
              }
            : body.method === "tools/list"
              ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
              : {};
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
  }

  test("installed HTTP servers connect through pi; mcp.json files are ignored", async () => {
    const seen: Array<string | null> = [];
    const third = serveThirdParty(seen);
    const thirdUrl = `http://localhost:${third.port}/mcp`;
    // Positive control shape: with pi's default loader these would register too.
    writeFileSync(
      join(dir, "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { stray: { url: thirdUrl, exposure: "direct" } } }),
    );
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { projstray: { url: thirdUrl, exposure: "direct" } } }),
    );
    const swarm = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          const body = (await req.json()) as { id?: number; method?: string };
          const result =
            body.method === "tools/list"
              ? { tools: [] }
              : { protocolVersion: "2025-03-26", capabilities: {} };
          return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result });
        }
        if (url.pathname.endsWith("/mcp-servers")) {
          return Response.json({
            servers: [
              {
                name: "third",
                transport: "http",
                isActive: true,
                isEnabled: true,
                url: thirdUrl,
                headers: JSON.stringify({ "X-Test": "!echo $HOME" }),
              },
              {
                name: "broken",
                transport: "stdio",
                isActive: true,
                isEnabled: true,
                command: join(dir, "missing-binary"),
                args: "[]",
              },
            ],
          });
        }
        return new Response("ok");
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
        apiUrl: `http://localhost:${swarm.port}`,
        apiKey: "example-test-key",
        cwd: dir,
        logFile: join(dir, "session.log"),
      });
      session = (provider as unknown as { agentSession: AgentSession }).agentSession;
      const deadline = Date.now() + 5000;
      while (!session.getActiveToolNames().includes("mcp__third__echo") && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      const active = session.getActiveToolNames();
      expect(active).toContain("mcp__third__echo");
      expect(active.some((name) => name.includes("stray"))).toBe(false);
      // Header values reach the server verbatim: no shell, no $VAR expansion.
      expect(seen).toContain("!echo $HOME");
    } finally {
      session?.dispose();
      swarm.stop(true);
      third.stop(true);
    }
  });
});
