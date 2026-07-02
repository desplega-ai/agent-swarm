/**
 * End-to-end coverage for `auth_mode='authed'` on `/p/:id` (step-4):
 *
 *   1. Create an authed HTML page.
 *   2. `GET /p/:id` without cookie → 401.
 *   3. `POST /api/pages/:id/launch` (bearer) → 204 + Set-Cookie.
 *   4. `GET /p/:id` with cookie → 200 + SDK injected.
 *   5. `GET /p/:id` with cookie scoped to a DIFFERENT page id → 403.
 *   6. `GET /p/:id.json` with cookie → 200 + JSON metadata.
 *
 * Uses the same in-process handler wiring as `pages-public-html.test.ts` so
 * we don't have to boot the full http server. The proxy in
 * `page-proxy.test.ts` exercises the spawned-server bearer-gate path; here
 * we're just verifying the cookie-gate at `/p/:id`.
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
import { signPageSession } from "../utils/page-session";

const TEST_DB_PATH = "./test-pages-authed-mode.sqlite";
const TEST_PORT = 13049;
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

/** Pull the cookie value out of a Set-Cookie header line. */
function extractCookieValue(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const match = /page_session=([^;]+)/.exec(setCookie!);
  expect(match).toBeTruthy();
  return match![1]!;
}

describe("GET /p/:id — authed mode cookie gate (step-4)", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

  // Set the page-session secret BEFORE the server boots so signPageSession()
  // in the launch handler picks it up. The test re-uses API_KEY fallback too.
  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "test-authed-mode-secret-xyz";
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
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  async function createAuthedPage(slug: string, body = "<h1>secret</h1>"): Promise<string> {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        title: `Authed ${slug}`,
        contentType: "text/html",
        authMode: "authed",
        body,
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };
    return id;
  }

  test("no cookie → 401 with cookie-required guidance", async () => {
    const id = await createAuthedPage("no-cookie");
    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cookie");
  });

  test("launch issues cookie → /p/:id with cookie → 200 + SDK", async () => {
    const id = await createAuthedPage(
      "with-cookie",
      "<!doctype html><body><h1>private</h1></body>",
    );

    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    const cookieValue = extractCookieValue(launch.headers.get("set-cookie"));

    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Cookie: `page_session=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<h1>private</h1>");
    // BROWSER_SDK_JS sentinel — confirms injection happened on the authed
    // branch, not just the public one.
    expect(text).toContain("class SwarmSDK");
  });

  test("cookie scoped to a different page id → 403", async () => {
    const idA = await createAuthedPage("page-a");
    const idB = await createAuthedPage("page-b");

    // Mint a cookie for page A …
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tokenForA = await signPageSession({ pageId: idA, exp });

    // … and try to use it for page B.
    const res = await fetch(`${BASE}/p/${idB}`, {
      headers: { Cookie: `page_session=${tokenForA}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("different page id");
  });

  test("/p/:id.json with cookie → 200 + JSON metadata", async () => {
    const id = await createAuthedPage("json-meta");
    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    const cookieValue = extractCookieValue(launch.headers.get("set-cookie"));

    const res = await fetch(`${BASE}/p/${id}.json`, {
      headers: { Cookie: `page_session=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("application/json");
    const json = (await res.json()) as {
      id: string;
      authMode: string;
      contentType: string;
      body: string;
    };
    expect(json.id).toBe(id);
    expect(json.authMode).toBe("authed");
    expect(json.contentType).toBe("text/html");
    expect(json.body).toContain("<h1>secret</h1>");
  });

  test("/p/:id.json WITHOUT cookie → 401", async () => {
    const id = await createAuthedPage("json-no-cookie");
    const res = await fetch(`${BASE}/p/${id}.json`);
    expect(res.status).toBe(401);
  });

  test("HTML page /p/:id?print=1 with cookie → 200 + self-print snippet", async () => {
    const id = await createAuthedPage(
      "html-print",
      "<!doctype html><body><h1>printable</h1></body>",
    );
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = await signPageSession({ pageId: id, exp });

    const res = await fetch(`${BASE}/p/${id}?print=1`, {
      headers: { Cookie: `page_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<h1>printable</h1>");
    // Auto-print snippet appended so the page prints itself in the browser.
    expect(text).toContain("window.print()");
  });

  test("JSON page /p/:id?print=1 with cookie → 200 standalone (no 302) + pretty JSON", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "json-print",
        title: "Authed json-print",
        contentType: "application/json",
        authMode: "authed",
        body: JSON.stringify({ hello: "world", nested: { count: 1 } }),
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = await signPageSession({ pageId: id, exp });

    const res = await fetch(`${BASE}/p/${id}?print=1`, {
      headers: { Cookie: `page_session=${cookie}` },
      redirect: "manual",
    });
    // Without `?print=1` a JSON page 302s to the SPA; the print view is served
    // inline as standalone HTML instead.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    const text = await res.text();
    // Pretty-printed (2-space indent) inside the printable <pre>.
    expect(text).toContain("  &quot;hello&quot;: &quot;world&quot;");
    expect(text).toContain("window.print()");
  });

  test("expired cookie → 401 (HMAC actually verified, not just presence)", async () => {
    const id = await createAuthedPage("expired");
    const expired = await signPageSession({
      pageId: id,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Cookie: `page_session=${expired}` },
    });
    expect(res.status).toBe(401);
  });

  test("tampered signature → 401", async () => {
    const id = await createAuthedPage("tampered");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const good = await signPageSession({ pageId: id, exp });
    const [head, sig] = good.split(".");
    // Flip a decoded HMAC byte rather than a base64url char — flipping the
    // last char is flaky (see src/tests/page-session.test.ts for why).
    const sigBytes = Buffer.from(sig!, "base64url");
    sigBytes[0] ^= 0x01;
    const tamperedSig = sigBytes.toString("base64url").replace(/=/g, "");
    const bad = `${head}.${tamperedSig}`;
    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Cookie: `page_session=${bad}` },
    });
    expect(res.status).toBe(401);
  });
});
