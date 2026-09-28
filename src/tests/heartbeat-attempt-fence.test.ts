/**
 * Attempt fence for the heartbeat Reclaim (src/tasks/attempt-fence.ts,
 * specs/tla/heartbeat/HeartbeatSimple.tla `Fenced`).
 *
 * Reclaim puts a stalled task back to `pending` on the same row. The process
 * running the earlier attempt may still be alive, and with several runtimes
 * serving one agent the replacement can start under the same agent id. These
 * tests drive the real handlers (store-progress, defer-task, /finish,
 * supersede, active-session cleanup) and assert the stale attempt cannot
 * write the replacement's row or delete its session. They also cover the
 * supersede path, whose supersede + resume child must commit together.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getChildTasks,
  getDbClient,
  getScheduledTasks,
  getTaskById,
  initDb,
  reclaimTask,
  startTask,
  unpinTask,
} from "../be/db";
import { handleActiveSessions } from "../http/active-sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDeferTaskTool } from "../tools/defer-task";
import { registerStoreProgressTool } from "../tools/store-progress";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-heartbeat-attempt-fence.sqlite";
const RUNTIME_A = "runtime-a-0000";
const RUNTIME_B = "runtime-b-1111";

type ToolResult = { structuredContent: { success: boolean; message: string } };
type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

function tool(name: "store-progress" | "defer-task"): RegisteredTool {
  const server = new McpServer({ name: "attempt-fence-test", version: "1.0.0" });
  if (name === "store-progress") registerStoreProgressTool(server);
  else registerDeferTaskTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const found = registered[name];
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

function meta(agentId: string, runtimeInstanceId: string) {
  return {
    sessionId: `session-${crypto.randomUUID()}`,
    requestInfo: {
      headers: { "x-agent-id": agentId, "x-runtime-instance-id": runtimeInstanceId },
    },
  };
}

let server: Server;
let baseUrl: string;

async function api(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const as = (agentId: string, runtime: string) => ({
  "X-Agent-ID": agentId,
  "X-Runtime-Instance-ID": runtime,
});

async function worker(name: string) {
  return createAgent({ name, isLead: false, status: "busy", maxTasks: 2 });
}

/** Start on runtime A, then reclaim: the row is `pending`, attempt 1. */
async function startedThenReclaimed(agentId: string) {
  const task = await createTaskExtended(`Long work ${crypto.randomUUID()}`, { agentId });
  await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
  const row = await getTaskById(task.id);
  const reclaimed = await reclaimTask(task.id, {
    expectedAttempt: 0,
    expectedLastUpdatedAt: row!.lastUpdatedAt,
    observedSessionHeartbeatAt: null,
    reason: "test stall",
  });
  expect(reclaimed?.status).toBe("pending");
  expect(reclaimed?.attempt).toBe(1);
  return task;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "attempt-fence-test" });
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    try {
      if (await handleActiveSessions(req, res, pathSegments, query, callerAgentId)) return;
      if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
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

describe("blocker 1: a stale attempt cannot finish the replacement attempt", () => {
  test("store-progress(completed) from the old runtime is rejected; the new runtime completes", async () => {
    const agent = await worker("fence-sp");
    const task = await startedThenReclaimed(agent.id);
    // Replacement attempt starts on runtime B of the SAME agent.
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });

    const stale = (await tool("store-progress").handler(
      { taskId: task.id, status: "completed", output: "stale output from attempt 0" },
      meta(agent.id, RUNTIME_A),
    )) as ToolResult;
    expect(stale.structuredContent.success).toBe(false);
    expect(stale.structuredContent.message).toContain("another runtime");
    const afterStale = await getTaskById(task.id);
    expect(afterStale?.status).toBe("in_progress");
    expect(afterStale?.output ?? null).toBeNull();

    const fresh = (await tool("store-progress").handler(
      { taskId: task.id, status: "completed", output: "attempt 1 output" },
      meta(agent.id, RUNTIME_B),
    )) as ToolResult;
    expect(fresh.structuredContent.success).toBe(true);
    expect((await getTaskById(task.id))?.output).toBe("attempt 1 output");
  });

  test("store-progress progress-only from the old runtime does not touch the row", async () => {
    const agent = await worker("fence-sp-progress");
    const task = await startedThenReclaimed(agent.id);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });
    const before = await getTaskById(task.id);

    const stale = (await tool("store-progress").handler(
      { taskId: task.id, progress: "stale progress" },
      meta(agent.id, RUNTIME_A),
    )) as ToolResult;
    expect(stale.structuredContent.success).toBe(false);
    const after = await getTaskById(task.id);
    expect(after?.progress ?? null).toBe(before?.progress ?? null);
    expect(after?.lastUpdatedAt).toBe(before?.lastUpdatedAt);
  });

  test("the runner /finish of the old runtime is refused with 403", async () => {
    const agent = await worker("fence-finish");
    const task = await startedThenReclaimed(agent.id);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });

    const stale = await api("POST", `/api/tasks/${task.id}/finish`, as(agent.id, RUNTIME_A), {
      status: "failed",
      failureReason: "old process exited",
    });
    expect(stale.status).toBe(403);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");

    const fresh = await api("POST", `/api/tasks/${task.id}/finish`, as(agent.id, RUNTIME_B), {
      status: "completed",
      output: "done by attempt 1",
    });
    expect(fresh.status).toBe(200);
    expect((await getTaskById(task.id))?.status).toBe("completed");
  });

  test("the same runtime keeps its own reclaimed task (keep-branch) and may finish it", async () => {
    const agent = await worker("fence-same-runtime");
    const task = await startedThenReclaimed(agent.id);
    // Runtime A polls its own reclaimed row back; the runner keeps the old
    // process, so that process's writes must still land.
    await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
    const result = (await tool("store-progress").handler(
      { taskId: task.id, status: "completed", output: "kept process finished" },
      meta(agent.id, RUNTIME_A),
    )) as ToolResult;
    expect(result.structuredContent.success).toBe(true);
    expect((await getTaskById(task.id))?.status).toBe("completed");
  });
});

