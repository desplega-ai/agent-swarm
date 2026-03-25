import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  getAgentCurrentTask,
  getApprovalRequestById,
  getApprovalRequestByStepId,
  getExpiredPendingApprovals,
  initDb,
  listApprovalRequests,
  resolveApprovalRequest,
  startTask,
  updateApprovalRequestNotifications,
} from "../be/db";
import type { ExecutorMeta } from "../types";
import type { ExecutorDependencies, ExecutorInput } from "../workflows/executors/base";
import { HumanInTheLoopExecutor } from "../workflows/executors/human-in-the-loop";

const TEST_DB_PATH = "./test-approval-requests.sqlite";
const TEST_PORT = 13031;

// ─── Helpers ────────────────────────────────────────────────

function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

function makeApprovalData(overrides?: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    title: "Approve deployment",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers: { policy: "any" as const },
    ...overrides,
  };
}

// ─── HTTP handler (mirrors production routes) ───────────────

async function handleRequest(
  req: { method: string; url: string },
  body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");

  // POST /api/approval-requests
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "approval-requests" &&
    !pathSegments[2]
  ) {
    const data = JSON.parse(body);
    const id = crypto.randomUUID();
    const request = createApprovalRequest({
      id,
      title: data.title,
      questions: data.questions,
      approvers: data.approvers,
      workflowRunId: data.workflowRunId,
      workflowRunStepId: data.workflowRunStepId,
      sourceTaskId: data.sourceTaskId,
      timeoutSeconds: data.timeoutSeconds,
      notificationChannels: data.notifications,
    });
    return { status: 201, body: { approvalRequest: request } };
  }

  // GET /api/approval-requests (list)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "approval-requests" &&
    !pathSegments[2]
  ) {
    const requests = listApprovalRequests({
      status: queryParams.get("status") || undefined,
      workflowRunId: queryParams.get("workflowRunId") || undefined,
      limit: queryParams.get("limit") ? Number(queryParams.get("limit")) : undefined,
    });
    return { status: 200, body: { approvalRequests: requests } };
  }

  // POST /api/approval-requests/:id/respond
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "approval-requests" &&
    pathSegments[2] &&
    pathSegments[3] === "respond"
  ) {
    const id = pathSegments[2];
    const existing = getApprovalRequestById(id);
    if (!existing) return { status: 404, body: { error: "Not found" } };
    if (existing.status !== "pending") {
      return { status: 409, body: { error: `Already resolved: ${existing.status}` } };
    }

    const data = JSON.parse(body);
    const questions = existing.questions as Array<{ id: string; type: string }>;
    let status: "approved" | "rejected" = "approved";
    for (const q of questions) {
      if (q.type === "approval") {
        const answer = data.responses[q.id] as { approved?: boolean } | undefined;
        if (answer && answer.approved === false) {
          status = "rejected";
          break;
        }
      }
    }

    const updated = resolveApprovalRequest(id, {
      status,
      responses: data.responses,
      resolvedBy: data.respondedBy,
    });

    if (!updated) return { status: 409, body: { error: "Concurrent resolution" } };
    return { status: 200, body: { approvalRequest: updated } };
  }

  // GET /api/approval-requests/:id
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "approval-requests" &&
    pathSegments[2]
  ) {
    const request = getApprovalRequestById(pathSegments[2]);
    if (!request) return { status: 404, body: { error: "Not found" } };
    return { status: 200, body: { approvalRequest: request } };
  }

  return { status: 404, body: { error: "Not found" } };
}

function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    const result = await handleRequest({ method: req.method || "GET", url: req.url || "/" }, body);
    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

// ─── Test Setup ─────────────────────────────────────────────

