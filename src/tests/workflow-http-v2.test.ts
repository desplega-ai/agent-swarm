import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getWorkflowVersions, initDb } from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowVersion,
} from "../types";
import { initWorkflows, stopRetryPoller } from "../workflows";

const TEST_DB_PATH = "./test-workflow-http-v2.sqlite";
const TEST_PORT = 13030;

// ─── Test Server ─────────────────────────────────────────────

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    const handled = await handleWorkflows(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

// ─── Helpers ────────────────────────────────────────────────

const baseUrl = `http://localhost:${TEST_PORT}`;
const headers = {
  "Content-Type": "application/json",
  "X-Agent-ID": crypto.randomUUID(),
};

function simpleDefinition(): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "n1",
        type: "notify",
        config: { channel: "swarm", template: "test" },
      },
    ],
  };
}

function branchDefinition(): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "start",
        type: "property-match",
        config: { conditions: [{ field: "trigger.ok", op: "eq", value: true }] },
        next: { true: "yes", false: "no" },
      },
      { id: "yes", type: "notify", config: { channel: "swarm", template: "yes" } },
      { id: "no", type: "notify", config: { channel: "swarm", template: "no" } },
    ],
  };
}

async function createTestWorkflow(overrides?: Record<string, unknown>): Promise<Workflow> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `test-wf-${crypto.randomUUID().slice(0, 8)}`,
      definition: simpleDefinition(),
      ...overrides,
    }),
  });
  return (await res.json()) as Workflow;
}

// ─── Setup / Teardown ────────────────────────────────────────

