/**
 * `PAGES_FRAME_ANCESTORS` widens `frame-ancestors` on `/p/:id` for PUBLIC
 * pages only, so an outside site (for example a blog) can iframe a chart.
 * Authed and password pages keep the app-origin-only header, and an unset
 * env leaves every header unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { getPageFrameAncestors, handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { signPageSession } from "../utils/page-session";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-frame-ancestors.sqlite";
const EMBEDDERS = "https://www.agent-swarm.dev https://agent-swarm.dev";
let BASE = "";

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

function frameAncestors(res: Response): string {
  const csp = res.headers.get("content-security-policy") ?? "";
  return csp.split(";").find((d) => d.trim().startsWith("frame-ancestors ")) ?? "";
}

describe("PAGES_FRAME_ANCESTORS on /p/:id", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };
  const ORIG = {
    PAGES_FRAME_ANCESTORS: process.env.PAGES_FRAME_ANCESTORS,
    APP_URL: process.env.APP_URL,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    PAGE_SESSION_SECRET: process.env.PAGE_SESSION_SECRET,
  };

  function restore(key: keyof typeof ORIG): void {
    if (ORIG[key] === undefined) delete process.env[key];
    else process.env[key] = ORIG[key];
  }

  async function createPage(
    slug: string,
    authMode: "public" | "authed" | "password",
  ): Promise<string> {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        title: slug,
        contentType: "text/html",
        authMode,
        ...(authMode === "password" ? { password: "swordfish" } : {}),
        body: "<!doctype html><html><head></head><body><h1>chart</h1></body></html>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };
    return id;
  }

  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "example-test-frame-ancestors-secret";
    process.env.APP_URL = "https://app.example.test";
    delete process.env.DASHBOARD_URL;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = createTestServer();
    const port = await listenOnFreePort(server);
    BASE = `http://localhost:${port}`;
  });

  afterEach(() => restore("PAGES_FRAME_ANCESTORS"));

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const key of Object.keys(ORIG) as (keyof typeof ORIG)[]) restore(key);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("public page gets the configured origins", async () => {
    process.env.PAGES_FRAME_ANCESTORS = EMBEDDERS;
    const id = await createPage("public-embed", "public");
    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(200);
    const fa = frameAncestors(res);
    expect(fa).toContain("'self'");
    expect(fa).toContain("https://app.example.test");
    expect(fa).toContain("https://www.agent-swarm.dev");
    expect(fa).toContain("https://agent-swarm.dev");
  });

  test("authed page keeps the app-origin-only header", async () => {
    const id = await createPage("authed-embed", "authed");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = `page_session_${id}=${await signPageSession({ pageId: id, exp })}`;

    const before = frameAncestors(await fetch(`${BASE}/p/${id}`, { headers: { cookie } }));
    process.env.PAGES_FRAME_ANCESTORS = EMBEDDERS;
    const res = await fetch(`${BASE}/p/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(frameAncestors(res)).toBe(before);
    expect(frameAncestors(res)).not.toContain("agent-swarm.dev");
  });

  test("password page keeps the app-origin-only header", async () => {
    process.env.PAGES_FRAME_ANCESTORS = EMBEDDERS;
    const id = await createPage("password-embed", "password");
    const res = await fetch(`${BASE}/p/${id}?key=swordfish`);
    expect(res.status).toBe(200);
    expect(frameAncestors(res)).not.toContain("agent-swarm.dev");
  });

  test("unset env leaves the public header unchanged", async () => {
    const id = await createPage("public-unset", "public");
    delete process.env.PAGES_FRAME_ANCESTORS;
    const unset = frameAncestors(await fetch(`${BASE}/p/${id}`));
    process.env.PAGES_FRAME_ANCESTORS = "";
    const blank = frameAncestors(await fetch(`${BASE}/p/${id}`));
    expect(unset).toContain("https://app.example.test");
    expect(unset).not.toContain("agent-swarm.dev");
    expect(blank).toBe(unset);
  });

  test("parser accepts comma or space lists and drops invalid entries", () => {
    process.env.PAGES_FRAME_ANCESTORS =
      "https://www.agent-swarm.dev/, https://*.example.com:8443 blog.example.org,* 'none' https://evil.test;script-src javascript:alert(1) https://x.test/path";
    expect(getPageFrameAncestors()).toEqual([
      "https://www.agent-swarm.dev",
      "https://*.example.com:8443",
      "blog.example.org",
    ]);
  });
});
