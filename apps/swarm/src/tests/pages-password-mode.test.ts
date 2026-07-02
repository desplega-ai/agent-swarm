/**
 * End-to-end coverage for `auth_mode='password'` on `/p/:id` (step-5).
 *
 * Constant-time-comparison assumption: `Bun.password.verify` (bcrypt) is
 * documented constant-time. We rely on it; do NOT replace with a
 * naive-string-equality short-circuit on the password column.
 *
 * Scenarios:
 *   1. Plaintext password is hashed (DB row != "swordfish").
 *   2. GET /p/:id → 401 + WWW-Authenticate: Basic.
 *   3. GET /p/:id?key=wrong → 401.
 *   4. GET /p/:id?key=swordfish → 200 + Set-Cookie + body served + SDK injected.
 *   5. GET /p/:id with `Authorization: Basic <base64(x:swordfish)>` → 200 + Set-Cookie.
 *   6. GET /p/:id with the issued cookie → 200 (no re-prompt).
 *   7. GET /p/:id.json after cookie → 200 with metadata.
 *   8. Cross-page cookie reuse → 403 (cookie scoped to id).
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
import { closeDb, getPage, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-pages-password-mode.sqlite";
const TEST_PORT = 13051;
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

function extractCookieValue(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const match = /page_session=([^;]+)/.exec(setCookie!);
  expect(match).toBeTruthy();
  return match![1]!;
}

describe("GET /p/:id — password mode (step-5)", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "test-password-mode-secret";
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

  async function createPasswordPage(
    slug: string,
    password: string,
    body = "<h1>vault</h1>",
  ): Promise<string> {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        title: `Locked ${slug}`,
        contentType: "text/html",
        authMode: "password",
        password,
        body,
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };
    return id;
  }

  test("password is hashed in the DB row (passwordHash != plaintext)", async () => {
    const id = await createPasswordPage("hashed", "swordfish");
    const row = getPage(id);
    expect(row).toBeTruthy();
    // passwordHash field is private; should be bcrypt and clearly not the plaintext.
    expect(row!.passwordHash).toBeTruthy();
    expect(row!.passwordHash).not.toBe("swordfish");
    // bcrypt hashes start with $2 (e.g. $2a$, $2b$, $2y$).
    expect(row!.passwordHash!.startsWith("$2")).toBe(true);
  });

  test("GET /p/:id without anything → 401 + WWW-Authenticate Basic", async () => {
    const id = await createPasswordPage("no-creds", "swordfish");
    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(401);
    const wa = res.headers.get("www-authenticate") || "";
    expect(wa.toLowerCase()).toContain("basic");
    expect(wa).toContain(`page ${id}`);
  });

  test("GET /p/:id?key=wrong → 401 (with WWW-Authenticate for re-prompt)", async () => {
    const id = await createPasswordPage("wrong-key", "swordfish");
    const res = await fetch(`${BASE}/p/${id}?key=wrong`);
    expect(res.status).toBe(401);
    const wa = res.headers.get("www-authenticate") || "";
    expect(wa.toLowerCase()).toContain("basic");
  });

  test("GET /p/:id?key=<right> → 200 + Set-Cookie + body served + SDK injected", async () => {
    const id = await createPasswordPage(
      "right-key",
      "swordfish",
      "<!doctype html><body><h1>open sesame</h1></body>",
    );
    const res = await fetch(`${BASE}/p/${id}?key=swordfish`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.toLowerCase()).toContain("text/html");
    const cookieHeader = res.headers.get("set-cookie");
    expect(cookieHeader).toContain("page_session=");
    const text = await res.text();
    expect(text).toContain("<h1>open sesame</h1>");
    // BROWSER_SDK_JS sentinel.
    expect(text).toContain("class SwarmSDK");
  });

  test("GET /p/:id with Authorization: Basic <base64(x:swordfish)> → 200 + Set-Cookie", async () => {
    const id = await createPasswordPage(
      "basic-auth",
      "swordfish",
      "<!doctype html><body><h1>via basic</h1></body>",
    );
    const basic = Buffer.from("x:swordfish", "utf-8").toString("base64");
    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("page_session=");
    const text = await res.text();
    expect(text).toContain("<h1>via basic</h1>");
  });

  test("Basic auth with wrong password → 401 (constant-time path)", async () => {
    const id = await createPasswordPage("basic-wrong", "swordfish");
    const basic = Buffer.from("x:nope", "utf-8").toString("base64");
    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")?.toLowerCase()).toContain("basic");
  });

  test("GET /p/:id with issued cookie → 200 (no re-prompt; cookie is proof)", async () => {
    const id = await createPasswordPage("cookie-reuse", "swordfish");
    const first = await fetch(`${BASE}/p/${id}?key=swordfish`);
    expect(first.status).toBe(200);
    const cookieValue = extractCookieValue(first.headers.get("set-cookie"));

    // Subsequent request — no ?key=, no Basic, just the cookie.
    const second = await fetch(`${BASE}/p/${id}`, {
      headers: { Cookie: `page_session=${cookieValue}` },
    });
    expect(second.status).toBe(200);
    const text = await second.text();
    expect(text).toContain("<h1>vault</h1>");
  });

  test("GET /p/:id.json with issued cookie → 200 + JSON metadata", async () => {
    const id = await createPasswordPage("json-meta", "swordfish");
    const first = await fetch(`${BASE}/p/${id}?key=swordfish`);
    expect(first.status).toBe(200);
    const cookieValue = extractCookieValue(first.headers.get("set-cookie"));

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
    expect(json.authMode).toBe("password");
    // passwordHash MUST NOT leak through the JSON endpoint.
    expect(JSON.stringify(json)).not.toContain("$2");
  });

  test("GET /p/:id.json without cookie → 401 + WWW-Authenticate", async () => {
    const id = await createPasswordPage("json-401", "swordfish");
    const res = await fetch(`${BASE}/p/${id}.json`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")?.toLowerCase()).toContain("basic");
  });

  test("GET /p/:id.json?key=<right> → 200 + Set-Cookie (SPA metadata fetch path)", async () => {
    const id = await createPasswordPage("json-key", "swordfish");
    const res = await fetch(`${BASE}/p/${id}.json?key=swordfish`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("page_session=");
  });

  test("cross-page cookie reuse → 401 + password prompt (cookie is silently ignored for password mode)", async () => {
    const idA = await createPasswordPage("scope-a", "swordfish");
    const idB = await createPasswordPage("scope-b", "swordfish"); // same password, different id

    // Unlock A → get cookie.
    const unlockA = await fetch(`${BASE}/p/${idA}?key=swordfish`);
    expect(unlockA.status).toBe(200);
    const cookieForA = extractCookieValue(unlockA.headers.get("set-cookie"));

    // Use cookie from A on page B → 401 + WWW-Authenticate so the password
    // flow can recover (user re-enters the password). The cookie is stale
    // from the user's perspective; surfacing 403 here would trap the user
    // in a "scoped to different page" state with no way to recover.
    const res = await fetch(`${BASE}/p/${idB}`, {
      headers: { Cookie: `page_session=${cookieForA}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`Basic realm="page ${idB}"`);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("password required");

    // …and re-submitting with `?key=<right>` on page B should still work,
    // even with the stale cookie in flight.
    const recover = await fetch(`${BASE}/p/${idB}?key=swordfish`, {
      headers: { Cookie: `page_session=${cookieForA}` },
    });
    expect(recover.status).toBe(200);
    expect(recover.headers.get("set-cookie")).toContain("page_session=");
  });

  test("malformed Basic header (no colon) → 401 (no crash)", async () => {
    const id = await createPasswordPage("malformed-basic", "swordfish");
    const malformed = Buffer.from("no-colon-here", "utf-8").toString("base64");
    const res = await fetch(`${BASE}/p/${id}`, {
      headers: { Authorization: `Basic ${malformed}` },
    });
    expect(res.status).toBe(401);
  });
});
