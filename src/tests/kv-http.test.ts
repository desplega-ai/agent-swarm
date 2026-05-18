// REST surface for /api/kv/*. Spins up a real HTTP server with the same
// auth → handleKv pipeline as `src/http/index.ts` so we exercise the bearer
// gate, header parsing, content-length cap, namespace resolution and auth.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, getDb, initDb } from "../be/db";
import { handleCore } from "../http/core";
import { handleKv } from "../http/kv";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { slackContextKey as buildSlackContextKey } from "../tasks/context-key";

const TEST_DB_PATH = "./test-kv-http.sqlite";
const API_KEY = "test-kv-key";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleKv(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
let agentId: string;
let otherAgentId: string;
let leadAgentId: string;
let slackTaskId: string;
let slackContextKey: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer(API_KEY);
  port = await listen(server);

  const a = createAgent({ name: "kv-test-a", isLead: false, status: "idle" });
  const b = createAgent({ name: "kv-test-b", isLead: false, status: "idle" });
  const lead = createAgent({ name: "kv-test-lead", isLead: true, status: "idle" });
  agentId = a.id;
  otherAgentId = b.id;
  leadAgentId = lead.id;

  slackContextKey = buildSlackContextKey({
    channelId: "CKVTEST",
    threadTs: "1700000000.123456",
  });
  const slackTask = createTaskExtended("kv test task", {
    agentId,
    source: "mcp",
    slackChannelId: "CKVTEST",
    slackThreadTs: "1700000000.123456",
    slackUserId: "UKV",
    contextKey: slackContextKey,
  });
  slackTaskId = slackTask.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries");
});

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}

function authedFetch(
  path: string,
  init: RequestInit & { agentId?: string; sourceTaskId?: string; pageId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.agentId !== undefined) headers["X-Agent-ID"] = init.agentId;
  if (init.sourceTaskId !== undefined) headers["X-Source-Task-Id"] = init.sourceTaskId;
  if (init.pageId !== undefined) headers["X-Page-Id"] = init.pageId;
  return fetch(url(path), { ...init, headers });
}

describe("/api/kv REST — auth", () => {
  test("401 without Authorization header", async () => {
    const res = await fetch(url("/api/kv/foo"), { headers: { "X-Agent-ID": agentId } });
    expect(res.status).toBe(401);
  });

  test("400 when no resolvable namespace header is provided", async () => {
    const res = await authedFetch("/api/kv/foo");
    expect(res.status).toBe(400);
  });
});

describe("/api/kv REST — header-resolved namespace", () => {
  test("PUT + GET round-trip on agent namespace", async () => {
    const put = await authedFetch("/api/kv/note", {
      method: "PUT",
      body: JSON.stringify({ value: { hello: "world" } }),
      agentId,
    });
    expect(put.status).toBe(200);
    const stored = await put.json();
    expect(stored.namespace).toBe(`task:agent:${agentId}`);
    expect(stored.value).toEqual({ hello: "world" });

    const get = await authedFetch("/api/kv/note", { agentId });
    expect(get.status).toBe(200);
    const got = await get.json();
    expect(got.value).toEqual({ hello: "world" });
  });

  test("X-Source-Task-Id wins over X-Agent-ID — namespace is the task's contextKey", async () => {
    const put = await authedFetch("/api/kv/cursor", {
      method: "PUT",
      body: JSON.stringify({ value: 42, valueType: "integer" }),
      agentId,
      sourceTaskId: slackTaskId,
    });
    expect(put.status).toBe(200);
    const stored = await put.json();
    expect(stored.namespace).toBe(slackContextKey);

    // Reading with the same headers finds the entry...
    const get1 = await authedFetch("/api/kv/cursor", { agentId, sourceTaskId: slackTaskId });
    expect(get1.status).toBe(200);

    // ...but reading with only the agent header doesn't (different ns).
    const get2 = await authedFetch("/api/kv/cursor", { agentId });
    expect(get2.status).toBe(404);
  });

  test("DELETE returns 204 then 404", async () => {
    await authedFetch("/api/kv/gone", {
      method: "PUT",
      body: JSON.stringify({ value: "soon", valueType: "string" }),
      agentId,
    });
    const del1 = await authedFetch("/api/kv/gone", { method: "DELETE", agentId });
    expect(del1.status).toBe(204);
    const del2 = await authedFetch("/api/kv/gone", { method: "DELETE", agentId });
    expect(del2.status).toBe(404);
  });

  test("POST /incr creates and increments", async () => {
    const r1 = await authedFetch("/api/kv/votes/incr", {
      method: "POST",
      body: JSON.stringify({ by: 3 }),
      agentId,
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()).value).toBe(3);

    const r2 = await authedFetch("/api/kv/votes/incr", {
      method: "POST",
      body: JSON.stringify({}),
      agentId,
    });
    expect((await r2.json()).value).toBe(4);
  });

  test("POST /incr returns 409 on valueType collision", async () => {
    await authedFetch("/api/kv/obj", {
      method: "PUT",
      body: JSON.stringify({ value: { a: 1 } }),
      agentId,
    });
    const res = await authedFetch("/api/kv/obj/incr", {
      method: "POST",
      body: JSON.stringify({}),
      agentId,
    });
    expect(res.status).toBe(409);
  });

  test("GET /api/kv lists with prefix + total", async () => {
    await authedFetch("/api/kv/a-1", {
      method: "PUT",
      body: JSON.stringify({ value: 1, valueType: "integer" }),
      agentId,
    });
    await authedFetch("/api/kv/a-2", {
      method: "PUT",
      body: JSON.stringify({ value: 2, valueType: "integer" }),
      agentId,
    });
    await authedFetch("/api/kv/b-1", {
      method: "PUT",
      body: JSON.stringify({ value: 3, valueType: "integer" }),
      agentId,
    });

    const r = await authedFetch("/api/kv?prefix=a-&limit=10", { agentId });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.entries.map((e: { key: string }) => e.key)).toEqual(["a-1", "a-2"]);
    expect(body.total).toBe(2);
    expect(body.namespace).toBe(`task:agent:${agentId}`);
  });
});

