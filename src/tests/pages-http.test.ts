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

const TEST_DB_PATH = "./test-pages-http.sqlite";
const TEST_PORT = 13037;
const baseUrl = `http://localhost:${TEST_PORT}`;

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
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
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

  test("POST /api/pages creates a page and returns {id, version}", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Hello",
        contentType: "text/html",
        authMode: "public",
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
});
