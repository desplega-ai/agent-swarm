import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getAllTasks, initDb } from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { workflowEventBus } from "../workflows/event-bus";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { evaluateWorkflowTriggers } from "../workflows/triggers";

const TEST_DB_PATH = "./test-workflow-http.sqlite";
const TEST_PORT = 13026;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    // Pass a stub agent id so auth checks treat caller as an agent
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    const handled = await handleWorkflows(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("Workflow HTTP API", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
    initDb(TEST_DB_PATH);
    setupWorkflowResumeListener(workflowEventBus);

    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test server listening on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // File may not exist
      }
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/workflows — create
  // GET /api/workflows — list
  // GET /api/workflows/:id — get single
  // ---------------------------------------------------------------------------
  describe("CRUD", () => {
    let workflowId: string;

    test("POST /api/workflows creates a workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-crud-workflow",
          definition: {
            nodes: [
              { id: "t1", type: "trigger-webhook", config: {} },
              { id: "a1", type: "create-task", config: { template: "Task from workflow" } },
            ],
            edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
          },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string; enabled: boolean };
      expect(body.name).toBe("test-crud-workflow");
      expect(body.enabled).toBe(true);
      expect(typeof body.id).toBe("string");
      workflowId = body.id;
    });

    test("GET /api/workflows lists workflows", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((w) => w.id === workflowId)).toBe(true);
    });

    test("GET /api/workflows/:id returns the workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${workflowId}`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.id).toBe(workflowId);
      expect(body.name).toBe("test-crud-workflow");
    });

    test("GET /api/workflows/:id returns 404 for unknown id", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/does-not-exist`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(404);
    });

    test("PUT /api/workflows/:id updates the workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({ name: "test-crud-workflow-updated" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("test-crud-workflow-updated");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/workflows/:id/trigger — webhook trigger creates a run
  // GET /api/workflows/:id/runs — lists runs
  // GET /api/workflow-runs/:id — run detail with steps
  // ---------------------------------------------------------------------------
  describe("Trigger and run detail", () => {
    let workflowId: string;
    let runId: string;

    test("setup: create workflow for trigger tests", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-trigger-workflow",
          definition: {
            nodes: [
              { id: "t1", type: "trigger-webhook", config: {} },
              { id: "a1", type: "create-task", config: { template: "Triggered task" } },
            ],
            edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
          },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      workflowId = body.id;
    });

    test("POST /api/workflows/:id/trigger creates a workflow run", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({ data: "test-payload" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { runId: string };
      expect(typeof body.runId).toBe("string");
      runId = body.runId;
    });

    test("GET /api/workflows/:id/runs lists the run", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/runs`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((r) => r.id === runId)).toBe(true);
    });

    test("GET /api/workflow-runs/:id returns run with steps", async () => {
      const res = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; steps: Array<{ nodeId: string }> };
      expect(body.id).toBe(runId);
      expect(Array.isArray(body.steps)).toBe(true);
      // t1 (trigger-webhook) and a1 (create-task) should both appear
      const nodeIds = body.steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("t1");
      expect(nodeIds).toContain("a1");
    });
  });

  // ---------------------------------------------------------------------------
  // Trigger subscription: trigger-new-task with matchTags fires on task.created
  // ---------------------------------------------------------------------------
  describe("Trigger subscription: trigger-new-task with matchTags", () => {
    test("workflow fires when task.created event matches tag filter", async () => {
      // Create a workflow: trigger-new-task (matchTags: ["test"]) → create-task
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-tag-trigger-workflow",
          definition: {
            nodes: [
              {
                id: "t1",
                type: "trigger-new-task",
                config: { matchTags: ["test"] },
              },
              {
                id: "a1",
                type: "create-task",
                config: { template: "Downstream task from trigger" },
              },
            ],
            edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
          },
        }),
      });
      expect(res.status).toBe(201);

      // Snapshot existing task IDs before triggering
      const idsBefore = new Set(getAllTasks().map((t) => t.id));

      // Emit a task.created event that matches the tag filter (no workflowRunId to avoid loop guard)
      evaluateWorkflowTriggers("task.created", {
        tags: ["test", "other"],
        source: "api",
      });

      // Give async execution a moment
      await new Promise((resolve) => setTimeout(resolve, 100));

      // A downstream task matching our specific template should have been created
      const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
      const workflowTask = newTasks.find(
        (t) => t.source === "workflow" && t.task === "Downstream task from trigger",
      );
      expect(workflowTask).toBeDefined();
      expect(workflowTask?.task).toBe("Downstream task from trigger");
    });

    test("workflow does NOT fire when tags do not match", async () => {
      const idsBefore = new Set(getAllTasks().map((t) => t.id));

      // Emit with wrong tags — "other" does not include "test"
      evaluateWorkflowTriggers("task.created", {
        tags: ["other"],
        source: "api",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // No new task matching our specific downstream template should be created
      const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
      const unexpectedTask = newTasks.find(
        (t) => t.task === "Downstream task from trigger" && t.source === "workflow",
      );
      expect(unexpectedTask).toBeUndefined();
    });

    test("workflow does NOT fire when event is from a workflow (loop guard)", async () => {
      const idsBefore = new Set(getAllTasks().map((t) => t.id));

      // Emit task.created with workflowRunId set — should be blocked by loop guard
      evaluateWorkflowTriggers("task.created", {
        tags: ["test"],
        workflowRunId: "some-run-id",
        source: "workflow",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
      expect(newTasks.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/workflows/:id
  // ---------------------------------------------------------------------------
  describe("Delete", () => {
    test("DELETE /api/workflows/:id removes the workflow", async () => {
      // Create a workflow to delete
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-delete-workflow",
          definition: {
            nodes: [{ id: "t1", type: "trigger-webhook", config: {} }],
            edges: [],
          },
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const deleteRes = await fetch(`${baseUrl}/api/workflows/${id}`, {
        method: "DELETE",
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(deleteRes.status).toBe(204);

      const getRes = await fetch(`${baseUrl}/api/workflows/${id}`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(getRes.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/workflow-runs/:id/retry — retry a failed run
  // ---------------------------------------------------------------------------
  describe("Retry failed run", () => {
    test("POST /api/workflow-runs/:id/retry retries a failed run", async () => {
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-retry-workflow",
          definition: {
            nodes: [
              { id: "t1", type: "trigger-webhook", config: {} },
              { id: "a1", type: "create-task", config: { template: "Retry test task" } },
            ],
            edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
          },
        }),
      });
      const { id: workflowId } = (await createRes.json()) as { id: string };

      const triggerRes = await fetch(`${baseUrl}/api/workflows/${workflowId}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({}),
      });
      const { runId } = (await triggerRes.json()) as { runId: string };

      // Get run detail to find step ID, then manually fail via DB
      const runDetailRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      const runDetail = (await runDetailRes.json()) as {
        steps: Array<{ id: string; nodeId: string }>;
      };
      const taskStep = runDetail.steps.find((s) => s.nodeId === "a1")!;

      const { getDb } = await import("../be/db");
      getDb().run("UPDATE workflow_run_steps SET status = 'failed', error = 'test' WHERE id = ?", [
        taskStep.id,
      ]);
      getDb().run("UPDATE workflow_runs SET status = 'failed', error = 'test' WHERE id = ?", [
        runId,
      ]);

      const retryRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
      });
      expect(retryRes.status).toBe(200);
      const retryBody = (await retryRes.json()) as { success: boolean };
      expect(retryBody.success).toBe(true);
    });

    test("POST /api/workflow-runs/:id/retry returns 400 for non-failed run", async () => {
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-retry-not-failed",
          definition: {
            nodes: [
              { id: "t1", type: "trigger-webhook", config: {} },
              { id: "a1", type: "create-task", config: { template: "Retry test" } },
            ],
            edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
          },
        }),
      });
      const { id: wfId } = (await createRes.json()) as { id: string };

      const triggerRes = await fetch(`${baseUrl}/api/workflows/${wfId}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({}),
      });
      const { runId } = (await triggerRes.json()) as { runId: string };

      const retryRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
      });
      expect(retryRes.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Trigger edge cases: disabled workflow, webhook secret auth
  // ---------------------------------------------------------------------------
  describe("Trigger edge cases", () => {
    test("POST trigger returns 400 when workflow is disabled", async () => {
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-disabled-workflow",
          definition: {
            nodes: [{ id: "t1", type: "trigger-webhook", config: {} }],
            edges: [],
          },
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      // Disable the workflow
      await fetch(`${baseUrl}/api/workflows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({ enabled: false }),
      });

      const triggerRes = await fetch(`${baseUrl}/api/workflows/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({}),
      });
      expect(triggerRes.status).toBe(400);
      const body = (await triggerRes.json()) as { error: string };
      expect(body.error).toBe("Workflow is disabled");
    });

    test("POST trigger returns 401 without agentId and wrong secret", async () => {
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-secret-auth",
          definition: {
            nodes: [{ id: "t1", type: "trigger-webhook", config: {} }],
            edges: [],
          },
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const triggerRes = await fetch(`${baseUrl}/api/workflows/${id}/trigger?secret=wrong`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(triggerRes.status).toBe(401);
    });

    test("POST trigger returns 404 for unknown workflow", async () => {
      const triggerRes = await fetch(`${baseUrl}/api/workflows/does-not-exist/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({}),
      });
      expect(triggerRes.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT edge cases
  // ---------------------------------------------------------------------------
  describe("PUT edge cases", () => {
    test("PUT /api/workflows/:id returns 404 for unknown id", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/does-not-exist`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({ name: "nope" }),
      });
      expect(res.status).toBe(404);
    });

    test("PUT /api/workflows/:id with invalid definition returns 400", async () => {
      const createRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "test-put-invalid-def",
          definition: {
            nodes: [{ id: "t1", type: "trigger-webhook", config: {} }],
            edges: [],
          },
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/workflows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({ definition: { invalid: true } }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET edge cases
  // ---------------------------------------------------------------------------
  describe("GET edge cases", () => {
    test("GET /api/workflow-runs/:id returns 404 for unknown run", async () => {
      const res = await fetch(`${baseUrl}/api/workflow-runs/does-not-exist`, {
        headers: { "X-Agent-ID": "agent-1" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/workflows — validation: invalid definition rejected
  // ---------------------------------------------------------------------------
  describe("Validation", () => {
    test("POST /api/workflows returns 400 for invalid definition", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-1" },
        body: JSON.stringify({
          name: "bad-workflow",
          definition: { notValidAtAll: true },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid definition");
    });
  });
});
