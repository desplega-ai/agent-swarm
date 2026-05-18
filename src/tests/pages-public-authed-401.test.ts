/**
 * Authed-mode pages return 401 from `/p/:id` in step-3 — the cookie path
 * is added in step-4 (which will narrow this test by also accepting a
 * valid `page_session` cookie).
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

const TEST_DB_PATH = "./test-pages-public-authed-401.sqlite";
const TEST_PORT = 13044;
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

describe("GET /p/:id — authed mode returns 401 in step-3", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

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
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("authMode='authed' returns 401 with cookie-required guidance", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "authed-stub",
        title: "Authed",
        contentType: "text/html",
        authMode: "authed",
        body: "<h1>secret</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cookie");
  });

  test("authMode='password' returns 401 stub (step-5 lands the unlock)", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "pw-stub",
        title: "Password",
        contentType: "text/html",
        authMode: "password",
        password: "swordfish",
        body: "<h1>secret</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const res = await fetch(`${BASE}/p/${id}`);
    expect(res.status).toBe(401);
  });
});
