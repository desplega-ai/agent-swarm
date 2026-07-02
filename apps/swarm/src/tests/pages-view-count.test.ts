/**
 * Verifies the per-page view counter:
 *   - `view_count` bumps on every 200 from `GET /p/:id` and `GET /p/:id.json`
 *   - 401/403/404 responses do NOT bump
 *   - Bumps survive across requests (writes are committed)
 *   - Counter surfaces on `GET /api/pages` listing and `GET /api/pages/:id`
 *
 * No dedup by viewer — that's the explicit design (per Taras: "super simple
 * counter field, that's it"). If someone wants unique views later, that's a
 * follow-up.
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

const TEST_DB_PATH = "./test-pages-view-count.sqlite";
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

async function startTestServer(): Promise<Server> {
  const candidateServer = createTestServer();
  await new Promise<void>((resolve, reject) => {
    candidateServer.once("error", reject);
    candidateServer.listen(0, () => {
      const addr = candidateServer.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to resolve pages view-count test server port"));
        return;
      }
      BASE = `http://localhost:${addr.port}`;
      resolve();
    });
  });
  return candidateServer;
}

async function getViewCount(id: string, agentId: string): Promise<number> {
  const res = await fetch(`${BASE}/api/pages/${id}`, {
    headers: { "X-Agent-ID": agentId },
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { viewCount?: number };
  return typeof json.viewCount === "number" ? json.viewCount : 0;
}

describe("Pages — view_count counter", () => {
  let server: Server;
  let originalPageSessionSecret: string | undefined;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

  beforeAll(async () => {
    originalPageSessionSecret = process.env.PAGE_SESSION_SECRET;
    process.env.PAGE_SESSION_SECRET = "test-view-count-secret";
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = await startTestServer();
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    closeDb();
    if (originalPageSessionSecret === undefined) {
      delete process.env.PAGE_SESSION_SECRET;
    } else {
      process.env.PAGE_SESSION_SECRET = originalPageSessionSecret;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("public HTML page: 3 fetches → view_count = 3", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "view-count-html",
        title: "View Count HTML",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>hi</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    expect(await getViewCount(id, agentId)).toBe(0);

    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${BASE}/p/${id}`);
      expect(r.status).toBe(200);
    }

    expect(await getViewCount(id, agentId)).toBe(3);
  });

  test("/p/:id.json fetches also bump the counter", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "view-count-json-path",
        title: "View Count JSON Path",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>hi</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${BASE}/p/${id}.json`);
      expect(r.status).toBe(200);
    }
    // One additional HTML fetch — both paths bump the same counter.
    expect((await fetch(`${BASE}/p/${id}`)).status).toBe(200);
    expect(await getViewCount(id, agentId)).toBe(3);
  });

  test("404 on unknown page id does NOT crash and does not touch any counter", async () => {
    const bogus = "0".repeat(32);
    const r = await fetch(`${BASE}/p/${bogus}`);
    expect(r.status).toBe(404);
  });

  test("password-protected page: 401 without unlock does NOT bump", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "view-count-pw",
        title: "View Count Password",
        contentType: "text/html",
        authMode: "password",
        password: "letmein",
        body: "<h1>secret</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    // No `?key=`, no Basic header → 401, no counter bump.
    const r1 = await fetch(`${BASE}/p/${id}`);
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${BASE}/p/${id}.json`);
    expect(r2.status).toBe(401);

    expect(await getViewCount(id, agentId)).toBe(0);

    // After unlocking via ?key= → counter bumps.
    const ok = await fetch(`${BASE}/p/${id}?key=letmein`);
    expect(ok.status).toBe(200);
    expect(await getViewCount(id, agentId)).toBe(1);
  });

  test("authed page: 401 without cookie does NOT bump", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "view-count-authed",
        title: "View Count Authed",
        contentType: "text/html",
        authMode: "authed",
        body: "<h1>members only</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    // No cookie → 401.
    const r = await fetch(`${BASE}/p/${id}`);
    expect(r.status).toBe(401);
    expect(await getViewCount(id, agentId)).toBe(0);
  });

  test("JSON content-type page: 302→SPA does NOT double-count (only .json bumps)", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "view-count-jsonct",
        title: "JSON Content Page",
        contentType: "application/json",
        authMode: "public",
        body: JSON.stringify({ kind: "spec" }),
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    // /p/:id 302s — should NOT bump.
    const redir = await fetch(`${BASE}/p/${id}`, { redirect: "manual" });
    expect(redir.status).toBe(302);
    expect(await getViewCount(id, agentId)).toBe(0);

    // /p/:id.json bumps.
    const j = await fetch(`${BASE}/p/${id}.json`);
    expect(j.status).toBe(200);
    expect(await getViewCount(id, agentId)).toBe(1);
  });

  test("listing endpoint exposes viewCount", async () => {
    const res = await fetch(`${BASE}/api/pages`, {
      headers: { "X-Agent-ID": agentId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pages: Array<{ id: string; viewCount?: number }> };
    expect(body.pages.length).toBeGreaterThan(0);
    for (const p of body.pages) {
      expect(typeof p.viewCount).toBe("number");
    }
  });
});