describe("/api/kv REST — explicit namespace shape", () => {
  test("PUT then GET under /_/{namespace}/{key}", async () => {
    const ns = "swarm:test:explicit";
    const put = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/foo`, {
      method: "PUT",
      body: JSON.stringify({ value: "hi", valueType: "string" }),
      agentId,
    });
    expect(put.status).toBe(200);
    const get = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/foo`, {
      agentId,
    });
    expect(get.status).toBe(200);
    expect((await get.json()).value).toBe("hi");
  });

  test("list with explicit namespace", async () => {
    const ns = "swarm:test:explicit-list";
    await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, {
      method: "PUT",
      body: JSON.stringify({ value: 1, valueType: "integer" }),
      agentId,
    });
    const r = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}`, { agentId });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.namespace).toBe(ns);
    expect(body.total).toBe(1);
  });
});

describe("/api/kv REST — auth on writes", () => {
  test("403 when writing to another agent's namespace", async () => {
    const ns = `task:agent:${otherAgentId}`;
    const res = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, {
      method: "PUT",
      body: JSON.stringify({ value: 1 }),
      agentId,
    });
    expect(res.status).toBe(403);
  });

  test("lead can write to any agent's namespace", async () => {
    const ns = `task:agent:${otherAgentId}`;
    const res = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, {
      method: "PUT",
      body: JSON.stringify({ value: 1 }),
      agentId: leadAgentId,
    });
    expect(res.status).toBe(200);
  });

  test("any agent can READ another agent's namespace", async () => {
    const ns = `task:agent:${otherAgentId}`;
    // Seed via lead
    await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, {
      method: "PUT",
      body: JSON.stringify({ value: "hi", valueType: "string" }),
      agentId: leadAgentId,
    });
    const r = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, { agentId });
    expect(r.status).toBe(200);
    expect((await r.json()).value).toBe("hi");
  });

  test("403 when writing to task:page:* without an X-Page-Id header", async () => {
    const ns = "task:page:abc";
    const res = await authedFetch(`/api/kv/_/${encodeURIComponent(ns)}/k`, {
      method: "PUT",
      body: JSON.stringify({ value: 1 }),
      agentId,
    });
    expect(res.status).toBe(403);
  });
});

describe("/api/kv REST — body cap", () => {
  test("413 when Content-Length > 2 MiB", async () => {
    // Build a body that exceeds 2 MiB and signal it via Content-Length.
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const body = JSON.stringify({ value: big, valueType: "string" });
    const res = await fetch(url("/api/kv/big"), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "X-Agent-ID": agentId,
        "Content-Length": String(body.length),
      },
      body,
    });
    expect(res.status).toBe(413);
  });
});
