import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BROWSER_SDK_JS } from "../artifact-sdk/browser-sdk";
import { getAvailablePort } from "../artifact-sdk/port";
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
});

// ─── Browser SDK tests ─────────────────────────────────────────────────

describe("BROWSER_SDK_JS", () => {
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
});

// ─── Artifact server creation tests (without tunnel) ────────────────────

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
});