describe("blocker 2: defer-task is fenced before the schedule and the terminal write", () => {
  async function schedulesFor(taskId: string) {
    return (await getScheduledTasks({ hideCompleted: false })).filter(
      (s) => s.parentTaskId === taskId,
    );
  }

  const deferArgs = (taskId: string) => ({
    taskId,
    delayMs: 600_000,
    summary: "waiting on deploy",
    note: "check the deploy",
  });

  test("the old run cannot defer the reclaimed pending row", async () => {
    const agent = await worker("fence-defer-pending");
    const task = await startedThenReclaimed(agent.id);

    const result = (await tool("defer-task").handler(
      deferArgs(task.id),
      meta(agent.id, RUNTIME_A),
    )) as ToolResult;
    expect(result.structuredContent.success).toBe(false);
    expect((await getTaskById(task.id))?.status).toBe("pending");
    expect(await schedulesFor(task.id)).toHaveLength(0);
  });

  test("the old runtime cannot defer the replacement attempt running elsewhere", async () => {
    const agent = await worker("fence-defer-running");
    const task = await startedThenReclaimed(agent.id);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });

    const result = (await tool("defer-task").handler(
      deferArgs(task.id),
      meta(agent.id, RUNTIME_A),
    )) as ToolResult;
    expect(result.structuredContent.success).toBe(false);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(await schedulesFor(task.id)).toHaveLength(0);

    const fresh = (await tool("defer-task").handler(
      deferArgs(task.id),
      meta(agent.id, RUNTIME_B),
    )) as ToolResult;
    expect(fresh.structuredContent.success).toBe(true);
    expect(await schedulesFor(task.id)).toHaveLength(1);
  });
});

