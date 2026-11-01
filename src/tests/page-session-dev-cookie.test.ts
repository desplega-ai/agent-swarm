/**
 * The page-session cookie may only drop `Secure` (SameSite=Lax) for an explicit
 * development or test NODE_ENV and a request from http://localhost or
 * http://127.0.0.1. Deployed images leave NODE_ENV unset, so unset must issue
 * `SameSite=None; Secure`, and the localhost check must parse the origin
 * instead of matching a string prefix.
 *
 * Covers both issuers: the launch endpoint (`src/http/pages.ts`) and the
 * password flow on `/p/:id` (`src/http/pages-public.ts`).
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
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { isLocalDevPageRequest } from "../utils/page-session";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-page-session-dev-cookie.sqlite";
const PASSWORD = "example-swordfish";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
}

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

type Case = { name: string; nodeEnv: string | undefined; origin?: string; secure: boolean };

const CASES: Case[] = [
  { name: "NODE_ENV unset, no Origin", nodeEnv: undefined, secure: true },
  {
    name: "NODE_ENV unset, spoofed localhost prefix",
    nodeEnv: undefined,
    origin: "http://localhost.evil.example",
    secure: true,
  },
  {
    name: "NODE_ENV unset, real localhost origin",
    nodeEnv: undefined,
    origin: "http://localhost:5274",
    secure: true,
  },
  {
    name: "NODE_ENV=development, spoofed localhost prefix",
    nodeEnv: "development",
    origin: "http://localhost.evil.example",
    secure: true,
  },
  {
    name: "NODE_ENV=development, portless https origin",
    nodeEnv: "development",
    origin: "https://ui.swarm.localhost",
    secure: true,
  },
  {
    name: "NODE_ENV=development, localhost UI origin",
    nodeEnv: "development",
    origin: "http://localhost:5274",
    secure: false,
  },
  {
    name: "NODE_ENV=development, 127.0.0.1 UI origin",
    nodeEnv: "development",
    origin: "http://127.0.0.1:5274",
    secure: false,
  },
];

function expectCookieShape(cookie: string | null, secure: boolean): void {
  expect(cookie).toContain("page_session_");
  if (secure) {
    expect(cookie!).toContain("SameSite=None");
    expect(cookie!).toMatch(/\bSecure\b/);
  } else {
    expect(cookie!).toContain("SameSite=Lax");
    expect(cookie!).not.toMatch(/\bSecure\b/);
  }
}

describe("page-session cookie dev softening fails closed", () => {
  let server: Server;
  let base = "";
  let authedId = "";
  let passwordId = "";
  const agentId = crypto.randomUUID();

  async function createPage(body: Record<string, unknown>): Promise<string> {
    const post = await fetch(`${base}/api/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({ contentType: "text/html", body: "<h1>x</h1>", ...body }),
    });
    expect(post.status).toBe(201);
    return ((await post.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    process.env.PAGE_SESSION_SECRET = "example-test-page-session-dev-cookie-secret";
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = createTestServer();
    const port = await listenOnFreePort(server);
    base = `http://localhost:${port}`;
    authedId = await createPage({ slug: "dev-cookie-authed", title: "A", authMode: "authed" });
    passwordId = await createPage({
      slug: "dev-cookie-password",
      title: "P",
      authMode: "password",
      password: PASSWORD,
    });
  });

  afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

  afterAll(async () => {
    setNodeEnv(ORIGINAL_NODE_ENV);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test.each(CASES)("launch endpoint: $name", async ({ nodeEnv, origin, secure }) => {
    setNodeEnv(nodeEnv);
    const res = await fetch(`${base}/api/pages/${authedId}/launch`, {
      method: "POST",
      headers: { "X-Agent-ID": agentId, ...(origin ? { Origin: origin } : {}) },
    });
    expect(res.status).toBe(204);
    expectCookieShape(res.headers.get("set-cookie"), secure);
  });

  test.each(CASES)("/p/:id password flow: $name", async ({ nodeEnv, origin, secure }) => {
    setNodeEnv(nodeEnv);
    const res = await fetch(`${base}/p/${passwordId}?key=${PASSWORD}`, {
      redirect: "manual",
      headers: origin ? { Origin: origin } : {},
    });
    expect(res.status).toBeLessThan(400);
    expectCookieShape(res.headers.get("set-cookie"), secure);
  });
});

describe("isLocalDevPageRequest Host fallback", () => {
  afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

  test.each([
    [undefined, "localhost:3013", false],
    ["production", "localhost:3013", false],
    ["development", "localhost:3013", true],
    ["development", "127.0.0.1:3013", true],
    ["development", undefined, true],
    ["development", "localhost.evil.example", false],
    ["development", "localhost@evil.example", false],
    ["development", "api.swarm.localhost", false],
  ] as const)("NODE_ENV=%p Host=%p → %p", (nodeEnv, host, expected) => {
    setNodeEnv(nodeEnv);
    expect(isLocalDevPageRequest({ headers: host === undefined ? {} : { host } })).toBe(expected);
  });
});
