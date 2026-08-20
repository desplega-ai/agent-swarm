import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createUser,
  createWorkflowRun,
  createWorkflowRunStep,
  getDb,
  getWorkflowRun,
  getWorkflowVersions,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import {
  listWorkflowRunsHandler,
  listWorkflowRunsInputSchema,
} from "../tools/workflows/list-workflow-runs";
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowSummary,
  WorkflowVersion,
} from "../types";
import { initWorkflows, stopRetryPoller } from "../workflows";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-workflow-http-v2.sqlite";

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

let baseUrl = "";
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
    const port = await listenOnFreePort(server);
    baseUrl = `http://localhost:${port}`;
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
    test("validates swarm-script timeoutMs before creating", async () => {
      const invalidRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: `invalid-timeout-${crypto.randomUUID()}`,
          definition: {
            nodes: [
              {
                id: "run-report",
                type: "swarm-script",
                config: { scriptName: "report", timeoutMs: 300_001 },
              },
            ],
          },
        }),
      });
      expect(invalidRes.status).toBe(400);
      const invalidBody = (await invalidRes.json()) as { error: string };
      expect(invalidBody.error).toContain("config.timeoutMs");
      expect(invalidBody.error).toContain("300001");
      expect(invalidBody.error).toContain("300000");

      const validRes = await fetch(`${baseUrl}/api/workflows`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: `valid-timeout-${crypto.randomUUID()}`,
          definition: {
            nodes: [
              {
                id: "run-report",
                type: "swarm-script",
                config: { scriptName: "report", timeoutMs: 300_000 },
              },
            ],
          },
        }),
      });
      expect(validRes.status).toBe(201);
    });

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
    test("returns slim workflows by default (no definition, has nodeCount)", async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowSummary[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      // Slim rows drop the heavy `definition`/`triggers` and carry `nodeCount`.
      for (const wf of body) {
        expect((wf as unknown as Workflow).definition).toBeUndefined();
        expect((wf as unknown as Workflow).triggers).toBeUndefined();
        expect(typeof wf.nodeCount).toBe("number");
      }
    });

    test("?fields=full restores the full workflow shape", async () => {
      const res = await fetch(`${baseUrl}/api/workflows?fields=full`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Workflow[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      for (const wf of body) {
        expect(Array.isArray(wf.triggers)).toBe(true);
        expect(wf.definition).toBeDefined();
        expect(wf.definition.nodes).toBeDefined();
      }
    });

    test("filters workflows by enabled and latest run status", async () => {
      const failedLatest = await createTestWorkflow({
        name: `failed-latest-${crypto.randomUUID()}`,
      });
      const completedLatest = await createTestWorkflow({
        name: `completed-latest-${crypto.randomUUID()}`,
      });
      const disabled = await createTestWorkflow({ name: `disabled-filter-${crypto.randomUUID()}` });
      await fetch(`${baseUrl}/api/workflows/${disabled.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: false }),
      });

      const failedRun = createWorkflowRun({ id: crypto.randomUUID(), workflowId: failedLatest.id });
      updateWorkflowRun(failedRun.id, { status: "failed", finishedAt: new Date().toISOString() });
      const completedRun = createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: completedLatest.id,
      });
      updateWorkflowRun(completedRun.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });

      const failedRes = await fetch(`${baseUrl}/api/workflows?lastRunStatus=failed`, { headers });
      expect(failedRes.status).toBe(200);
      const failedBody = (await failedRes.json()) as WorkflowSummary[];
      expect(failedBody.some((wf) => wf.id === failedLatest.id)).toBe(true);
      expect(failedBody.some((wf) => wf.id === completedLatest.id)).toBe(false);

      const disabledRes = await fetch(`${baseUrl}/api/workflows?enabled=false`, { headers });
      expect(disabledRes.status).toBe(200);
      const disabledBody = (await disabledRes.json()) as WorkflowSummary[];
      expect(disabledBody.some((wf) => wf.id === disabled.id)).toBe(true);
      expect(disabledBody.every((wf) => !wf.enabled)).toBe(true);
    });

    test("filters workflows by latest consecutive failed run count", async () => {
      const twoFailures = await createTestWorkflow({
        name: `two-failures-${crypto.randomUUID()}`,
      });
      const recovered = await createTestWorkflow({ name: `recovered-${crypto.randomUUID()}` });

      for (const workflow of [twoFailures, recovered]) {
        const oldFailedRun = createWorkflowRun({
          id: crypto.randomUUID(),
          workflowId: workflow.id,
        });
        updateWorkflowRun(oldFailedRun.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
      }

      await Bun.sleep(2);
      const recoveredRun = createWorkflowRun({ id: crypto.randomUUID(), workflowId: recovered.id });
      updateWorkflowRun(recoveredRun.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });

      await Bun.sleep(2);
      const latestFailedRun = createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: twoFailures.id,
      });
      updateWorkflowRun(latestFailedRun.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
      });

      const res = await fetch(`${baseUrl}/api/workflows?consecutiveErrorsMin=2`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowSummary[];
      expect(body.some((wf) => wf.id === twoFailures.id)).toBe(true);
      expect(body.some((wf) => wf.id === recovered.id)).toBe(false);
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

    test("rejects oversized timeoutMs before updating or snapshotting", async () => {
      const workflow = await createTestWorkflow({
        definition: {
          nodes: [
            {
              id: "run-report",
              type: "swarm-script",
              config: { scriptName: "report", timeoutMs: 300_000 },
            },
          ],
        },
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          definition: {
            nodes: [
              {
                id: "run-report",
                type: "swarm-script",
                config: { scriptName: "report", timeoutMs: 300_001 },
              },
            ],
          },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("config.timeoutMs");
      expect(body.error).toContain("300001");
      expect(body.error).toContain("300000");
      expect(getWorkflowVersions(workflow.id)).toHaveLength(0);

      const storedRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, { headers });
      const stored = (await storedRes.json()) as Workflow;
      expect(stored.definition.nodes[0]!.config.timeoutMs).toBe(300_000);
    });

    test("rejects oversized timeoutMs in single-node patches before snapshotting", async () => {
      const workflow = await createTestWorkflow({
        definition: {
          nodes: [
            {
              id: "run-report",
              type: "swarm-script",
              config: { scriptName: "report", timeoutMs: 300_000 },
            },
          ],
        },
      });

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/nodes/run-report`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ config: { scriptName: "report", timeoutMs: 300_001 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("config.timeoutMs");
      expect(body.error).toContain("300001");
      expect(body.error).toContain("300000");
      expect(getWorkflowVersions(workflow.id)).toHaveLength(0);
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

    test("succeeds without agent ID (manual trigger)", async () => {
      const workflow = await createTestWorkflow();

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // No X-Agent-ID needed
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });

    test("does not attribute a trigger with no user auth to the workflow author", async () => {
      const author = createUser({
        name: "Workflow Author",
        email: `workflow-author-${crypto.randomUUID()}@example.com`,
      });
      const workflow = await createTestWorkflow();
      getDb().run("UPDATE workflows SET created_by = ? WHERE id = ?", [author.id, workflow.id]);

      const res = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const { runId } = (await res.json()) as { runId: string };
      expect(getWorkflowRun(runId)?.createdBy).toBeUndefined();
      expect(getWorkflowRun(runId)?.context?.swarm).toBeUndefined();
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

    test("supports deterministic limit/offset pages while preserving the omitted legacy shape", async () => {
      const workflow = await createTestWorkflow();
      const runIds = Array.from({ length: 5 }, () => crypto.randomUUID());
      const statuses = ["running", "failed", "running", "failed", "running"] as const;

      for (const [index, id] of runIds.entries()) {
        createWorkflowRun({ id, workflowId: workflow.id });
        getDb().run("UPDATE workflow_runs SET status = ?, startedAt = ? WHERE id = ?", [
          statuses[index]!,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          id,
        ]);
      }

      const legacyRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { headers });
      expect(legacyRes.status).toBe(200);
      const legacyBody = (await legacyRes.json()) as WorkflowRun[];
      expect(Array.isArray(legacyBody)).toBe(true);
      expect(legacyBody.map((run) => run.id)).toEqual([...runIds].reverse());

      const pageRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs?limit=2&offset=1`, {
        headers,
      });
      expect(pageRes.status).toBe(200);
      const pageBody = (await pageRes.json()) as {
        runs: WorkflowRun[];
        page: {
          limit: number;
          offset: number;
          total: number;
          hasMore: boolean;
          nextOffset?: number;
        };
      };
      expect(pageBody.runs.map((run) => run.id)).toEqual([runIds[3], runIds[2]]);
      expect(pageBody.page).toEqual({
        limit: 2,
        offset: 1,
        total: 5,
        hasMore: true,
        nextOffset: 3,
      });

      const filteredRes = await fetch(
        `${baseUrl}/api/workflows/${workflow.id}/runs?status=failed&limit=1`,
        { headers },
      );
      expect(filteredRes.status).toBe(200);
      const filteredBody = (await filteredRes.json()) as {
        runs: WorkflowRun[];
        page: { total: number };
      };
      expect(filteredBody.runs.map((run) => run.id)).toEqual([runIds[3]]);
      expect(filteredBody.page.total).toBe(2);

      const invalidRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs?limit=101`, {
        headers,
      });
      expect(invalidRes.status).toBe(400);
    });

    test("MCP run listing defaults to bounded slim rows and preserves an explicit full-row opt-in", async () => {
      const workflow = await createTestWorkflow();
      const largeValue = "x".repeat(100_000);
      const run = createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        triggerData: { largeValue },
      });
      updateWorkflowRun(run.id, { context: { nodeOutput: largeValue } });
      const parsed = listWorkflowRunsInputSchema.parse({ workflowId: workflow.id });
      expect(parsed.limit).toBe(20);
      expect(parsed.offset).toBe(0);
      expect(parsed.includeContext).toBe(false);
      expect(() =>
        listWorkflowRunsInputSchema.parse({ workflowId: workflow.id, limit: 101 }),
      ).toThrow();

      const result = listWorkflowRunsHandler(parsed);
      expect(result.ok).toBe(true);
      const data = result.data as {
        runs: Array<{
          id: string;
          context?: unknown;
          triggerData?: unknown;
          triggerDataSummary?: string;
        }>;
        page: { limit: number; offset: number; total: number; hasMore: boolean };
      };
      expect(data.runs.map((row) => row.id)).toEqual([run.id]);
      expect(data.runs[0]!.context).toBeUndefined();
      expect(data.runs[0]!.triggerData).toBeUndefined();
      expect(data.runs[0]!.triggerDataSummary).toEndWith("…");
      expect(data.runs[0]!.triggerDataSummary!.length).toBe(401);
      expect(data.page).toEqual({
        limit: 20,
        offset: 0,
        total: 1,
        hasMore: false,
      });
      expect(JSON.stringify(result).length).toBeLessThan(20_000);

      const fullResult = listWorkflowRunsHandler({
        ...parsed,
        includeContext: true,
      });
      const fullData = fullResult.data as { runs: WorkflowRun[] };
      expect(fullData.runs[0]!.context).toEqual({ nodeOutput: largeValue });
      expect(fullData.runs[0]!.triggerData).toEqual({ largeValue });
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

  // ─── CANCEL RUN ──────────────────────────────────────────

  describe("POST /api/workflow-runs/:id/cancel", () => {
    test("cancels a running workflow run", async () => {
      const workflow = await createTestWorkflow();

      // Create a run directly in 'running' state (notify executor completes instantly)
      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id });

      // Create a step in 'running' state
      createWorkflowRunStep({
        id: crypto.randomUUID(),
        runId,
        nodeId: "n1",
        nodeType: "notify",
      });

      // Cancel the run
      const cancelRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "Test cancellation" }),
      });
      expect(cancelRes.status).toBe(200);
      const cancelBody = (await cancelRes.json()) as { success: boolean };
      expect(cancelBody.success).toBe(true);

      // Verify the run is cancelled
      const getRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, { headers });
      expect(getRes.status).toBe(200);
      const { run } = (await getRes.json()) as { run: WorkflowRun; steps: WorkflowRunStep[] };
      expect(run.status).toBe("cancelled");
      expect(run.error).toBe("Test cancellation");
      expect(run.finishedAt).toBeDefined();
    });

    test("returns 400 for already completed run", async () => {
      const workflow = await createTestWorkflow();

      // Trigger a run (notify executor completes synchronously)
      const triggerRes = await fetch(`${baseUrl}/api/workflows/${workflow.id}/trigger`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const { runId } = (await triggerRes.json()) as { runId: string };

      // Wait for run to complete
      await new Promise((r) => setTimeout(r, 10));

      // Try to cancel — should fail
      const cancelRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(400);
    });

    test("returns 400 for non-existent run", async () => {
      const cancelRes = await fetch(`${baseUrl}/api/workflow-runs/${crypto.randomUUID()}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(400);
    });

    test("cancel uses default reason when none provided", async () => {
      const workflow = await createTestWorkflow();

      // Create a run directly in 'running' state
      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id });

      const cancelRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(200);

      const getRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, { headers });
      const { run } = (await getRes.json()) as { run: WorkflowRun };
      expect(run.status).toBe("cancelled");
      expect(run.error).toBe("Cancelled by user");
    });

    test("cancelling a run also cancels non-terminal steps", async () => {
      const workflow = await createTestWorkflow();

      // Create a run with steps in various states
      const runId = crypto.randomUUID();
      createWorkflowRun({ id: runId, workflowId: workflow.id });

      // Running step — should be cancelled
      createWorkflowRunStep({
        id: crypto.randomUUID(),
        runId,
        nodeId: "n1",
        nodeType: "notify",
      });

      // Cancel the run
      await fetch(`${baseUrl}/api/workflow-runs/${runId}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      // Get the run with steps
      const getRes = await fetch(`${baseUrl}/api/workflow-runs/${runId}`, { headers });
      const { steps } = (await getRes.json()) as { run: WorkflowRun; steps: WorkflowRunStep[] };

      // All non-terminal steps should be cancelled
      for (const step of steps) {
        expect(step.status).toBe("cancelled");
        expect(step.finishedAt).toBeDefined();
      }
    });
  });
});