describe("blocker 3: old-run cleanup does not delete the replacement's session", () => {
  test("A's late DELETE after Reclaim, Unpin and B's claim leaves B's session", async () => {
    const agentA = await worker("fence-session-a");
    const agentB = await worker("fence-session-b");
    const task = await createTaskExtended("Session cleanup work", { agentId: agentA.id });
    await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
    await api("POST", "/api/active-sessions", as(agentA.id, RUNTIME_A), {
      agentId: agentA.id,
      taskId: task.id,
      triggerType: "task_assigned",
      runtimeInstanceId: RUNTIME_A,
    });

    const row = await getTaskById(task.id);
    await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
    await reclaimTask(task.id, {
      expectedAttempt: 0,
      expectedLastUpdatedAt: row!.lastUpdatedAt,
      observedSessionHeartbeatAt: null,
      reason: "test stall",
    });
    const pending = await getTaskById(task.id);
    await unpinTask(task.id, { expectedLastUpdatedAt: pending!.lastUpdatedAt });
    await getDbClient().run("UPDATE agent_tasks SET agentId = ?, status = 'pending' WHERE id = ?", [
      agentB.id,
      task.id,
    ]);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });
    await api("POST", "/api/active-sessions", as(agentB.id, RUNTIME_B), {
      agentId: agentB.id,
      taskId: task.id,
      triggerType: "task_assigned",
      runtimeInstanceId: RUNTIME_B,
    });

    const late = await api(
      "DELETE",
      `/api/active-sessions/by-task/${task.id}`,
      as(agentA.id, RUNTIME_A),
    );
    expect(late.status).toBe(200);
    expect(late.body.deleted).toBe(false);
    expect((await getActiveSessionForTask(task.id))?.agentId).toBe(agentB.id);

    const own = await api(
      "DELETE",
      `/api/active-sessions/by-task/${task.id}`,
      as(agentB.id, RUNTIME_B),
    );
    expect(own.body.deleted).toBe(true);
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  });

  test("same agent, other runtime: the old runtime's DELETE leaves the new runtime's session", async () => {
    const agent = await worker("fence-session-same");
    const task = await startedThenReclaimed(agent.id);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });
    await api("POST", "/api/active-sessions", as(agent.id, RUNTIME_B), {
      agentId: agent.id,
      taskId: task.id,
      triggerType: "task_assigned",
      runtimeInstanceId: RUNTIME_B,
    });

    const late = await api(
      "DELETE",
      `/api/active-sessions/by-task/${task.id}`,
      as(agent.id, RUNTIME_A),
    );
    expect(late.body.deleted).toBe(false);
    expect((await getActiveSessionForTask(task.id))?.runtimeInstanceId).toBe(RUNTIME_B);
  });
});

describe("blocker 4: graceful / context-limit supersede commits with its resume or not at all", () => {
  test("a failure creating the resume child rolls the supersede back", async () => {
    const agent = await worker("fence-supersede-crash");
    const task = await createTaskExtended("Supersede me", { agentId: agent.id });
    await startTask(task.id, { runtimeInstanceId: RUNTIME_A });

    // Simulates the API dying between supersedeTask and createResumeFollowUp.
    await getDbClient().run(
      `CREATE TRIGGER fail_resume_insert BEFORE INSERT ON agent_tasks
         WHEN NEW.taskType = 'resume'
         BEGIN SELECT RAISE(ABORT, 'simulated crash before resume insert'); END`,
    );
    try {
      const res = await api("POST", `/api/tasks/${task.id}/supersede`, as(agent.id, RUNTIME_A), {
        reason: "graceful_shutdown",
      });
      expect(res.status).toBe(500);
    } finally {
      await getDbClient().run("DROP TRIGGER IF EXISTS fail_resume_insert");
    }

    // Never a terminal `superseded` row with no continuation.
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(await getChildTasks(task.id)).toHaveLength(0);
  });

  test("the normal path supersedes and links exactly one resume child", async () => {
    const agent = await worker("fence-supersede-ok");
    const task = await createTaskExtended("Supersede me cleanly", { agentId: agent.id });
    await startTask(task.id, { runtimeInstanceId: RUNTIME_A });

    const res = await api("POST", `/api/tasks/${task.id}/supersede`, as(agent.id, RUNTIME_A), {
      reason: "context_limits",
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("resumed");
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    const children = await getChildTasks(task.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe(res.body.resumeTaskId);
  });

  test("a stale runtime cannot supersede the replacement attempt", async () => {
    const agent = await worker("fence-supersede-stale");
    const task = await startedThenReclaimed(agent.id);
    await startTask(task.id, { runtimeInstanceId: RUNTIME_B });

    const res = await api("POST", `/api/tasks/${task.id}/supersede`, as(agent.id, RUNTIME_A), {
      reason: "graceful_shutdown",
    });
    expect(res.status).toBe(403);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(await getChildTasks(task.id)).toHaveLength(0);
  });
});
