import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-task-title-route.sqlite";

let server: Server;
let baseUrl: string;
let agentId: string;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "task-title-route-test" });
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "task-title-route-worker", isLead: false, status: "idle" }).id;

  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
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

describe("PATCH /api/tasks/{id}/title", () => {
  test("sets a title and returns the updated task", async () => {
    const task = createTaskExtended("some session prompt", { agentId });

    const res = await api("PATCH", `/api/tasks/${task.id}/title`, { title: "My renamed session" });
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(task.id);
    expect(res.body.task.title).toBe("My renamed session");
  });

  test("empty string clears the title", async () => {
    const task = createTaskExtended("another session prompt", { agentId });
    await api("PATCH", `/api/tasks/${task.id}/title`, { title: "Temporary title" });

    const cleared = await api("PATCH", `/api/tasks/${task.id}/title`, { title: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.title).toBeUndefined();
  });

  test("null clears the title", async () => {
    const task = createTaskExtended("yet another session prompt", { agentId });
    await api("PATCH", `/api/tasks/${task.id}/title`, { title: "Temporary title" });

    const cleared = await api("PATCH", `/api/tasks/${task.id}/title`, { title: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.title).toBeUndefined();
  });

  test("unknown task id returns 404", async () => {
    const res = await api("PATCH", "/api/tasks/nonexistent-task-id/title", { title: "x" });
    expect(res.status).toBe(404);
  });

  test("title over 120 chars is rejected", async () => {
    const task = createTaskExtended("long title test prompt", { agentId });
    const res = await api("PATCH", `/api/tasks/${task.id}/title`, { title: "x".repeat(121) });
    expect(res.status).toBe(400);
  });
});
