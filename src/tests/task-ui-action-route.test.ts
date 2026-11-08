/**
 * `POST /api/tasks/{id}/ui-actions/{actionId}`: only the task requester, as a
 * user principal, runs a card action. Agent and operator callers get 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
} from "../be/db";
import { upsertTaskUiSpec } from "../be/task-ui-spec";
import { findUserById } from "../be/users";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-task-ui-action-route.sqlite";
const previousFlag = process.env.UI_SPEC_ACTIONS_ENABLED;

let server: Server;
let baseUrl: string;
let requesterId = "";
let otherUserId = "";
let workerAgentId = "";

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // `x-test-user-id` makes the request a user principal; otherwise it runs
    // on the operator key (with `X-Agent-ID` when a worker calls).
    const testUserId = req.headers["x-test-user-id"] as string | undefined;
    if (testUserId) {
      const user = await findUserById(testUserId);
      setRequestAuth(req, user ? { kind: "user", userId: user.id, user } : null);
    } else {
      setRequestAuth(req, { kind: "operator", fingerprint: "ui-action-route-test" });
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

async function click(
  taskId: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/ui-actions/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function taskWithButton(): Promise<string> {
  const task = await createTaskExtended("Weekly deploys", {
    source: "api",
    requestedByUserId: requesterId,
  });
  await upsertTaskUiSpec(task.id, {
    spec: {
      root: "c",
      elements: {
        c: { type: "Card", props: { title: "Deploys" }, children: ["a"] },
        a: { type: "Actions", props: {}, children: ["b"] },
        b: { type: "Button", props: { id: "rerun", label: "Run again" }, children: [] },
      },
    },
    actions: { rerun: { kind: "follow_up", prompt: "Run the weekly deploys report again." } },
    fallbackText: "Deploys",
  });
  return task.id;
}

async function followUpCount(taskId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE parentTaskId = ?",
    [taskId],
  );
  return row?.n ?? 0;
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  await createAgent({ name: "ui-action-route-lead", isLead: true, status: "idle" });
  workerAgentId = (
    await createAgent({ name: "ui-action-route-worker", isLead: false, status: "idle" })
  ).id;
  requesterId = (await createUser({ name: "Requester" })).id;
  otherUserId = (await createUser({ name: "Bystander" })).id;
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousFlag === undefined) delete process.env.UI_SPEC_ACTIONS_ENABLED;
  else process.env.UI_SPEC_ACTIONS_ENABLED = previousFlag;
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  process.env.UI_SPEC_ACTIONS_ENABLED = "true";
});

describe("POST /api/tasks/{id}/ui-actions/{actionId}", () => {
  test("the requester starts the action once", async () => {
    const taskId = await taskWithButton();
    const first = await click(taskId, { "x-test-user-id": requesterId });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("started");
    const second = await click(taskId, { "x-test-user-id": requesterId });
    expect(second.body.status).toBe("already_done");
    expect(await followUpCount(taskId)).toBe(1);
  });

  test("a dashboard tab on the operator key that picked the requester starts the action", async () => {
    const taskId = await taskWithButton();
    const result = await click(taskId, { "x-swarm-user-id": requesterId });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("started");
    expect(await followUpCount(taskId)).toBe(1);
  });

  test("an agent that names the requester in X-Swarm-User-Id still gets 403", async () => {
    const taskId = await taskWithButton();
    const result = await click(taskId, {
      "x-agent-id": workerAgentId,
      "x-swarm-user-id": requesterId,
    });
    expect(result.status).toBe(403);
    expect(await followUpCount(taskId)).toBe(0);
  });

  test("another user gets 403", async () => {
    const taskId = await taskWithButton();
    expect((await click(taskId, { "x-test-user-id": otherUserId })).status).toBe(403);
    expect(await followUpCount(taskId)).toBe(0);
  });

  test("an operator caller gets 403 and starts nothing", async () => {
    const taskId = await taskWithButton();
    expect((await click(taskId)).status).toBe(403);
    expect(await followUpCount(taskId)).toBe(0);
  });

  test("an agent caller gets 403 and starts nothing", async () => {
    const taskId = await taskWithButton();
    expect((await click(taskId, { "x-agent-id": workerAgentId })).status).toBe(403);
    expect(await followUpCount(taskId)).toBe(0);
  });
});