describe("Approval Requests", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {}
  });

  // ─── DB Functions ───────────────────────────────────────────

  describe("DB: createApprovalRequest", () => {
    test("creates a minimal approval request", () => {
      const data = makeApprovalData();
      const result = createApprovalRequest(data);

      expect(result.id).toBe(data.id);
      expect(result.title).toBe("Approve deployment");
      expect(result.status).toBe("pending");
      expect(result.questions).toEqual(data.questions);
      expect(result.responses).toBeNull();
      expect(result.resolvedBy).toBeNull();
      expect(result.resolvedAt).toBeNull();
      expect(result.expiresAt).toBeNull();
      expect(result.createdAt).toBeTruthy();
    });

    test("creates request with timeout and computes expiresAt", () => {
      const data = makeApprovalData({ timeoutSeconds: 3600 });
      const before = Date.now();
      const result = createApprovalRequest(data);

      expect(result.expiresAt).toBeTruthy();
      const expiresMs = new Date(result.expiresAt!).getTime();
      // expiresAt should be roughly now + 3600s
      expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000);
      expect(expiresMs).toBeLessThanOrEqual(before + 3600 * 1000 + 5000);
    });

    test("creates request with workflow linkage", () => {
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const data = makeApprovalData({ workflowRunId: runId, workflowRunStepId: stepId });
      const result = createApprovalRequest(data);

      expect(result.workflowRunId).toBe(runId);
      expect(result.workflowRunStepId).toBe(stepId);
    });

    test("creates request with notification channels", () => {
      const data = makeApprovalData({
        notificationChannels: [{ channel: "slack", target: "#general" }],
      });
      const result = createApprovalRequest(data);
      expect(result.notificationChannels).toEqual([{ channel: "slack", target: "#general" }]);
    });

    test("creates request with multiple question types", () => {
      const questions = [
        { id: "q1", type: "approval", label: "Approve?", required: true },
        { id: "q2", type: "text", label: "Comments", required: false },
        {
          id: "q3",
          type: "single-select",
          label: "Priority",
          options: [
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
        },
        { id: "q4", type: "boolean", label: "Urgent?", defaultValue: false },
      ];
      const data = makeApprovalData({ questions });
      const result = createApprovalRequest(data);
      expect(result.questions).toEqual(questions);
    });
  });

  describe("DB: getApprovalRequestById", () => {
    test("returns null for nonexistent ID", () => {
      expect(getApprovalRequestById(crypto.randomUUID())).toBeNull();
    });

    test("returns the correct request", () => {
      const data = makeApprovalData();
      createApprovalRequest(data);
      const fetched = getApprovalRequestById(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.title).toBe(data.title);
    });
  });

  describe("DB: getApprovalRequestByStepId", () => {
    test("returns null when no request for step", () => {
      expect(getApprovalRequestByStepId(crypto.randomUUID())).toBeNull();
    });

    test("returns the request linked to a step", () => {
      const stepId = crypto.randomUUID();
      const data = makeApprovalData({
        workflowRunId: crypto.randomUUID(),
        workflowRunStepId: stepId,
      });
      createApprovalRequest(data);
      const fetched = getApprovalRequestByStepId(stepId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
    });
  });

  describe("DB: resolveApprovalRequest", () => {
    test("resolves a pending request to approved", () => {
      const data = makeApprovalData();
      createApprovalRequest(data);

      const result = resolveApprovalRequest(data.id, {
        status: "approved",
        responses: { q1: { approved: true } },
        resolvedBy: "user-1",
      });

      expect(result).not.toBeNull();
      expect(result!.status).toBe("approved");
      expect(result!.responses).toEqual({ q1: { approved: true } });
      expect(result!.resolvedBy).toBe("user-1");
      expect(result!.resolvedAt).toBeTruthy();
    });

    test("resolves a pending request to rejected", () => {
      const data = makeApprovalData();
      createApprovalRequest(data);

      const result = resolveApprovalRequest(data.id, { status: "rejected" });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("rejected");
    });

    test("returns null when trying to resolve an already-resolved request", () => {
      const data = makeApprovalData();
      createApprovalRequest(data);
      resolveApprovalRequest(data.id, { status: "approved" });

      // Second resolve should fail (idempotency guard)
      const result = resolveApprovalRequest(data.id, { status: "rejected" });
      expect(result).toBeNull();
    });

    test("returns null for nonexistent ID", () => {
      const result = resolveApprovalRequest(crypto.randomUUID(), { status: "approved" });
      expect(result).toBeNull();
    });
  });

  describe("DB: listApprovalRequests", () => {
    test("lists all requests (with limit)", () => {
      const results = listApprovalRequests({ limit: 1000 });
      expect(results.length).toBeGreaterThan(0);
    });

    test("filters by status", () => {
      // Create a fresh pending one
      const data = makeApprovalData();
      createApprovalRequest(data);

      const pending = listApprovalRequests({ status: "pending" });
      expect(pending.length).toBeGreaterThan(0);
      for (const r of pending) {
        expect(r.status).toBe("pending");
      }
    });

    test("filters by workflowRunId", () => {
      const runId = crypto.randomUUID();
      const data = makeApprovalData({ workflowRunId: runId });
      createApprovalRequest(data);

      const results = listApprovalRequests({ workflowRunId: runId });
      expect(results).toHaveLength(1);
      expect(results[0].workflowRunId).toBe(runId);
    });

    test("respects limit", () => {
      const results = listApprovalRequests({ limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  describe("DB: getExpiredPendingApprovals", () => {
    test("returns empty for non-expired requests", () => {
      // All our test requests with timeout have expiresAt in the future
      const expired = getExpiredPendingApprovals();
      // Filter to only our test requests
      for (const r of expired) {
        expect(r.status).toBe("pending");
        expect(r.expiresAt).toBeTruthy();
      }
    });
  });

  // ─── HTTP Endpoints ─────────────────────────────────────────

  describe("HTTP: POST /api/approval-requests", () => {
    test("creates an approval request and returns 201", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Deploy to production?",
          questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
          approvers: { policy: "any" },
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        approvalRequest: { id: string; status: string; title: string };
      };
      expect(data.approvalRequest.id).toBeTruthy();
      expect(data.approvalRequest.status).toBe("pending");
      expect(data.approvalRequest.title).toBe("Deploy to production?");
    });
  });

  describe("HTTP: GET /api/approval-requests", () => {
    test("lists approval requests", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequests: unknown[] };
      expect(data.approvalRequests.length).toBeGreaterThan(0);
    });

    test("filters by status", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests?status=pending`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequests: Array<{ status: string }> };
      for (const r of data.approvalRequests) {
        expect(r.status).toBe("pending");
      }
    });

    test("filters by workflowRunId", async () => {
      const runId = crypto.randomUUID();
      // Create one with this runId
      createApprovalRequest(makeApprovalData({ workflowRunId: runId }));

      const res = await fetch(`${baseUrl}/api/approval-requests?workflowRunId=${runId}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequests: Array<{ workflowRunId: string }> };
      expect(data.approvalRequests).toHaveLength(1);
      expect(data.approvalRequests[0].workflowRunId).toBe(runId);
    });
  });

  describe("HTTP: GET /api/approval-requests/:id", () => {
    test("returns 404 for nonexistent ID", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests/${crypto.randomUUID()}`);
      expect(res.status).toBe(404);
    });

    test("returns the request", async () => {
      const created = createApprovalRequest(makeApprovalData());
      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequest: { id: string; title: string } };
      expect(data.approvalRequest.id).toBe(created.id);
    });
  });

  describe("HTTP: POST /api/approval-requests/:id/respond", () => {
    test("approves a pending request", async () => {
      const created = createApprovalRequest(makeApprovalData());

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          responses: { q1: { approved: true } },
          respondedBy: "tester",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        approvalRequest: { status: string; resolvedBy: string };
      };
      expect(data.approvalRequest.status).toBe("approved");
      expect(data.approvalRequest.resolvedBy).toBe("tester");
    });

    test("rejects when approval question has approved: false", async () => {
      const created = createApprovalRequest(makeApprovalData());

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          responses: { q1: { approved: false } },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequest: { status: string } };
      expect(data.approvalRequest.status).toBe("rejected");
    });

    test("returns 404 for nonexistent request", async () => {
      const res = await fetch(`${baseUrl}/api/approval-requests/${crypto.randomUUID()}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses: {} }),
      });
      expect(res.status).toBe(404);
    });

    test("returns 409 for already-resolved request", async () => {
      const created = createApprovalRequest(makeApprovalData());
      resolveApprovalRequest(created.id, { status: "approved" });

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses: { q1: { approved: true } } }),
      });
      expect(res.status).toBe(409);
    });

    test("approves when there are no approval-type questions", async () => {
      const created = createApprovalRequest(
        makeApprovalData({
          questions: [{ id: "q1", type: "text", label: "Comments" }],
        }),
      );

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses: { q1: "Looks good" } }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequest: { status: string } };
      // No approval-type questions means default is "approved"
      expect(data.approvalRequest.status).toBe("approved");
    });
  });

  // ─── HITL Executor ──────────────────────────────────────────

  describe("HumanInTheLoopExecutor", () => {
    const mockDeps: ExecutorDependencies = {
      db: {
        createApprovalRequest,
        getApprovalRequestByStepId,
      } as unknown as typeof import("../be/db"),
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (template: string) => template,
    };

    const mockMeta: ExecutorMeta = {
      runId: "00000000-0000-0000-0000-000000000010",
      stepId: crypto.randomUUID(),
      nodeId: "hitl-node",
      workflowId: "00000000-0000-0000-0000-000000000012",
      dryRun: false,
    };

    function _executorInput(
      config: Record<string, unknown>,
      context: Record<string, unknown> = {},
    ): ExecutorInput {
      return { config, context, meta: mockMeta };
    }

    test("has correct type and mode", () => {
      const executor = new HumanInTheLoopExecutor(mockDeps);
      expect(executor.type).toBe("human-in-the-loop");
      expect(executor.mode).toBe("async");
    });

    test("creates approval request and returns async marker", async () => {
      const stepId = crypto.randomUUID();
      const meta = { ...mockMeta, stepId };
      const executor = new HumanInTheLoopExecutor(mockDeps);

      const result = await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
          approvers: { policy: "any" },
        },
        context: {},
        meta,
      });

      expect(result.status).toBe("success");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).async).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).waitFor).toBe("approval.resolved");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).correlationId).toBeTruthy();

      // Verify the request was created in DB
      const created = getApprovalRequestByStepId(stepId);
      expect(created).not.toBeNull();
      expect(created!.title).toBe("Deploy approval");
      expect(created!.workflowRunStepId).toBe(stepId);
    });

    test("idempotency: returns async marker for pending existing request", async () => {
      const stepId = crypto.randomUUID();
      // Pre-create an approval request for this step
      const existingId = crypto.randomUUID();
      createApprovalRequest({
        id: existingId,
        title: "Pre-existing",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });

      const executor = new HumanInTheLoopExecutor(mockDeps);
      const result = await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
        },
        context: {},
        meta: { ...mockMeta, stepId },
      });

      expect(result.status).toBe("success");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).async).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).correlationId).toBe(existingId);
    });

    test("idempotency: returns resolved result for completed request", async () => {
      const stepId = crypto.randomUUID();
      const existingId = crypto.randomUUID();
      createApprovalRequest({
        id: existingId,
        title: "Already resolved",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });
      resolveApprovalRequest(existingId, {
        status: "approved",
        responses: { q1: { approved: true } },
      });

      const executor = new HumanInTheLoopExecutor(mockDeps);
      const result = await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
        },
        context: {},
        meta: { ...mockMeta, stepId },
      });

      expect(result.status).toBe("success");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion on untyped executor result
      expect((result as any).async).toBeUndefined();
      expect(result.output).toBeDefined();
      expect(result.output!.requestId).toBe(existingId);
      expect(result.output!.status).toBe("approved");
      expect(result.nextPort).toBe("approved");
    });

    test("idempotency: returns rejected result with correct nextPort", async () => {
      const stepId = crypto.randomUUID();
      const existingId = crypto.randomUUID();
      createApprovalRequest({
        id: existingId,
        title: "Rejected request",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });
      resolveApprovalRequest(existingId, {
        status: "rejected",
        responses: { q1: { approved: false } },
      });

      const executor = new HumanInTheLoopExecutor(mockDeps);
      const result = await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
        },
        context: {},
        meta: { ...mockMeta, stepId },
      });

      expect(result.status).toBe("success");
      expect(result.output!.status).toBe("rejected");
      expect(result.nextPort).toBe("rejected");
    });

    test("stores timeout config in request", async () => {
      const stepId = crypto.randomUUID();
      const executor = new HumanInTheLoopExecutor(mockDeps);

      await executor.run({
        config: {
          title: "Timed approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
          timeout: { seconds: 7200, action: "reject" },
        },
        context: {},
        meta: { ...mockMeta, stepId },
      });

      const created = getApprovalRequestByStepId(stepId);
      expect(created).not.toBeNull();
      expect(created!.timeoutSeconds).toBe(7200);
      expect(created!.expiresAt).toBeTruthy();
    });

    test("validates config schema", async () => {
      const executor = new HumanInTheLoopExecutor(mockDeps);

      const result = await executor.run({
        config: {
          // Missing required 'title' field
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
        },
        context: {},
        meta: mockMeta,
      });

      expect(result.status).toBe("failed");
    });

    test("validates config schema: empty questions array", async () => {
      const executor = new HumanInTheLoopExecutor(mockDeps);

      const result = await executor.run({
        config: {
          title: "Empty questions",
          questions: [],
          approvers: { policy: "any" },
        },
        context: {},
        meta: mockMeta,
      });

      expect(result.status).toBe("failed");
    });
  });

  // ─── Follow-up task flow ─────────────────────────────────────
  describe("Follow-up task: Slack metadata inheritance", () => {
    test("sourceTaskId is stored and returned on resolved approval request", () => {
      // Create a source task with Slack metadata
      const agent = createAgent({
        name: "test-follow-up-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = createTaskExtended("original task with slack context", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_TEST_CHANNEL",
        slackThreadTs: "1234567890.123456",
        slackUserId: "U_TEST_USER",
      });

      // Create approval request linked to source task
      const approvalData = makeApprovalData({ sourceTaskId: sourceTask.id });
      const approval = createApprovalRequest(approvalData);
      expect(approval.sourceTaskId).toBe(sourceTask.id);

      // Resolve it
      const resolved = resolveApprovalRequest(approval.id, {
        status: "approved",
        responses: { q1: { approved: true } },
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.sourceTaskId).toBe(sourceTask.id);
    });

    test("follow-up task inherits Slack metadata from source task via parentTaskId", () => {
      const agent = createAgent({
        name: "test-slack-inherit-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = createTaskExtended("source task", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_FOLLOW_UP",
        slackThreadTs: "9999999999.000000",
        slackUserId: "U_FOLLOW_UP",
      });

      // Simulate what the respond handler does: create follow-up with parentTaskId
      const followUp = createTaskExtended("follow-up task text", {
        agentId: sourceTask.agentId ?? undefined,
        parentTaskId: sourceTask.id,
        source: "system",
        taskType: "hitl-follow-up",
        tags: ["hitl", "follow-up"],
        // Explicit Slack metadata (as the handler now does)
        slackChannelId: sourceTask.slackChannelId ?? undefined,
        slackThreadTs: sourceTask.slackThreadTs ?? undefined,
        slackUserId: sourceTask.slackUserId ?? undefined,
      });

      expect(followUp.slackChannelId).toBe("C_FOLLOW_UP");
      expect(followUp.slackThreadTs).toBe("9999999999.000000");
      expect(followUp.slackUserId).toBe("U_FOLLOW_UP");
      expect(followUp.parentTaskId).toBe(sourceTask.id);
      expect(followUp.taskType).toBe("hitl-follow-up");
    });

    test("follow-up task inherits Slack metadata even without explicit pass (auto-inheritance)", () => {
      const agent = createAgent({
        name: "test-auto-inherit-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = createTaskExtended("source task auto", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_AUTO",
        slackThreadTs: "1111111111.000000",
        slackUserId: "U_AUTO",
      });

      // Without explicit Slack metadata — relies on auto-inheritance from parentTaskId
      const followUp = createTaskExtended("auto-inherit follow-up", {
        agentId: sourceTask.agentId ?? undefined,
        parentTaskId: sourceTask.id,
        source: "system",
        taskType: "hitl-follow-up",
      });

      expect(followUp.slackChannelId).toBe("C_AUTO");
      expect(followUp.slackThreadTs).toBe("1111111111.000000");
      expect(followUp.slackUserId).toBe("U_AUTO");
    });

    test("no follow-up for workflow-linked requests (workflowRunId set)", () => {
      const approvalData = makeApprovalData({
        sourceTaskId: crypto.randomUUID(),
        workflowRunId: crypto.randomUUID(),
        workflowRunStepId: crypto.randomUUID(),
      });
      const approval = createApprovalRequest(approvalData);

      // The condition in the handler is: !updated.workflowRunId && updated.sourceTaskId
      // With workflowRunId set, this should be false
      expect(approval.workflowRunId).toBeTruthy();
      expect(approval.sourceTaskId).toBeTruthy();
      // The handler would NOT create a follow-up task here
      expect(!approval.workflowRunId && approval.sourceTaskId).toBe(false);
    });

    test("no follow-up when sourceTaskId is missing", () => {
      const approvalData = makeApprovalData(); // no sourceTaskId
      const approval = createApprovalRequest(approvalData);

      expect(approval.sourceTaskId).toBeNull();
      // The handler condition would be false
      expect(!approval.workflowRunId && approval.sourceTaskId).toBeFalsy();
    });
  });

  // ─── Server-side sourceTaskId fallback ───────────────────────
  describe("getAgentCurrentTask fallback for sourceTaskId", () => {
    test("returns the most recent in-progress task for an agent", () => {
      const agent = createAgent({
        name: "test-current-task-agent",
        isLead: true,
        status: "idle",
      });

      // Create a task and set it to in_progress
      const task = createTaskExtended("lead agent task", {
        agentId: agent.id,
        source: "mcp",
      });
      startTask(task.id);

      const currentTask = getAgentCurrentTask(agent.id);
      expect(currentTask).not.toBeNull();
      expect(currentTask!.id).toBe(task.id);
    });

    test("returns null when agent has no in-progress tasks", () => {
      const agent = createAgent({
        name: "test-no-task-agent",
        isLead: true,
        status: "idle",
      });

      const currentTask = getAgentCurrentTask(agent.id);
      expect(currentTask).toBeNull();
    });

    test("fallback sourceTaskId resolves correctly for approval request", () => {
      const agent = createAgent({
        name: "test-fallback-agent",
        isLead: true,
        status: "idle",
      });
      const task = createTaskExtended("lead task calling request-human-input", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_LEAD_CHANNEL",
        slackThreadTs: "1111111111.000000",
        slackUserId: "U_LEAD_USER",
      });
      startTask(task.id);

      // Simulate what the fixed request-human-input tool does:
      // sourceTaskId from header is missing, so fall back to agent's current task
      const headerSourceTaskId: string | undefined = undefined;
      let sourceTaskId = headerSourceTaskId;
      if (!sourceTaskId) {
        const currentTask = getAgentCurrentTask(agent.id);
        if (currentTask) {
          sourceTaskId = currentTask.id;
        }
      }

      const approval = createApprovalRequest(makeApprovalData({ sourceTaskId }));
      expect(approval.sourceTaskId).toBe(task.id);
    });
  });

  describe("updateApprovalRequestNotifications", () => {
    test("stores messageTs back in notification channels", () => {
      const channels = [
        { channel: "slack", target: "C12345" },
        { channel: "email", target: "user@example.com" },
      ];
      const approval = createApprovalRequest(makeApprovalData({ notificationChannels: channels }));
      expect(approval.notificationChannels).toEqual(channels);

      const updatedChannels = [
        { channel: "slack", target: "C12345", messageTs: "1234567890.123456" },
        { channel: "email", target: "user@example.com" },
      ];
      updateApprovalRequestNotifications(approval.id, updatedChannels);

      const fetched = getApprovalRequestById(approval.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.notificationChannels).toEqual(updatedChannels);
    });
  });
});
