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
  createWorkflow,
  createWorkflowRun,
  getAllTasks,
  getTasksCount,
  initDb,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-tasks-workflow-run-filter.sqlite";
const API_KEY = "test-tasks-workflow-run-filter";

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

describe("workflowRunId task filter", () => {
  let server: Server;
  let port: number;
  let agentId: string;
  let runAId: string;
  let runATaskIds: string[];
  let runBTaskId: string;
  let noRunTaskId: string;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    agentId = (
      await createAgent({ name: "workflow-run-filter-agent", isLead: false, status: "idle" })
    ).id;
    const workflow = await createWorkflow({
      name: `workflow-run-filter-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const runA = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow.id });
    const runB = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow.id });
    runAId = runA.id;
    runATaskIds = [
      (
        await createTaskExtended("run A — step 1", {
          agentId,
          source: "workflow",
          workflowRunId: runA.id,
        })
      ).id,
      (
        await createTaskExtended("run A — step 2", {
          agentId,
          source: "workflow",
          workflowRunId: runA.id,
        })
      ).id,
    ];
    runBTaskId = (
      await createTaskExtended("run B — step 1", {
        agentId,
        source: "workflow",
        workflowRunId: runB.id,
      })
    ).id;
    noRunTaskId = (await createTaskExtended("task outside any run", { agentId })).id;

    server = createTestServer(API_KEY);
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  function listTasks(query: string): Promise<Response> {
    return fetch(`http://localhost:${port}/api/tasks?${query}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
  }

  test("getAllTasks and getTasksCount return only the run's tasks", async () => {
    const tasks = await getAllTasks({ workflowRunId: runAId });
    expect(tasks.map((t) => t.id).sort()).toEqual([...runATaskIds].sort());
    expect(await getTasksCount({ workflowRunId: runAId })).toBe(2);
  });

  for (const fields of ["slim", "full", "timeline"] as const) {
    test(`GET /api/tasks?workflowRunId with fields=${fields} returns only the run's tasks`, async () => {
      const res = await listTasks(`workflowRunId=${runAId}&fields=${fields}&includeTotal=true`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: { id: string }[]; total: number };
      const ids = body.tasks.map((t) => t.id);
      expect(ids.sort()).toEqual([...runATaskIds].sort());
      expect(ids).not.toContain(runBTaskId);
      expect(ids).not.toContain(noRunTaskId);
      expect(body.total).toBe(2);
    });
  }

  test("an unknown run returns an empty list and zero total", async () => {
    const res = await listTasks(`workflowRunId=${crypto.randomUUID()}&includeTotal=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; total: number };
    expect(body.tasks).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("a non-UUID workflowRunId is rejected", async () => {
    const res = await listTasks("workflowRunId=not-a-uuid");
    expect(res.status).toBe(400);
  });
});
