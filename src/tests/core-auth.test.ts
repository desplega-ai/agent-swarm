import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { handleCore } from "../http/core";
// Importing the handlers here is load-bearing: each import populates
// `routeRegistry` as a side effect via the `route()` factory, which is what
// the auth middleware consults.
import "../http/webhooks";
import "../http/mcp-oauth";
import "../http/trackers/linear";
import "../http/workflows";

const API_KEY = "test-secret-key";

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (!handled) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ passed: true }));
    }
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

describe("handleCore auth middleware (route() auth.apiKey=false is honored)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createTestServer(API_KEY);
    port = await listen(server);
  });

  afterAll(() => {
    server.close();
  });

  test("public route (auth:{apiKey:false}) passes without a Bearer", async () => {
    const res = await fetch(`http://localhost:${port}/api/mcp-oauth/callback`);
    // The callback route is public — without a state param it returns 400
    // from the handler, but it must NOT be 401 from the auth middleware.
    expect(res.status).not.toBe(401);
  });

  test("authed route (no auth flag → default authed) returns 401 without Bearer", async () => {
    // /api/mcp-oauth/<id>/status is declared with auth:{apiKey:true}
    const res = await fetch(`http://localhost:${port}/api/mcp-oauth/some-id/status`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("authed route passes with correct Bearer", async () => {
    const res = await fetch(`http://localhost:${port}/api/mcp-oauth/some-id/status`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    // Middleware passes (no 401). Downstream handler decides the final status.
    expect(res.status).not.toBe(401);
  });

  test("authed route returns 401 with wrong Bearer", async () => {
    const res = await fetch(`http://localhost:${port}/api/mcp-oauth/some-id/status`, {
      headers: { Authorization: "Bearer WRONG" },
    });
    expect(res.status).toBe(401);
  });

  test("GitHub webhook is still public (auth:{apiKey:false})", async () => {
    const res = await fetch(`http://localhost:${port}/api/github/webhook`, { method: "POST" });
    expect(res.status).not.toBe(401);
  });

  test("GitLab webhook is still public", async () => {
    const res = await fetch(`http://localhost:${port}/api/gitlab/webhook`, { method: "POST" });
    expect(res.status).not.toBe(401);
  });

  test("AgentMail webhook is still public", async () => {
    const res = await fetch(`http://localhost:${port}/api/agentmail/webhook`, { method: "POST" });
    expect(res.status).not.toBe(401);
  });

  test("Linear webhook/authorize/callback are still public", async () => {
    for (const path of [
      "/api/trackers/linear/authorize",
      "/api/trackers/linear/callback",
      "/api/trackers/linear/webhook",
    ]) {
      const method = path.endsWith("/webhook") ? "POST" : "GET";
      const res = await fetch(`http://localhost:${port}${path}`, { method });
      expect(res.status).not.toBe(401);
    }
  });

  test("Workflow webhook trigger is still public", async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/some-workflow-id`, {
      method: "POST",
    });
    expect(res.status).not.toBe(401);
  });

  test("unknown /api/* path fails closed (401 without Bearer)", async () => {
    const res = await fetch(`http://localhost:${port}/api/does-not-exist/xyz`);
    expect(res.status).toBe(401);
  });

  test("/health is always public", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  });
});

describe("handleCore auth middleware (no API_KEY configured)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createTestServer(""); // empty == auth disabled
    port = await listen(server);
  });

  afterAll(() => {
    server.close();
  });

  test("authed routes pass without Bearer when API_KEY is empty", async () => {
    const res = await fetch(`http://localhost:${port}/api/mcp-oauth/some-id/status`);
    expect(res.status).not.toBe(401);
  });
});
