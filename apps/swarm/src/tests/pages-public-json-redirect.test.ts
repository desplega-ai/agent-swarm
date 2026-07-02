/**
 * Public `/p/:id` for JSON content. JSON pages do NOT render at the API —
 * the renderer lives in the SPA at `/pages/:id` (step-6/7). The API
 * responds with a 302 to the configured app URL's `/pages/:id`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-pages-public-json.sqlite";
const TEST_PORT = 13043;
const BASE = `http://localhost:${TEST_PORT}`;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
    if (await handlePages(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

describe("GET /p/:id — JSON page redirect", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };
  const ORIG_APP = process.env.APP_URL;
  const ORIG_DASHBOARD = process.env.DASHBOARD_URL;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    // Pin APP_URL so the redirect is deterministic across hosts.
    process.env.APP_URL = "http://localhost:5274";
    delete process.env.DASHBOARD_URL;
    server = createTestServer();
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (ORIG_APP === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIG_APP;
    if (ORIG_DASHBOARD === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = ORIG_DASHBOARD;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("JSON content redirects to configured app URL pages route", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "redir",
        title: "Redirect Me",
        contentType: "application/json",
        authMode: "public",
        body: JSON.stringify({ kind: "spec", nodes: [] }),
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:5274/pages/${id}`);
  });

  test("JSON content falls back to local SPA when app URL envs are unset", async () => {
    const prevApp = process.env.APP_URL;
    const prevDashboard = process.env.DASHBOARD_URL;
    process.env.APP_URL = "";
    delete process.env.DASHBOARD_URL;
    try {
      const post = await fetch(`${BASE}/api/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "redir-local-fallback",
          title: "Redirect Locally",
          contentType: "application/json",
          authMode: "public",
          body: JSON.stringify({ kind: "spec", nodes: [] }),
        }),
      });
      expect(post.status).toBe(201);
      const { id } = (await post.json()) as { id: string };

      const res = await fetch(`${BASE}/p/${id}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`http://localhost:5274/pages/${id}`);
    } finally {
      if (prevApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevApp;
      if (prevDashboard === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = prevDashboard;
    }
  });
});
