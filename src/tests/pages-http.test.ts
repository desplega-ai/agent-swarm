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
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Page } from "../types";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-http.sqlite";
let baseUrl = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    const handled = await handlePages(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("Pages HTTP API", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-ID": agentId,
  };

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);

    server = createTestServer();
    const port = await listenOnFreePort(server);
    baseUrl = `http://localhost:${port}`;
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

  test("POST /api/pages creates an authed page by default and returns {id, version}", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Hello",
        contentType: "text/html",
        body: "<h1>hi</h1>",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; version: number };
    expect(json.id).toMatch(/^[0-9a-f]{32}$/);
    expect(json.version).toBe(1);

    // Round-trip via GET
    const got = await fetch(`${baseUrl}/api/pages/${json.id}`, { headers });
    expect(got.status).toBe(200);
    const page = (await got.json()) as Page;
    expect(page.title).toBe("Hello");
    expect(page.body).toBe("<h1>hi</h1>");
    expect(page.agentId).toBe(agentId);
    expect(page.slug).toBe("hello"); // auto-slug from title
    expect(page.contentType).toBe("text/html");
    expect(page.authMode).toBe("authed");
  });

  test("POST /api/pages can explicitly opt in to public auth", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Public",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>public</h1>",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const got = await fetch(`${baseUrl}/api/pages/${json.id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.authMode).toBe("public");
  });

  test("POST /api/pages with full HTML document body is stored verbatim", async () => {
    const fullDoc =
      "<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>";
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "full-doc",
        title: "Full Doc",
        contentType: "text/html",
        authMode: "public",
        body: fullDoc,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.body).toBe(fullDoc);
  });

  test("POST /api/pages with password hashes the password", async () => {
    const password = "open-sesame-9";
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "pw-page",
        title: "Pw",
        contentType: "text/html",
        authMode: "password",
        password,
        body: "<h1>secret</h1>",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers });
    const page = (await got.json()) as Page;
    expect(page.passwordHash).toBeDefined();
    expect(page.passwordHash).not.toBe(password);
    expect(await Bun.password.verify(password, page.passwordHash!)).toBe(true);
  });

  test("POST /api/pages with duplicate slug → 409", async () => {
    const body = {
      slug: "dup-slug",
      title: "First",
      contentType: "text/html" as const,
      authMode: "public" as const,
      body: "<h1>1</h1>",
    };
    const first = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
  });

  test("POST /api/pages without X-Agent-ID → 400", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Anonymous",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>hi</h1>",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/pages with bad contentType → 400", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Bad",
        contentType: "image/png",
        authMode: "public",
        body: "x",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/pages/:id → 404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/pages/${"0".repeat(32)}`, { headers });
    expect(res.status).toBe(404);
  });

  // Regression coverage for CWE-639 (high-70bc9231): GET/PUT/DELETE
  // /api/pages/:id used to call getPage(id) and return/modify/delete it
  // without ever comparing the caller's agent to page.agentId — so any
  // agent-authenticated caller could read, overwrite, or delete another
  // agent's page (including password-protected bodies/hashes).
  describe("object-level authorization across agents", () => {
    const ownerId = crypto.randomUUID();
    const attackerId = crypto.randomUUID();
    const ownerHeaders = { "Content-Type": "application/json", "X-Agent-ID": ownerId };
    const attackerHeaders = { "Content-Type": "application/json", "X-Agent-ID": attackerId };

    async function createOwnedPage(): Promise<string> {
      const res = await fetch(`${baseUrl}/api/pages`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          slug: `owned-${crypto.randomUUID().slice(0, 8)}`,
          title: "Owner's page",
          contentType: "text/html",
          authMode: "authed",
          body: "<h1>owner only</h1>",
        }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      return id;
    }

    // Must-reject: cross-agent read.
    test("GET as a different agent → 403", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, { headers: attackerHeaders });
      expect(res.status).toBe(403);
    });

    // Must-reject: cross-agent overwrite (would also enable stored XSS via a
    // tampered body per the finding's impact).
    test("PUT as a different agent → 403, page left untouched", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "PUT",
        headers: attackerHeaders,
        body: JSON.stringify({ body: "<script>pwned</script>" }),
      });
      expect(res.status).toBe(403);

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      const page = (await got.json()) as Page;
      expect(page.body).toBe("<h1>owner only</h1>");
    });

    // Must-reject: cross-agent delete.
    test("DELETE as a different agent → 403, page still exists", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "DELETE",
        headers: attackerHeaders,
      });
      expect(res.status).toBe(403);

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      expect(got.status).toBe(200);
    });

    // Must-reject: cross-agent version-history read (same info-disclosure
    // class as GET — sibling code path fixed alongside the headline finding).
    test("GET /versions as a different agent → 403", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}/versions`, {
        headers: attackerHeaders,
      });
      expect(res.status).toBe(403);
    });

    // Positive path: the owning agent keeps full read/write/delete access.
    test("owner retains GET/PUT/DELETE access to its own page", async () => {
      const id = await createOwnedPage();

      const got = await fetch(`${baseUrl}/api/pages/${id}`, { headers: ownerHeaders });
      expect(got.status).toBe(200);

      const put = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "PUT",
        headers: ownerHeaders,
        body: JSON.stringify({ title: "Updated by owner" }),
      });
      expect(put.status).toBe(200);

      const del = await fetch(`${baseUrl}/api/pages/${id}`, {
        method: "DELETE",
        headers: ownerHeaders,
      });
      expect(del.status).toBe(204);
    });

    // Positive path: operator/dashboard callers (no X-Agent-ID) keep full
    // access, matching the existing convention in src/http/tasks.ts.
    test("operator caller (no X-Agent-ID) can still read/write any page", async () => {
      const id = await createOwnedPage();
      const res = await fetch(`${baseUrl}/api/pages/${id}`, {
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
    });
  });
});