describe("Workflow HTTP API v2", () => {
  let server: Server;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // ignore
    }
    initDb(TEST_DB_PATH);
    initWorkflows();

    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    stopRetryPoller();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  });

  // ─── CREATE ────────────────────────────────────────────────

  describe("POST /api/workflows (create)", () => {
    test("creates workflow with new schema (triggers, cooldown, input)", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "full-schema-workflow",
          description: "test",
          definition: simpleDefinition(),
          triggers: [{ type: "webhook", hmacSecret: "secret-123" }],
          cooldown: { minutes: 30 },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — this is the input resolution syntax
          input: { apiKey: "${API_KEY}", secret: "secret.MY_SECRET", literal: "hello" },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Workflow;
      expect(body.name).toBe("full-schema-workflow");
      expect(body.enabled).toBe(true);
      expect(body.triggers).toHaveLength(1);
      expect(body.triggers[0]!.type).toBe("webhook");
      expect(body.cooldown).toEqual({ minutes: 30 });
      expect(body.input).toBeDefined();
      expect(body.input!.literal).toBe("hello");
    });

    test("creates workflow with minimal schema (definition only)", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "minimal-workflow",
          definition: simpleDefinition(),
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Workflow;
      expect(body.triggers).toEqual([]);
      expect(body.cooldown).toBeUndefined();
      expect(body.input).toBeUndefined();
    });

    test("rejects invalid definition (dangling next reference)", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "bad-definition",
          definition: {
            nodes: [
              {
                id: "n1",
                type: "notify",
                config: {},
                next: "nonexistent",
              },
            ],
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("nonexistent");
    });

    test("rejects invalid definition (multiple entry nodes)", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "multi-entry",
          definition: {
            nodes: [
              { id: "a", type: "notify", config: {} },
              { id: "b", type: "notify", config: {} },
            ],
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Multiple entry nodes");
    });
  });

  // ─── GET (single) ──────────────────────────────────────────

  describe("GET /api/workflows/:id", () => {
    test("returns workflow with triggers, cooldown, and auto-generated edges", async () => {
      const workflow = await createTestWorkflow({
        definition: branchDefinition(),
        triggers: [{ type: "webhook" }],
        cooldown: { hours: 1 },
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Workflow & { edges: WorkflowEdge[] };
      expect(body.id).toBe(workflow.id);
      expect(body.triggers).toHaveLength(1);
      expect(body.cooldown).toEqual({ hours: 1 });
      // Auto-generated edges from branch definition
      expect(body.edges).toBeDefined();
      expect(body.edges.length).toBeGreaterThanOrEqual(2);
      // Verify edge structure
      const edgeToYes = body.edges.find((e) => e.target === "yes");
      expect(edgeToYes).toBeDefined();
      expect(edgeToYes!.source).toBe("start");
      expect(edgeToYes!.sourcePort).toBe("true");
    });

    test("returns 404 for missing workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${crypto.randomUUID()}`, { headers });
      expect(res.status).toBe(404);
    });
  });

  // ─── LIST ────────────────────────────────────────────────

  describe("GET /api/workflows (list)", () => {
    test("returns all workflows with new fields", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Workflow[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      // Each workflow should have the new fields
      for (const wf of body) {
        expect(Array.isArray(wf.triggers)).toBe(true);
        expect(wf.definition).toBeDefined();
        expect(wf.definition.nodes).toBeDefined();
      }
    });
  });

  // ─── UPDATE ──────────────────────────────────────────────

  describe("PUT /api/workflows/:id (update)", () => {
    test("creates version snapshot on update", async () => {
      const workflow = await createTestWorkflow();

      // First update
      const res1 = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "updated once" }),
      });
      expect(res1.status).toBe(200);

      // Second update
      const res2 = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "updated twice" }),
      });
      expect(res2.status).toBe(200);

      // Verify versions were created
      const versions = getWorkflowVersions(workflow.id);
      expect(versions.length).toBe(2);
      // Version 1 should have original description (undefined)
      expect(versions.find((v) => v.version === 1)?.snapshot.description).toBeUndefined();
      // Version 2 should have "updated once"
      expect(versions.find((v) => v.version === 2)?.snapshot.description).toBe("updated once");
    });

    test("accepts new fields (triggers, cooldown, input)", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          triggers: [{ type: "webhook", hmacSecret: "new-secret" }],
          cooldown: { seconds: 30 },
          input: { key: "value" },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Workflow;
      expect(body.triggers).toHaveLength(1);
      expect(body.triggers[0]!.type).toBe("webhook");
      expect(body.cooldown).toEqual({ seconds: 30 });
      expect(body.input).toEqual({ key: "value" });
    });

    test("rejects invalid definition on update", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          definition: {
            nodes: [{ id: "a", type: "x", config: {}, next: "nowhere" }],
          },
        }),
      });
      expect(res.status).toBe(400);
    });

    test("returns 404 for missing workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${crypto.randomUUID()}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "nope" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE ──────────────────────────────────────────────

  describe("DELETE /api/workflows/:id", () => {
    test("deletes workflow and returns 204", async () => {
      const workflow = await createTestWorkflow();
      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "DELETE",
        headers,
      });
      expect(res.status).toBe(204);

      // Verify it's gone
      const getRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers });
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for missing workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${crypto.randomUUID()}`, {
        method: "DELETE",
        headers,
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── TRIGGER ─────────────────────────────────────────────

  describe("POST /api/workflows/:id/trigger", () => {
    test("triggers workflow and returns runId", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { runId: string; skipped: boolean };
      expect(body.runId).toBeDefined();
      expect(body.skipped).toBe(false);
    });

    test("returns 401 without agent ID", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // No X-Agent-ID
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    test("returns 400 for disabled workflow", async () => {
      const workflow = await createTestWorkflow();
      // Disable it
      await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test("returns 404 for missing workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${crypto.randomUUID()}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── LIST RUNS ────────────────────────────────────────────

  describe("GET /api/workflows/:id/runs", () => {
    test("lists runs and supports status filter", async () => {
      const workflow = await createTestWorkflow();

      // Trigger a run
      await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      // List all runs
      const res1 = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { headers });
      expect(res1.status).toBe(200);
      const allRuns = (await res1.json()) as WorkflowRun[];
      expect(allRuns.length).toBeGreaterThanOrEqual(1);

      // Filter by status — use a status that likely doesn't match
      const res2 = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs?status=waiting`, {
        headers,
      });
      expect(res2.status).toBe(200);
      const filteredRuns = (await res2.json()) as WorkflowRun[];
      // All returned runs should have the requested status
      for (const run of filteredRuns) {
        expect(run.status).toBe("waiting");
      }
    });
  });

  // ─── GET RUN DETAIL ────────────────────────────────────────

  describe("GET /api/workflow-runs/:id", () => {
    test("returns run with steps including retry columns", async () => {
      const workflow = await createTestWorkflow();

      // Trigger
      const triggerRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const { runId } = (await triggerRes.json()) as { runId: string };

      const res = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { run: WorkflowRun; steps: WorkflowRunStep[] };
      expect(body.run).toBeDefined();
      expect(body.run.id).toBe(runId);
      expect(body.steps).toBeDefined();
      expect(Array.isArray(body.steps)).toBe(true);

      // Steps should have retry columns
      for (const step of body.steps) {
        expect(typeof step.retryCount).toBe("number");
        expect(typeof step.maxRetries).toBe("number");
        // nextRetryAt may be undefined for non-retried steps
      }
    });

    test("returns 404 for missing run", async () => {
      const res = await fetch(`${baseUrl}/api/workflow-runs/${crypto.randomUUID()}`, {
        headers,
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── WEBHOOK ──────────────────────────────────────────────

  describe("POST /api/webhooks/:workflowId", () => {
    test("valid HMAC returns 201", async () => {
      const workflow = await createTestWorkflow({
        triggers: [{ type: "webhook", hmacSecret: "test-secret" }],
      });

      const body = '{"event":"test"}';
      const hmac = crypto.createHmac("sha256", "test-secret");
      hmac.update(body);
      const sig = `sha256=${hmac.digest("hex")}`;

      const res = await fetch(`${baseUrl}/api/webhooks/${workflow.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sig,
        },
        body,
      });
      expect(res.status).toBe(201);
      const result = (await res.json()) as { runId: string };
      expect(result.runId).toBeDefined();
    });

    test("invalid HMAC returns 401", async () => {
      const workflow = await createTestWorkflow({
        triggers: [{ type: "webhook", hmacSecret: "test-secret" }],
      });

      const res = await fetch(`${baseUrl}/api/webhooks/${workflow.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=invalid",
        },
        body: '{"event":"test"}',
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── VERSION HISTORY ──────────────────────────────────────

  describe("Version History Endpoints", () => {
    test("GET /api/workflows/:id/versions lists versions", async () => {
      const workflow = await createTestWorkflow();

      // Make two updates to create two versions
      await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "v1 update" }),
      });
      await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "v2 update" }),
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/versions`, {
        headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { versions: WorkflowVersion[] };
      expect(body.versions).toHaveLength(2);
      // Newest first
      expect(body.versions[0]!.version).toBe(2);
      expect(body.versions[1]!.version).toBe(1);
    });

    test("GET /api/workflows/:id/versions/:version returns specific version", async () => {
      const workflow = await createTestWorkflow();

      await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ description: "first update" }),
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/versions/1`, {
        headers,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowVersion;
      expect(body.version).toBe(1);
      expect(body.snapshot).toBeDefined();
      expect(body.snapshot.definition).toBeDefined();
    });

    test("GET /api/workflows/:id/versions/:version returns 404 for nonexistent version", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/versions/999`, {
        headers,
      });
      expect(res.status).toBe(404);
    });

    test("GET /api/workflows/:id/versions returns 404 for nonexistent workflow", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/${crypto.randomUUID()}/versions`, {
        headers,
      });
      expect(res.status).toBe(404);
    });
  });
});
