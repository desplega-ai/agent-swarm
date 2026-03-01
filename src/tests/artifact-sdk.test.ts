import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BROWSER_SDK_JS } from "../artifact-sdk/browser-sdk";
import { getAvailablePort } from "../artifact-sdk/port";
import { createArtifactServer } from "../artifact-sdk/server";
import { getBasePrompt } from "../prompts/base-prompt";

// ─── Port allocation tests ──────────────────────────────────────────────

describe("getAvailablePort", () => {
  test("returns a valid port number", async () => {
    const port = await getAvailablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  test("returns different ports on consecutive calls", async () => {
    const port1 = await getAvailablePort();
    const port2 = await getAvailablePort();
    expect(port1).not.toBe(port2);
  });

  test("returns a port that is actually available", async () => {
    const port = await getAvailablePort();
    // Try to start a Bun server on the port — should succeed
    const server = Bun.serve({
      port,
      fetch: () => new Response("ok"),
    });
    expect(server.port).toBe(port);
    server.stop();
  });

  test("returns ports in ephemeral range", async () => {
    const ports: number[] = [];
    for (let i = 0; i < 5; i++) {
      ports.push(await getAvailablePort());
    }
    // All ports should be in the ephemeral range (typically > 1024)
    for (const p of ports) {
      expect(p).toBeGreaterThan(1024);
    }
  });

  test("all returned ports are unique", async () => {
    const ports = new Set<number>();
    for (let i = 0; i < 10; i++) {
      ports.add(await getAvailablePort());
    }
    expect(ports.size).toBe(10);
  });
});

// ─── Browser SDK tests ─────────────────────────────────────────────────

describe("BROWSER_SDK_JS", () => {
  test("is a non-empty string", () => {
    expect(typeof BROWSER_SDK_JS).toBe("string");
    expect(BROWSER_SDK_JS.length).toBeGreaterThan(100);
  });

  test("contains SwarmSDK class", () => {
    expect(BROWSER_SDK_JS).toContain("class SwarmSDK");
  });

  test("contains all expected API methods", () => {
    const expectedMethods = [
      "createTask",
      "getTasks",
      "getTaskDetails",
      "storeProgress",
      "postMessage",
      "readMessages",
      "getSwarm",
      "listServices",
      "listEpics",
      "slackReply",
    ];
    for (const method of expectedMethods) {
      expect(BROWSER_SDK_JS).toContain(method);
    }
  });

  test("assigns SwarmSDK to window", () => {
    expect(BROWSER_SDK_JS).toContain("window.SwarmSDK = SwarmSDK");
  });

  test("uses correct proxy API paths", () => {
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/tasks");
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/agents");
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/messages");
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/services");
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/epics");
    expect(BROWSER_SDK_JS).toContain("/@swarm/api/slack/reply");
  });

  test("fetches config on construction", () => {
    expect(BROWSER_SDK_JS).toContain("fetch('/@swarm/config')");
  });

  test("has _post helper with JSON content-type", () => {
    expect(BROWSER_SDK_JS).toContain("_post(url, body)");
    expect(BROWSER_SDK_JS).toContain("'Content-Type': 'application/json'");
    expect(BROWSER_SDK_JS).toContain("JSON.stringify(body)");
  });

  test("has _get helper", () => {
    expect(BROWSER_SDK_JS).toContain("_get(url)");
  });
});

// ─── createArtifactServer factory tests ──────────────────────────────────

describe("createArtifactServer", () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.AGENT_ID = "test-agent-id";
    process.env.API_KEY = "test-api-key";
    process.env.MCP_BASE_URL = "http://localhost:19999"; // Intentionally unreachable
  });

  afterAll(() => {
    process.env.AGENT_ID = originalEnv.AGENT_ID;
    process.env.API_KEY = originalEnv.API_KEY;
    process.env.MCP_BASE_URL = originalEnv.MCP_BASE_URL;
  });

  describe("factory return shape", () => {
    test("returns object with expected properties", () => {
      const server = createArtifactServer({ name: "test" });
      expect(server).toHaveProperty("start");
      expect(server).toHaveProperty("stop");
      expect(server).toHaveProperty("url");
      expect(server).toHaveProperty("port");
      expect(server).toHaveProperty("tunnel");
      expect(typeof server.start).toBe("function");
      expect(typeof server.stop).toBe("function");
    });

    test("initial url is empty string", () => {
      const server = createArtifactServer({ name: "test" });
      expect(server.url).toBe("");
    });

    test("initial port is 0", () => {
      const server = createArtifactServer({ name: "test" });
      expect(server.port).toBe(0);
    });

    test("initial tunnel is null", () => {
      const server = createArtifactServer({ name: "test" });
      expect(server.tunnel).toBeNull();
    });
  });

  describe("Hono app routes", () => {
    test("server serves static content via Hono", async () => {
      const { Hono } = await import("hono");
      const port = await getAvailablePort();

      const app = new Hono();
      app.get("/", (c) => c.text("Hello from test artifact"));

      // Create a minimal Hono server without tunnel
      const honoApp = new Hono();
      honoApp.get("/@swarm/sdk.js", (c) => {
        c.header("Content-Type", "application/javascript");
        return c.body(BROWSER_SDK_JS);
      });
      honoApp.get("/@swarm/config", (c) => {
        return c.json({ agentId: "test-agent-id", artifactName: "test" });
      });
      honoApp.route("/", app);

      const server = Bun.serve({ port, fetch: honoApp.fetch });

      try {
        // Test content serving
        const res = await fetch(`http://localhost:${port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("Hello from test artifact");

        // Test SDK endpoint
        const sdkRes = await fetch(`http://localhost:${port}/@swarm/sdk.js`);
        expect(sdkRes.status).toBe(200);
        expect(sdkRes.headers.get("content-type")).toContain("javascript");
        const sdkBody = await sdkRes.text();
        expect(sdkBody).toContain("class SwarmSDK");

        // Test config endpoint
        const configRes = await fetch(`http://localhost:${port}/@swarm/config`);
        expect(configRes.status).toBe(200);
        const config = await configRes.json();
        expect(config).toEqual({ agentId: "test-agent-id", artifactName: "test" });
      } finally {
        server.stop();
      }
    });

    test("server serves static files from directory", async () => {
      const { Hono } = await import("hono");
      const { serveStatic } = await import("hono/bun");
      const port = await getAvailablePort();
      const testDir = "/tmp/test-artifact-static";

      // Create test directory with content
      mkdirSync(testDir, { recursive: true });
      writeFileSync(`${testDir}/index.html`, "<h1>Test Static</h1>");
      writeFileSync(`${testDir}/data.json`, '{"test": true}');

      const app = new Hono();
      app.use("/*", serveStatic({ root: testDir }));

      const server = Bun.serve({ port, fetch: app.fetch });

      try {
        const res = await fetch(`http://localhost:${port}/index.html`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<h1>Test Static</h1>");

        const jsonRes = await fetch(`http://localhost:${port}/data.json`);
        expect(jsonRes.status).toBe(200);
        const data = await jsonRes.json();
        expect(data).toEqual({ test: true });
      } finally {
        server.stop();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("API proxy returns 502 when MCP server is unreachable", async () => {
      const { Hono } = await import("hono");
      const port = await getAvailablePort();

      const app = new Hono();
      app.all("/@swarm/api/*", async (c) => {
        const path = c.req.path.replace("/@swarm/api", "/api");
        const targetUrl = `http://localhost:19999${path}`; // Unreachable
        try {
          const res = await fetch(targetUrl, { method: c.req.method });
          return new Response(res.body, { status: res.status });
        } catch (e) {
          return c.json({ error: "Proxy error", message: String(e) }, 502);
        }
      });

      const server = Bun.serve({ port, fetch: app.fetch });

      try {
        const res = await fetch(`http://localhost:${port}/@swarm/api/agents`);
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.error).toBe("Proxy error");
      } finally {
        server.stop();
      }
    });

    test("CORS preflight returns 204 with correct headers", async () => {
      const { Hono } = await import("hono");
      const port = await getAvailablePort();

      const app = new Hono();
      app.options("/@swarm/api/*", (_c) => {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      });

      const server = Bun.serve({ port, fetch: app.fetch });

      try {
        const res = await fetch(`http://localhost:${port}/@swarm/api/tasks`, {
          method: "OPTIONS",
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("GET");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
        expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
      } finally {
        server.stop();
      }
    });

    test("API proxy forwards auth headers to MCP server", async () => {
      const { Hono } = await import("hono");
      const proxyPort = await getAvailablePort();
      const mockMcpPort = await getAvailablePort();

      // Mock MCP server that captures headers
      let capturedHeaders: Record<string, string> = {};
      const mockMcp = Bun.serve({
        port: mockMcpPort,
        fetch: (req) => {
          capturedHeaders = {};
          for (const [key, value] of req.headers.entries()) {
            capturedHeaders[key.toLowerCase()] = value;
          }
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      // Build proxy app matching server.ts pattern
      const app = new Hono();
      app.all("/@swarm/api/*", async (c) => {
        const path = c.req.path.replace("/@swarm/api", "/api");
        const targetUrl = `http://localhost:${mockMcpPort}${path}`;
        const headers: Record<string, string> = {
          Authorization: "Bearer test-api-key",
          "X-Agent-ID": "test-agent-id",
        };
        if (c.req.method !== "GET") {
          headers["Content-Type"] = "application/json";
        }
        try {
          const res = await fetch(targetUrl, { method: c.req.method, headers });
          return new Response(res.body, {
            status: res.status,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        } catch (e) {
          return c.json({ error: "Proxy error", message: String(e) }, 502);
        }
      });

      const proxy = Bun.serve({ port: proxyPort, fetch: app.fetch });

      try {
        // Test GET request headers
        await fetch(`http://localhost:${proxyPort}/@swarm/api/agents`);
        expect(capturedHeaders.authorization).toBe("Bearer test-api-key");
        expect(capturedHeaders["x-agent-id"]).toBe("test-agent-id");

        // GET should NOT have Content-Type
        expect(capturedHeaders["content-type"]).toBeUndefined();

        // Test POST request headers
        await fetch(`http://localhost:${proxyPort}/@swarm/api/tasks`, {
          method: "POST",
          body: JSON.stringify({ task: "test" }),
        });
        expect(capturedHeaders.authorization).toBe("Bearer test-api-key");
        expect(capturedHeaders["x-agent-id"]).toBe("test-agent-id");
        expect(capturedHeaders["content-type"]).toBe("application/json");
      } finally {
        proxy.stop();
        mockMcp.stop();
      }
    });

    test("API proxy response includes CORS headers", async () => {
      const { Hono } = await import("hono");
      const proxyPort = await getAvailablePort();
      const mockMcpPort = await getAvailablePort();

      const mockMcp = Bun.serve({
        port: mockMcpPort,
        fetch: () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          }),
      });

      const app = new Hono();
      app.all("/@swarm/api/*", async (c) => {
        const path = c.req.path.replace("/@swarm/api", "/api");
        const targetUrl = `http://localhost:${mockMcpPort}${path}`;
        try {
          const res = await fetch(targetUrl, { method: c.req.method });
          return new Response(res.body, {
            status: res.status,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        } catch (_e) {
          return c.json({ error: "Proxy error" }, 502);
        }
      });

      const proxy = Bun.serve({ port: proxyPort, fetch: app.fetch });

      try {
        const res = await fetch(`http://localhost:${proxyPort}/@swarm/api/agents`);
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        proxy.stop();
        mockMcp.stop();
      }
    });

    test("API proxy correctly rewrites path from /@swarm/api to /api", async () => {
      const { Hono } = await import("hono");
      const proxyPort = await getAvailablePort();
      const mockMcpPort = await getAvailablePort();

      let capturedPath = "";
      const mockMcp = Bun.serve({
        port: mockMcpPort,
        fetch: (req) => {
          capturedPath = new URL(req.url).pathname;
          return new Response(JSON.stringify({ ok: true }));
        },
      });

      const app = new Hono();
      app.all("/@swarm/api/*", async (c) => {
        const path = c.req.path.replace("/@swarm/api", "/api");
        const targetUrl = `http://localhost:${mockMcpPort}${path}`;
        try {
          const res = await fetch(targetUrl, { method: c.req.method });
          return new Response(res.body, { status: res.status });
        } catch (_e) {
          return c.json({ error: "Proxy error" }, 502);
        }
      });

      const proxy = Bun.serve({ port: proxyPort, fetch: app.fetch });

      try {
        await fetch(`http://localhost:${proxyPort}/@swarm/api/tasks/123/progress`);
        expect(capturedPath).toBe("/api/tasks/123/progress");

        await fetch(`http://localhost:${proxyPort}/@swarm/api/agents`);
        expect(capturedPath).toBe("/api/agents");

        await fetch(`http://localhost:${proxyPort}/@swarm/api/services`);
        expect(capturedPath).toBe("/api/services");
      } finally {
        proxy.stop();
        mockMcp.stop();
      }
    });
  });

  describe("stop()", () => {
    test("stop() is safe to call when server was never started", async () => {
      const server = createArtifactServer({ name: "never-started" });
      // Should not throw
      await server.stop();
      expect(server.port).toBe(0);
      expect(server.tunnel).toBeNull();
    });
  });
});

// ─── tunnel.ts tests ──────────────────────────────────────────────────────

describe("createTunnel", () => {
  test("module exports createTunnel function", async () => {
    const tunnelMod = await import("../artifact-sdk/tunnel");
    expect(typeof tunnelMod.createTunnel).toBe("function");
  });
});

// ─── index.ts re-export tests ──────────────────────────────────────────

describe("artifact-sdk index exports", () => {
  test("exports createArtifactServer", async () => {
    const sdk = await import("../artifact-sdk/index");
    expect(typeof sdk.createArtifactServer).toBe("function");
  });

  test("createArtifactServer from index is same as from server", async () => {
    const sdk = await import("../artifact-sdk/index");
    const { createArtifactServer: direct } = await import("../artifact-sdk/server");
    expect(sdk.createArtifactServer).toBe(direct);
  });
});

// ─── CLI command tests ─────────────────────────────────────────────────

describe("artifact CLI command", () => {
  test("runArtifact module exports correctly", async () => {
    const mod = await import("../commands/artifact");
    expect(typeof mod.runArtifact).toBe("function");
  });

  test("runArtifact with unknown subcommand calls printHelp (no crash)", async () => {
    const { runArtifact } = await import("../commands/artifact");
    // "help" and unknown subcommands should just print help and return
    const consoleSpy = mock(() => {});
    const origLog = console.log;
    console.log = consoleSpy;
    try {
      await runArtifact("help", { additionalArgs: [] });
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Usage: agent-swarm artifact");
      expect(output).toContain("serve");
      expect(output).toContain("list");
      expect(output).toContain("stop");
    } finally {
      console.log = origLog;
    }
  });

  test("runArtifact with no subcommand defaults to help", async () => {
    const { runArtifact } = await import("../commands/artifact");
    const consoleSpy = mock(() => {});
    const origLog = console.log;
    console.log = consoleSpy;
    try {
      // Default case when subcommand is not recognized
      await runArtifact("unknown-command", { additionalArgs: [] });
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Usage: agent-swarm artifact");
    } finally {
      console.log = origLog;
    }
  });

  describe("artifact list", () => {
    test("lists artifacts from mock MCP server", async () => {
      const mockPort = await getAvailablePort();
      const mockServer = Bun.serve({
        port: mockPort,
        fetch: (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/services") {
            return new Response(
              JSON.stringify([
                {
                  id: "svc-1",
                  name: "artifact-dashboard",
                  agentId: "agent-123",
                  status: "healthy",
                  metadata: {
                    type: "artifact",
                    artifactName: "dashboard",
                    port: 3001,
                    publicUrl: "https://test.lt.example.com",
                  },
                },
                {
                  id: "svc-2",
                  name: "some-other-service",
                  agentId: "agent-456",
                  status: "healthy",
                  metadata: { type: "web" },
                },
              ]),
            );
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const origEnv = { ...process.env };
      process.env.MCP_BASE_URL = `http://localhost:${mockPort}`;
      process.env.API_KEY = "test-key";
      process.env.AGENT_ID = "test-agent";

      const consoleSpy = mock(() => {});
      const origLog = console.log;
      console.log = consoleSpy;

      try {
        const { runArtifact } = await import("../commands/artifact");
        await runArtifact("list", { additionalArgs: [] });

        const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
        // Should show the artifact but not the non-artifact service
        expect(output).toContain("dashboard");
        expect(output).toContain("https://test.lt.example.com");
      } finally {
        console.log = origLog;
        process.env.MCP_BASE_URL = origEnv.MCP_BASE_URL;
        process.env.API_KEY = origEnv.API_KEY;
        process.env.AGENT_ID = origEnv.AGENT_ID;
        mockServer.stop();
      }
    });

    test("shows 'No active artifacts' when none exist", async () => {
      const mockPort = await getAvailablePort();
      const mockServer = Bun.serve({
        port: mockPort,
        fetch: () => new Response(JSON.stringify([])),
      });

      const origEnv = { ...process.env };
      process.env.MCP_BASE_URL = `http://localhost:${mockPort}`;
      process.env.API_KEY = "test-key";
      process.env.AGENT_ID = "test-agent";

      const consoleSpy = mock(() => {});
      const origLog = console.log;
      console.log = consoleSpy;

      try {
        const { runArtifact } = await import("../commands/artifact");
        await runArtifact("list", { additionalArgs: [] });

        const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
        expect(output).toContain("No active artifacts");
      } finally {
        console.log = origLog;
        process.env.MCP_BASE_URL = origEnv.MCP_BASE_URL;
        process.env.API_KEY = origEnv.API_KEY;
        process.env.AGENT_ID = origEnv.AGENT_ID;
        mockServer.stop();
      }
    });

    test("filters only artifact-type services from list", async () => {
      const mockPort = await getAvailablePort();
      const mockServer = Bun.serve({
        port: mockPort,
        fetch: () =>
          new Response(
            JSON.stringify([
              {
                id: "s1",
                name: "web-server",
                agentId: "a1",
                status: "healthy",
                metadata: { type: "web" },
              },
              {
                id: "s2",
                name: "api-server",
                agentId: "a2",
                status: "healthy",
                metadata: {},
              },
            ]),
          ),
      });

      const origEnv = { ...process.env };
      process.env.MCP_BASE_URL = `http://localhost:${mockPort}`;
      process.env.API_KEY = "test-key";
      process.env.AGENT_ID = "test-agent";

      const consoleSpy = mock(() => {});
      const origLog = console.log;
      console.log = consoleSpy;

      try {
        const { runArtifact } = await import("../commands/artifact");
        await runArtifact("list", { additionalArgs: [] });

        const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
        // None have type "artifact" so should say no artifacts
        expect(output).toContain("No active artifacts");
      } finally {
        console.log = origLog;
        process.env.MCP_BASE_URL = origEnv.MCP_BASE_URL;
        process.env.API_KEY = origEnv.API_KEY;
        process.env.AGENT_ID = origEnv.AGENT_ID;
        mockServer.stop();
      }
    });
  });

  describe("artifact stop", () => {
    test("stop sends delete request to service registry", async () => {
      const mockPort = await getAvailablePort();
      let deletedServiceId = "";

      const mockServer = Bun.serve({
        port: mockPort,
        fetch: (req) => {
          const url = new URL(req.url);
          if (req.method === "GET" && url.pathname === "/api/services") {
            return new Response(
              JSON.stringify([
                {
                  id: "svc-to-delete",
                  name: "artifact-my-report",
                  metadata: { type: "artifact", artifactName: "my-report" },
                },
              ]),
            );
          }
          if (req.method === "DELETE" && url.pathname.startsWith("/api/services/")) {
            deletedServiceId = url.pathname.split("/").pop() || "";
            return new Response(JSON.stringify({ success: true }));
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const origEnv = { ...process.env };
      process.env.MCP_BASE_URL = `http://localhost:${mockPort}`;
      process.env.API_KEY = "test-key";
      process.env.AGENT_ID = "test-agent";

      const consoleSpy = mock(() => {});
      const origLog = console.log;
      console.log = consoleSpy;

      try {
        const { runArtifact } = await import("../commands/artifact");
        await runArtifact("stop", { additionalArgs: ["my-report"] });

        expect(deletedServiceId).toBe("svc-to-delete");
        const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
        expect(output).toContain("my-report");
        expect(output).toContain("stopped");
      } finally {
        console.log = origLog;
        process.env.MCP_BASE_URL = origEnv.MCP_BASE_URL;
        process.env.API_KEY = origEnv.API_KEY;
        process.env.AGENT_ID = origEnv.AGENT_ID;
        mockServer.stop();
      }
    });
  });
});

// ─── Base prompt tests ──────────────────────────────────────────────────

describe("base prompt artifacts mention", () => {
  test("includes artifacts mention when capability is set", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
      capabilities: ["core", "artifacts", "services"],
    });

    expect(prompt).toContain("/artifacts");
    expect(prompt).toContain("/workspace/personal/artifacts/");
  });

  test("excludes artifacts mention without capability", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
      capabilities: ["core", "services"],
    });

    expect(prompt).not.toContain("/artifacts");
  });

  test("includes artifacts mention when no capabilities specified (default)", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
    });

    expect(prompt).toContain("/artifacts");
  });

  test("does NOT inline full artifact docs (those go in the skill)", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
      capabilities: ["core", "artifacts"],
    });

    expect(prompt).not.toContain("createArtifactServer");
    expect(prompt).not.toContain("SwarmSDK");
  });

  test("mentions localtunnel concept", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
      capabilities: ["core", "artifacts"],
    });

    expect(prompt).toContain("localtunnel");
  });

  test("mentions artifact storage path", () => {
    const prompt = getBasePrompt({
      role: "worker",
      agentId: "test-agent-id",
      swarmUrl: "https://test.swarm.example.com",
      capabilities: ["core", "artifacts"],
    });

    expect(prompt).toContain("/workspace/personal/artifacts/");
  });
});
