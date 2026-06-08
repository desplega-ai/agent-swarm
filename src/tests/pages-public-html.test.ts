/**
 * Public `/p/:id` for HTML content. Verifies that:
 *   - the response body contains the original HTML verbatim
 *   - the `BROWSER_SDK_JS` is injected as an inline `<script>` (we look for
 *     `class SwarmSDK` which is unique to the constant)
 *   - the response `Content-Type` is `text/html`
 *   - a `Content-Security-Policy` header is set
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

const TEST_DB_PATH = "./test-pages-public-html.sqlite";
const TEST_PORT = 13042;
const BASE = `http://localhost:${TEST_PORT}`;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    // Try public first, then bearer REST.
    if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
    if (await handlePages(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end("not found");
  });
}

describe("GET /p/:id — HTML public path", () => {
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

  test("public HTML page renders with SDK injection + CSP", async () => {
    const html =
      "<!doctype html><html><head><title>X</title></head><body><h1>Hello</h1></body></html>";
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "public-html",
        title: "Public HTML",
        contentType: "text/html",
        authMode: "public",
        body: html,
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    // jsdelivr + unpkg are allowlisted so pages can <script src="…"> common
    // viz libs (Chart.js, ApexCharts, D3, …) instead of inlining bundles.
    const scriptSrc = csp?.split(";").find((d) => d.trim().startsWith("script-src ")) ?? "";
    expect(scriptSrc).toContain("https://cdn.jsdelivr.net");
    expect(scriptSrc).toContain("https://unpkg.com");
    const styleSrc = csp?.split(";").find((d) => d.trim().startsWith("style-src ")) ?? "";
    expect(styleSrc).toContain("https://cdn.jsdelivr.net");
    expect(styleSrc).toContain("https://unpkg.com");
    const text = await res.text();
    expect(text).toContain("<h1>Hello</h1>");
    expect(text).toContain("class SwarmSDK"); // BROWSER_SDK_JS sentinel
  });

  test("CSP frame ancestors include deprecated DASHBOARD_URL alias", async () => {
    const prevApp = process.env.APP_URL;
    const prevDashboard = process.env.DASHBOARD_URL;
    delete process.env.APP_URL;
    process.env.DASHBOARD_URL = "https://dashboard.example.test/";
    try {
      const html = "<!doctype html><html><head><title>CSP</title></head><body></body></html>";
      const post = await fetch(`${BASE}/api/pages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: "dashboard-url-csp",
          title: "Dashboard URL CSP",
          contentType: "text/html",
          authMode: "public",
          body: html,
        }),
      });
      expect(post.status).toBe(201);
      const { id } = (await post.json()) as { id: string };

      const res = await fetch(`${BASE}/p/${id}`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy");
      const frameAncestors =
        csp?.split(";").find((d) => d.trim().startsWith("frame-ancestors ")) ?? "";
      expect(frameAncestors).toContain("https://dashboard.example.test");
    } finally {
      if (prevApp === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevApp;
      if (prevDashboard === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = prevDashboard;
    }
  });

  test("public JSON page 302-redirects to SPA artifact route", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "public-json",
        title: "Public JSON",
        contentType: "application/json",
        authMode: "public",
        body: JSON.stringify({ kind: "spec" }),
      }),
    });
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toContain(`/pages/${id}`);
  });

  test("/p/:id.json returns page metadata + body as JSON", async () => {
    const html = "<h1>jsonable</h1>";
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "public-json-renderer",
        title: "JSON Endpoint",
        description: "for the SPA renderer",
        contentType: "text/html",
        authMode: "public",
        body: html,
      }),
    });
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("application/json");
    const json = (await res.json()) as {
      id: string;
      title: string;
      contentType: string;
      authMode: string;
      body: string;
      description?: string;
    };
    expect(json.id).toBe(id);
    expect(json.title).toBe("JSON Endpoint");
    expect(json.description).toBe("for the SPA renderer");
    expect(json.contentType).toBe("text/html");
    expect(json.authMode).toBe("public");
    expect(json.body).toBe(html);
  });

  test("404 for unknown page id", async () => {
    const res = await fetch(`${BASE}/p/${"0".repeat(32)}`);
    expect(res.status).toBe(404);
  });
});
