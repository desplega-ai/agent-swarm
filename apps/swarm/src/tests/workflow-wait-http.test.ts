import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  deleteWorkflow,
  getWaitStateByStepId,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflowEvents } from "../http/workflow-events";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { _resetWaitBusSubscriptionsForTests, initWaitBusSubscriptions } from "../workflows/resume";

const TEST_DB_PATH = "./test-workflow-wait-http.sqlite";
const TEST_PORT = 13041;

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (t: string) => t,
};

const createdWorkflowIds: string[] = [];

function makeWorkflow(name: string, def: WorkflowDefinition): Workflow {
  const wf = createWorkflow({ name: `${name}-${Date.now()}-${Math.random()}`, definition: def });
  createdWorkflowIds.push(wf.id);
  return wf;
}

let server: Server;

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  server = createHttpServer(async (req, res) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleWorkflowEvents(req, res, pathSegments, queryParams);
    if (!handled) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise<void>((r) => server.listen(TEST_PORT, () => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const id of createdWorkflowIds) {
    try {
      deleteWorkflow(id);
    } catch {}
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

afterEach(() => {
  _resetWaitBusSubscriptionsForTests();
});

const baseUrl = `http://localhost:${TEST_PORT}`;

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Workflow events HTTP signal endpoints", () => {
  test("POST /api/workflow-runs/:runId/events resolves a run-scoped event-mode wait", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "demo.http.signal", filter: { ok: true } },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "got it" } },
      ],
    };
    const wf = makeWorkflow("wait-http-run-scope", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("pending");

    // POST run-scoped signal — handler must inject _runId.
    const res = await fetch(`${baseUrl}/api/workflow-runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo.http.signal", payload: { ok: true } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runId: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe(runId);

    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
    expect(getWaitStateByStepId(w1!.id)?.status).toBe("fired");
  });

  test("POST /api/workflow-runs/:runId/events returns 404 for unknown runId", async () => {
    const res = await fetch(
      `${baseUrl}/api/workflow-runs/00000000-0000-0000-0000-000000000000/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "any.event", payload: {} }),
      },
    );
    expect(res.status).toBe(404);
  });

  test("POST /api/workflow-events broadcasts globally and resolves a global-scope wait", async () => {
    const registry = createExecutorRegistry(deps);

    const def: WorkflowDefinition = {
      nodes: [
        {
          id: "w1",
          type: "wait",
          config: { mode: "event", eventName: "broadcast.http.signal", scope: "global" },
          next: { event: "done" },
        },
        { id: "done", type: "notify", config: { channel: "swarm", template: "ok" } },
      ],
    };
    const wf = makeWorkflow("wait-http-global", def);
    const runId = await startWorkflowExecution(wf, {}, registry);

    initWaitBusSubscriptions(registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const w1 = steps.find((s) => s.nodeId === "w1");

    const res = await fetch(`${baseUrl}/api/workflow-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "broadcast.http.signal", payload: { source: "ext" } }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => getWaitStateByStepId(w1!.id)?.status === "fired");
  });

  test("POST /api/workflow-events validates body (missing name → 400)", async () => {
    const res = await fetch(`${baseUrl}/api/workflow-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { x: 1 } }),
    });
    expect(res.status).toBe(400);
  });
});
