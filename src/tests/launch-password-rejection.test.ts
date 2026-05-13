/**
 * `POST /api/pages/:id/launch` must reject `auth_mode='password'` pages with
 * 400 — password pages mint their own cookie out of the public `/p/:id`
 * route (step-5) after verifying the password. Letting a bearer-only caller
 * mint a cookie via `/launch` would bypass the password check entirely.
 *
 * In-process variant of the launch endpoint; matches the test wiring used by
 * `pages-public-html.test.ts` and friends.
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

const TEST_DB_PATH = "./test-launch-password-rejection.sqlite";
const TEST_PORT = 13050;
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

describe("POST /api/pages/:id/launch — password mode rejection (step-4)", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "test-launch-password-rejection-secret";
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

  test("password page → launch returns 400 with explanatory error", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "password-reject",
        title: "Password",
        contentType: "text/html",
        authMode: "password",
        password: "swordfish",
        body: "<h1>locked</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(400);
    const body = (await launch.json()) as { error: string };
    expect(body.error).toContain("use ?key=");
    // Confirm no cookie was issued on the rejected launch.
    expect(launch.headers.get("set-cookie")).toBeNull();
  });

  test("authed page → launch still issues a cookie (negative control)", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "authed-ok",
        title: "Authed",
        contentType: "text/html",
        authMode: "authed",
        body: "<h1>ok</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    expect(launch.headers.get("set-cookie")).toContain("page_session=");
  });

  test("public page → launch still issues a cookie (uniform path)", async () => {
    const post = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "public-ok",
        title: "Public",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>open</h1>",
      }),
    });
    expect(post.status).toBe(201);
    const { id } = (await post.json()) as { id: string };

    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    expect(launch.headers.get("set-cookie")).toContain("page_session=");
  });
});
