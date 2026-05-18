// Header-precedence matrix for KV namespace resolution.
// Exercises the same paths as kv-http but focuses on which header wins.

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
import { githubContextKey, linearContextKey, slackContextKey } from "../tasks/context-key";

const TEST_DB_PATH = "./test-kv-ns-resolution.sqlite";
const API_KEY = "test-kv-ns-key";

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

let server: Server;
let port: number;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleKv(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  port = await listen(server);
  const a = createAgent({ name: "kv-ns-test", isLead: false, status: "idle" });
  agentId = a.id;
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

function authedPut(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url(path), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("kv namespace resolution — header precedence", () => {
  test("X-Source-Task-Id with Slack contextKey wins", async () => {
    const ns = slackContextKey({ channelId: "CABC", threadTs: "1700000000.000001" });
    const task = createTaskExtended("slack-test", {
      agentId,
      source: "mcp",
      slackChannelId: "CABC",
      slackThreadTs: "1700000000.000001",
      slackUserId: "UABC",
      contextKey: ns,
    });
    const res = await authedPut(
      "/api/kv/note",
      { value: "slack-val", valueType: "string" },
      { "X-Agent-ID": agentId, "X-Source-Task-Id": task.id },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).namespace).toBe(ns);
  });

  test("X-Source-Task-Id with Linear contextKey wins", async () => {
    const ns = linearContextKey({ issueIdentifier: "DES-99" });
    const task = createTaskExtended("linear-test", {
      agentId,
      source: "mcp",
      contextKey: ns,
    });
    const res = await authedPut(
      "/api/kv/note",
      { value: "linear-val", valueType: "string" },
      { "X-Agent-ID": agentId, "X-Source-Task-Id": task.id },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).namespace).toBe(ns);
  });

  test("X-Source-Task-Id with GitHub contextKey wins", async () => {
    const ns = githubContextKey({
      owner: "desplega-ai",
      repo: "agent-swarm",
      kind: "pr",
      number: 999,
    });
    const task = createTaskExtended("gh-test", {
      agentId,
      source: "mcp",
      contextKey: ns,
    });
    const res = await authedPut(
      "/api/kv/note",
      { value: "gh-val", valueType: "string" },
      { "X-Agent-ID": agentId, "X-Source-Task-Id": task.id },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).namespace).toBe(ns);
  });

  test("falls back to task:agent:<id> when X-Source-Task-Id is absent", async () => {
    const res = await authedPut(
      "/api/kv/note",
      { value: "agent-val", valueType: "string" },
      { "X-Agent-ID": agentId },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).namespace).toBe(`task:agent:${agentId}`);
  });

  test("falls back to agent ns when X-Source-Task-Id points at an unknown task", async () => {
    const res = await authedPut(
      "/api/kv/note",
      { value: "fb", valueType: "string" },
      { "X-Agent-ID": agentId, "X-Source-Task-Id": "00000000-0000-4000-8000-000000000000" },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).namespace).toBe(`task:agent:${agentId}`);
  });

  test("400 when no usable header is provided", async () => {
    const res = await authedPut("/api/kv/note", { value: "x", valueType: "string" }, {});
    expect(res.status).toBe(400);
  });
});
