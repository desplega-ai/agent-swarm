import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { type HttpRequestAuth, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

// Regression: an agent got 200 from HTTP progress and HTTP cancel on another
// agent's in-progress task. Progress follows task.progress.write (assignee,
// lead, human); cancel follows the MCP cancel-task policy for agents (lead or
// creator). Humans and the keyed runner wrapper keep access.
const ownerId = "aaaa0000-0000-4000-8000-000000000b01";
const otherId = "bbbb0000-0000-4000-8000-000000000b02";
const creatorId = "cccc0000-0000-4000-8000-000000000b03";
const leadId = "dddd0000-0000-4000-8000-000000000b04";
const userId = "eeee0000-0000-4000-8000-000000000b05";

type Caller =
  | { as: "operator"; agentId?: string }
  | { as: "session"; agentId: string }
  | { as: "user" };

let server: Server;
let baseUrl: string;

function authFor(caller: Caller): HttpRequestAuth {
  if (caller.as === "session") {
    return { kind: "agent", agentId: caller.agentId, taskId: "session-task" };
  }
  if (caller.as === "user") {
    return { kind: "user", userId, user: { id: userId } as never };
  }
  return { kind: "operator", fingerprint: "http-task-write-ownership" };
}

async function post(path: string, caller: Caller, body: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-test-caller": JSON.stringify(caller),
  };
  if (caller.as === "operator" && caller.agentId) headers["X-Agent-ID"] = caller.agentId;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return response.status;
}

async function inProgressTask() {
  const row = await createTaskExtended("http write ownership", {
    agentId: ownerId,
    creatorAgentId: creatorId,
    source: "system",
    followUpConfig: { disabled: true },
  });
  await startTask(row.id);
  return row;
}

beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: ownerId, name: "Owner", isLead: false, status: "idle" });
  await createAgent({ id: otherId, name: "Other", isLead: false, status: "idle" });
  await createAgent({ id: creatorId, name: "Creator", isLead: false, status: "idle" });
  await createAgent({ id: leadId, name: "Lead", isLead: true, status: "idle" });

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const caller = JSON.parse(String(req.headers["x-test-caller"])) as Caller;
    setRequestAuth(req, authFor(caller));
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleTasks(req, res, pathSegments, query, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("POST /api/tasks/{id}/progress ownership", () => {
  test("another agent on the shared key gets 403 and writes nothing", async () => {
    const task = await inProgressTask();
    const status = await post(
      `/api/tasks/${task.id}/progress`,
      { as: "operator", agentId: otherId },
      { progress: "not mine" },
    );
    expect(status).toBe(403);
    expect((await getTaskById(task.id))?.progress).toBeUndefined();
  });

  test("another agent on a session token gets 403", async () => {
    const task = await inProgressTask();
    const status = await post(
      `/api/tasks/${task.id}/progress`,
      { as: "session", agentId: otherId },
      { progress: "not mine" },
    );
    expect(status).toBe(403);
    expect((await getTaskById(task.id))?.progress).toBeUndefined();
  });

  test("the assignee, a lead, the keyed runner wrapper, and a user may write", async () => {
    const task = await inProgressTask();
    const callers: Caller[] = [
      { as: "operator", agentId: ownerId },
      { as: "operator", agentId: leadId },
      { as: "operator" },
      { as: "user" },
    ];
    for (const [i, caller] of callers.entries()) {
      const status = await post(`/api/tasks/${task.id}/progress`, caller, {
        progress: `step ${i}`,
      });
      expect(status, JSON.stringify(caller)).toBe(200);
      expect((await getTaskById(task.id))?.progress).toBe(`step ${i}`);
    }
  });
});

describe("POST /api/tasks/{id}/progress on a terminal task", () => {
  test("late harness progress after completion is a no-op", async () => {
    const task = await inProgressTask();
    const caller: Caller = { as: "operator", agentId: ownerId };
    expect(await post(`/api/tasks/${task.id}/progress`, caller, { progress: "Reading" })).toBe(200);
    await completeTask(task.id, "done");
    expect(await post(`/api/tasks/${task.id}/progress`, caller, { progress: "step_end" })).toBe(
      200,
    );
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("completed");
    expect(after?.progress).toBe("Reading");
  });
});

describe("POST /api/tasks/{id}/cancel ownership", () => {
  test("an agent that is neither lead nor creator gets 403 and the task keeps running", async () => {
    const task = await inProgressTask();
    const status = await post(
      `/api/tasks/${task.id}/cancel`,
      { as: "operator", agentId: otherId },
      { reason: "not mine" },
    );
    expect(status).toBe(403);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("the assignee alone cannot cancel, matching MCP cancel-task", async () => {
    const task = await inProgressTask();
    const status = await post(
      `/api/tasks/${task.id}/cancel`,
      { as: "operator", agentId: ownerId },
      {},
    );
    expect(status).toBe(403);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("the creator, a lead, the operator, and a user may cancel", async () => {
    const callers: Caller[] = [
      { as: "operator", agentId: creatorId },
      { as: "session", agentId: leadId },
      { as: "operator" },
      { as: "user" },
    ];
    for (const caller of callers) {
      const task = await inProgressTask();
      const status = await post(`/api/tasks/${task.id}/cancel`, caller, { reason: "stop" });
      expect(status, JSON.stringify(caller)).toBe(200);
      expect((await getTaskById(task.id))?.status).toBe("cancelled");
    }
  });
});
