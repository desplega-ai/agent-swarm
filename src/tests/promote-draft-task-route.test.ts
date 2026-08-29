/**
 * HTTP-level coverage for the #1240 draft-task surface: `POST /api/tasks`
 * with `draft: true` and `POST /api/tasks/{id}/promote-draft`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, createUser, initDb } from "../be/db";
import { findUserById } from "../be/users";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-promote-draft-task-route.sqlite";

let server: Server;
let baseUrl: string;
let leadAgentId: string;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Tests opt into a "user" principal via `x-test-user-id`; otherwise the
    // request runs as a trusted operator (ownership checks pass through),
    // matching the existing task-title-route.test.ts pattern.
    const testUserId = req.headers["x-test-user-id"] as string | undefined;
    if (testUserId) {
      const user = await findUserById(testUserId);
      setRequestAuth(req, user ? { kind: "user", userId: user.id, user } : null);
    } else {
      setRequestAuth(req, { kind: "operator", fingerprint: "promote-draft-route-test" });
    }
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
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  leadAgentId = (
    await createAgent({ name: "promote-draft-route-lead", isLead: true, status: "idle" })
  ).id;

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

describe("POST /api/tasks draft:true + /promote-draft (#1240)", () => {
  test("draft:true creates a task in draft status, invisible to the assigned agent's dispatch queue", async () => {
    const created = await api("POST", "/api/tasks", {
      task: "session with attachments uploading",
      agentId: leadAgentId,
      source: "ui",
      draft: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(created.body.agentId).toBe(leadAgentId);

    // Session list surfacing (GET /api/sessions) isn't wired into handleTasks
    // — covered separately by listRecentSessions having no status filter.
  });

  test("promote-draft transitions draft -> pending for an owned task", async () => {
    const created = await api("POST", "/api/tasks", {
      task: "another draft session",
      agentId: leadAgentId,
      source: "ui",
      draft: true,
    });
    expect(created.body.status).toBe("draft");

    const promoted = await api("POST", `/api/tasks/${created.body.id}/promote-draft`);
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("pending");
    expect(promoted.body.agentId).toBe(leadAgentId);
  });

  test("promote-draft is idempotent — a second call returns the already-promoted task", async () => {
    const created = await api("POST", "/api/tasks", {
      task: "idempotency check",
      agentId: leadAgentId,
      source: "ui",
      draft: true,
    });

    const first = await api("POST", `/api/tasks/${created.body.id}/promote-draft`);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("pending");

    const second = await api("POST", `/api/tasks/${created.body.id}/promote-draft`);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("pending");
  });

  test("promote-draft on a task with no owner promotes to unassigned", async () => {
    const task = await createTaskExtended("owner-less draft", { status: "draft" });
    const promoted = await api("POST", `/api/tasks/${task.id}/promote-draft`);
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("unassigned");
  });

  test("unknown task id returns 404", async () => {
    const res = await api("POST", "/api/tasks/nonexistent-task-id/promote-draft");
    expect(res.status).toBe(404);
  });

  test("a user who did not request the task cannot promote it", async () => {
    const owner = await createUser({ name: "Draft Owner" });
    const stranger = await createUser({ name: "Not The Owner" });

    const created = await api(
      "POST",
      "/api/tasks",
      {
        task: "owned draft session",
        agentId: leadAgentId,
        source: "ui",
        draft: true,
        requestedByUserId: owner.id,
      },
      { "x-test-user-id": owner.id },
    );
    expect(created.body.status).toBe("draft");
    expect(created.body.requestedByUserId).toBe(owner.id);

    const deniedRes = await api("POST", `/api/tasks/${created.body.id}/promote-draft`, undefined, {
      "x-test-user-id": stranger.id,
    });
    expect(deniedRes.status).toBe(403);

    const allowedRes = await api("POST", `/api/tasks/${created.body.id}/promote-draft`, undefined, {
      "x-test-user-id": owner.id,
    });
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.body.status).toBe("pending");
  });
});
