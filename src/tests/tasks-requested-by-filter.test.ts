import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  getAllTasks,
  getTasksCount,
  initDb,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-tasks-requested-by-filter.sqlite";

let agentId: string;
let userAId: string;
let userBId: string;

describe("getAllTasks / getTasksCount requestedByUserId filter", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    agentId = (
      await createAgent({
        id: "requested-by-filter-agent",
        name: "Requested By Filter Agent",
        isLead: false,
        status: "idle",
      })
    ).id;
    userAId = (await createUser({ name: "User A", email: "user-a@example.com" })).id;
    userBId = (await createUser({ name: "User B", email: "user-b@example.com" })).id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("requestedByUserId=<id> filters to that requester's tasks only, list and count agree", async () => {
    const taskA = await createTaskExtended("task for user A", {
      agentId,
      requestedByUserId: userAId,
    });
    const taskB = await createTaskExtended("task for user B", {
      agentId,
      requestedByUserId: userBId,
    });
    const taskUnattributed = await createTaskExtended("task with no requester", { agentId });

    const listForA = await getAllTasks({ requestedByUserId: userAId, includeHeartbeat: true });
    const ids = listForA.map((t) => t.id);
    expect(ids).toContain(taskA.id);
    expect(ids).not.toContain(taskB.id);
    expect(ids).not.toContain(taskUnattributed.id);

    expect(await getTasksCount({ requestedByUserId: userAId, includeHeartbeat: true })).toBe(
      listForA.length,
    );
  });

  test("requestedByUserIdIsNull returns only unattributed rows, list and count agree", async () => {
    const taskA = await createTaskExtended("second task for user A", {
      agentId,
      requestedByUserId: userAId,
    });
    const taskUnattributed = await createTaskExtended("second task with no requester", { agentId });

    const nullList = await getAllTasks({ requestedByUserIdIsNull: true, includeHeartbeat: true });
    const ids = nullList.map((t) => t.id);
    expect(ids).toContain(taskUnattributed.id);
    expect(ids).not.toContain(taskA.id);
    expect(nullList.every((t) => !t.requestedByUserId)).toBe(true);

    expect(await getTasksCount({ requestedByUserIdIsNull: true, includeHeartbeat: true })).toBe(
      nullList.length,
    );
  });
});

// Route-level coverage for the HTTP handler wiring — the block above only
// exercises `getAllTasks`/`getTasksCount` directly, so it never proves the
// `GET /api/tasks` handler actually translates the `?requestedByUserId=none`
// sentinel into `requestedByUserIdIsNull`, or that the omitted-param path
// stays backwards compatible.
const ROUTE_TEST_DB_PATH = "./test-tasks-requested-by-filter-route.sqlite";
const ROUTE_API_KEY = "test-tasks-requested-by-filter-route";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleTasks(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

describe("GET /api/tasks — requestedByUserId route wiring", () => {
  let server: Server;
  let port: number;
  let routeAgentId: string;
  let routeUserId: string;

  beforeAll(async () => {
    await removeDbFiles(ROUTE_TEST_DB_PATH);
    initDb(ROUTE_TEST_DB_PATH);
    routeAgentId = (
      await createAgent({
        name: "route-requested-by-filter-agent",
        isLead: false,
        status: "idle",
      })
    ).id;
    routeUserId = (await createUser({ name: "Route User", email: "route-user@example.com" })).id;
    server = createTestServer(ROUTE_API_KEY);
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeDbFiles(ROUTE_TEST_DB_PATH);
  });

  function listTasks(query: string): Promise<Response> {
    return fetch(`http://localhost:${port}/api/tasks?includeHeartbeat=true${query}`, {
      headers: {
        Authorization: `Bearer ${ROUTE_API_KEY}`,
        "X-Agent-ID": routeAgentId,
      },
    });
  }

  test("omitted param returns all rows (attributed and unattributed)", async () => {
    const attributed = await createTaskExtended("route test — attributed", {
      agentId: routeAgentId,
      requestedByUserId: routeUserId,
    });
    const unattributed = await createTaskExtended("route test — unattributed", {
      agentId: routeAgentId,
    });

    const res = await listTasks("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[]; total: number };
    const ids = body.tasks.map((t) => t.id);
    expect(ids).toContain(attributed.id);
    expect(ids).toContain(unattributed.id);
  });

  test("requestedByUserId=none returns only NULL rows", async () => {
    const attributed = await createTaskExtended("route test — attributed for none-filter", {
      agentId: routeAgentId,
      requestedByUserId: routeUserId,
    });
    const unattributed = await createTaskExtended("route test — unattributed for none-filter", {
      agentId: routeAgentId,
    });

    const res = await listTasks("&requestedByUserId=none");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string; requestedByUserId?: string }[] };
    const ids = body.tasks.map((t) => t.id);
    expect(ids).toContain(unattributed.id);
    expect(ids).not.toContain(attributed.id);
    expect(body.tasks.every((t) => !t.requestedByUserId)).toBe(true);
  });

  test("requestedByUserId=<unknown id> returns an empty list and zero total", async () => {
    await createTaskExtended("route test — attributed for unknown-id filter", {
      agentId: routeAgentId,
      requestedByUserId: routeUserId,
    });

    const res = await listTasks("&requestedByUserId=00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; total: number };
    expect(body.tasks).toEqual([]);
    expect(body.total).toBe(0);
  });
});
