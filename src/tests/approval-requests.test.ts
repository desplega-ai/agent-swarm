import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  cancelPendingApprovalRequestsForRun,
  claimApprovalCancellationNotification,
  closeDb,
  completeApprovalCancellationNotificationClaim,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  createUser,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getAgentCurrentTask,
  getApprovalRequestById,
  getApprovalRequestByStepId,
  getDbClient,
  getExpiredPendingApprovals,
  initDb,
  listApprovalRequests,
  releaseApprovalCancellationNotificationClaim,
  resolveApprovalRequest,
  startTask,
  updateApprovalRequestNotifications,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import {
  type ApprovalQuestion,
  getWorkflowApprovalUnavailableReason,
  handleApprovalRequests,
  missingRequiredResponseIds,
} from "../http/approval-requests";
import type { ExecutorMeta } from "../types";
import { postApprovalCancellationUpdates } from "../workflows/approval-notifications";
import { checkpointStepWaiting } from "../workflows/checkpoint";
import type { ExecutorDependencies, ExecutorInput } from "../workflows/executors/base";
import { HumanInTheLoopExecutor } from "../workflows/executors/human-in-the-loop";
import { cancelWorkflowRunStep } from "../workflows/resume";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-approval-requests.sqlite";

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
    const request = await createApprovalRequest({
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
    const requests = await listApprovalRequests({
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
    const existing = await getApprovalRequestById(id);
    if (!existing) return { status: 404, body: { error: "Not found" } };
    if (existing.status !== "pending") {
      return { status: 409, body: { error: `Already resolved: ${existing.status}` } };
    }

    const data = JSON.parse(body);
    const questions = existing.questions as ApprovalQuestion[];
    const missingRequired = missingRequiredResponseIds(questions, data.responses);
    if (missingRequired.length > 0) {
      return {
        status: 400,
        body: { error: `Required responses missing or invalid: ${missingRequired.join(", ")}` },
      };
    }
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

    const updated = await resolveApprovalRequest(id, {
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
    const request = await getApprovalRequestById(pathSegments[2]);
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

function createProductionApprovalServer(): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await handleApprovalRequests(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      url.searchParams,
    );
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

// ─── Test Setup ─────────────────────────────────────────────

describe("Approval Requests", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    server = createTestServer();
    const port = await listenOnFreePort(server);
    baseUrl = `http://localhost:${port}`;
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
    test("creates a minimal approval request", async () => {
      const data = makeApprovalData();
      const result = await createApprovalRequest(data);

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

    test("creates request with timeout and computes expiresAt", async () => {
      const data = makeApprovalData({ timeoutSeconds: 3600 });
      const before = Date.now();
      const result = await createApprovalRequest(data);

      expect(result.expiresAt).toBeTruthy();
      const expiresMs = new Date(result.expiresAt!).getTime();
      // expiresAt should be roughly now + 3600s
      expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000);
      expect(expiresMs).toBeLessThanOrEqual(before + 3600 * 1000 + 5000);
    });

    test("creates request with workflow linkage", async () => {
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const data = makeApprovalData({ workflowRunId: runId, workflowRunStepId: stepId });
      const result = await createApprovalRequest(data);

      expect(result.workflowRunId).toBe(runId);
      expect(result.workflowRunStepId).toBe(stepId);
    });

    test("creates request with notification channels", async () => {
      const data = makeApprovalData({
        notificationChannels: [{ channel: "slack", target: "#general" }],
      });
      const result = await createApprovalRequest(data);
      expect(result.notificationChannels).toEqual([{ channel: "slack", target: "#general" }]);
    });

    test("creates request with multiple question types", async () => {
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
      const result = await createApprovalRequest(data);
      expect(result.questions).toEqual(questions);
    });

    test("stamps createdBy when provided, round-trips through getApprovalRequestById", async () => {
      const requester = await createUser({
        name: "Approval Provenance User",
        email: "approval-provenance@example.com",
      });
      const data = makeApprovalData({ createdBy: requester.id });
      const created = await createApprovalRequest(data);
      expect(created.createdBy).toBe(requester.id);

      const fetched = await getApprovalRequestById(created.id);
      expect(fetched?.createdBy).toBe(requester.id);
    });

    test("createdBy is undefined when not provided", async () => {
      const result = await createApprovalRequest(makeApprovalData());
      expect(result.createdBy).toBeUndefined();
    });
  });

  describe("DB: getApprovalRequestById", () => {
    test("returns null for nonexistent ID", async () => {
      expect(await getApprovalRequestById(crypto.randomUUID())).toBeNull();
    });

    test("returns the correct request", async () => {
      const data = makeApprovalData();
      await createApprovalRequest(data);
      const fetched = await getApprovalRequestById(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.title).toBe(data.title);
    });
  });

  describe("DB: getApprovalRequestByStepId", () => {
    test("returns null when no request for step", async () => {
      expect(await getApprovalRequestByStepId(crypto.randomUUID())).toBeNull();
    });

    test("returns the request linked to a step", async () => {
      const stepId = crypto.randomUUID();
      const data = makeApprovalData({
        workflowRunId: crypto.randomUUID(),
        workflowRunStepId: stepId,
      });
      await createApprovalRequest(data);
      const fetched = await getApprovalRequestByStepId(stepId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
    });
  });

  describe("DB: resolveApprovalRequest", () => {
    test("resolves a pending request to approved", async () => {
      const data = makeApprovalData();
      await createApprovalRequest(data);

      const result = await resolveApprovalRequest(data.id, {
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

    test("resolves a pending request to rejected", async () => {
      const data = makeApprovalData();
      await createApprovalRequest(data);

      const result = await resolveApprovalRequest(data.id, { status: "rejected" });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("rejected");
    });

    test("returns null when trying to resolve an already-resolved request", async () => {
      const data = makeApprovalData();
      await createApprovalRequest(data);
      await resolveApprovalRequest(data.id, { status: "approved" });

      // Second resolve should fail (idempotency guard)
      const result = await resolveApprovalRequest(data.id, { status: "rejected" });
      expect(result).toBeNull();
    });

    test("returns null for nonexistent ID", async () => {
      const result = await resolveApprovalRequest(crypto.randomUUID(), { status: "approved" });
      expect(result).toBeNull();
    });

    test("does not resolve a workflow approval after its run and HITL step are cancelled", async () => {
      const workflow = await createWorkflow({
        name: `approval-cancel-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      await updateWorkflowRun(runId, { status: "cancelled" });
      await updateWorkflowRunStep(stepId, { status: "cancelled" });
      const approval = await createApprovalRequest(
        makeApprovalData({ workflowRunId: runId, workflowRunStepId: stepId }),
      );

      const result = await resolveApprovalRequest(
        approval.id,
        { status: "approved", responses: { q1: { approved: true } } },
        { requireActionableWorkflow: true },
      );

      expect(result).toBeNull();
      expect(await getWorkflowApprovalUnavailableReason(approval)).toBe(
        "The workflow run is cancelled and this approval is no longer actionable",
      );
      expect((await getApprovalRequestById(approval.id))?.status).toBe("pending");
    });

    test("does not resolve an approval linked to a step from another run", async () => {
      const workflow = await createWorkflow({
        name: `approval-mismatched-run-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const firstRunId = crypto.randomUUID();
      const secondRunId = crypto.randomUUID();
      const secondStepId = crypto.randomUUID();
      await createWorkflowRun({ id: firstRunId, workflowId: workflow.id });
      await createWorkflowRun({ id: secondRunId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: secondStepId,
        runId: secondRunId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      await updateWorkflowRunStep(secondStepId, { status: "waiting" });
      const approval = await createApprovalRequest(
        makeApprovalData({
          workflowRunId: firstRunId,
          workflowRunStepId: secondStepId,
        }),
      );

      expect(
        await resolveApprovalRequest(
          approval.id,
          { status: "approved", responses: { q1: { approved: true } } },
          { requireActionableWorkflow: true },
        ),
      ).toBeNull();
      expect(await getWorkflowApprovalUnavailableReason(approval)).toBe(
        "The human-in-the-loop step belongs to a different workflow run",
      );
    });
  });

  describe("DB: cancelPendingApprovalRequestsForRun", () => {
    test("records cancellation and posts one line to the stored Slack thread", async () => {
      const runId = crypto.randomUUID();
      const approval = await createApprovalRequest(
        makeApprovalData({
          workflowRunId: runId,
          workflowRunStepId: crypto.randomUUID(),
          notificationChannels: [
            { channel: "slack", target: "C123", messageTs: "1234567890.123456" },
          ],
        }),
      );

      const cancelled = await cancelPendingApprovalRequestsForRun(runId, "Superseded by v2");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]?.status).toBe("cancelled");
      expect(cancelled[0]?.resolutionReason).toBe("Superseded by v2");
      expect(cancelled[0]?.resolvedAt).toBeTruthy();

      const postMessage = mock(async () => ({}));
      await postApprovalCancellationUpdates(cancelled, "Superseded by v2", {
        chat: { postMessage },
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0]?.[0]).toEqual({
        channel: "C123",
        thread_ts: "1234567890.123456",
        text: "This approval is no longer actionable: Superseded by v2",
        unfurl_links: false,
        unfurl_media: false,
      });
      await postApprovalCancellationUpdates(cancelled, "Superseded by v2", {
        chat: { postMessage },
      });
      expect(postMessage).toHaveBeenCalledTimes(1);

      expect(await cancelPendingApprovalRequestsForRun(runId, "again")).toEqual([]);
      expect((await getApprovalRequestById(approval.id))?.resolutionReason).toBe(
        "Superseded by v2",
      );
    });

    test("posts after a late Slack timestamp is stored", async () => {
      const runId = crypto.randomUUID();
      const approval = await createApprovalRequest(
        makeApprovalData({
          workflowRunId: runId,
          workflowRunStepId: crypto.randomUUID(),
          notificationChannels: [{ channel: "slack", target: "C123" }],
        }),
      );
      const cancelled = await cancelPendingApprovalRequestsForRun(runId, "Superseded");
      const postMessage = mock(async () => ({}));

      await postApprovalCancellationUpdates(cancelled, "Superseded", {
        chat: { postMessage },
      });
      expect(postMessage).not.toHaveBeenCalled();

      await updateApprovalRequestNotifications(approval.id, [
        { channel: "slack", target: "C123", messageTs: "123.456" },
      ]);
      const latest = await getApprovalRequestById(approval.id);
      await postApprovalCancellationUpdates([latest!], "Superseded", {
        chat: { postMessage },
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    test("retries only the Slack thread whose delivery failed", async () => {
      const runId = crypto.randomUUID();
      const approval = await createApprovalRequest(
        makeApprovalData({
          workflowRunId: runId,
          workflowRunStepId: crypto.randomUUID(),
          notificationChannels: [
            { channel: "slack", target: "C_OK", messageTs: "123.456" },
            { channel: "slack", target: "C_RETRY", messageTs: "789.012" },
          ],
        }),
      );
      const cancelled = await cancelPendingApprovalRequestsForRun(runId, "Superseded");
      let retryFailures = 0;
      const postMessage = mock(async ({ channel }: { channel: string }) => {
        if (channel === "C_RETRY" && retryFailures++ === 0) {
          throw new Error("temporary Slack outage");
        }
        return {};
      });

      await postApprovalCancellationUpdates(cancelled, "Superseded", {
        chat: { postMessage },
      });
      const latest = await getApprovalRequestById(approval.id);
      await postApprovalCancellationUpdates([latest!], "Superseded", {
        chat: { postMessage },
      });
      expect(postMessage.mock.calls.map(([input]) => input.channel)).toEqual([
        "C_OK",
        "C_RETRY",
        "C_RETRY",
      ]);
    });

    test("a stale lease owner cannot finalize or release a reclaimed notification", async () => {
      const runId = crypto.randomUUID();
      const approval = await createApprovalRequest(
        makeApprovalData({ workflowRunId: runId, workflowRunStepId: crypto.randomUUID() }),
      );
      await cancelPendingApprovalRequestsForRun(runId, "Superseded");
      const key = "C123:123.456";
      const first = await claimApprovalCancellationNotification(approval.id, key);
      expect(first).not.toBeNull();

      const staleAt = new Date(Date.now() - 61_000).toISOString();
      await getDbClient().run(
        "UPDATE approval_requests SET cancellationNotificationClaims = ? WHERE id = ?",
        [
          JSON.stringify({
            [key]: { claimedAt: staleAt, leaseToken: first!.leaseToken },
          }),
          approval.id,
        ],
      );
      const second = await claimApprovalCancellationNotification(approval.id, key);
      expect(second).not.toBeNull();
      expect(second!.leaseToken).not.toBe(first!.leaseToken);

      await releaseApprovalCancellationNotificationClaim(approval.id, key, first!.leaseToken);
      expect(await claimApprovalCancellationNotification(approval.id, key)).toBeNull();
      await completeApprovalCancellationNotificationClaim(approval.id, key, first!.leaseToken);
      expect(await claimApprovalCancellationNotification(approval.id, key)).toBeNull();

      await completeApprovalCancellationNotificationClaim(approval.id, key, second!.leaseToken);
      expect(await claimApprovalCancellationNotification(approval.id, key)).toBeNull();
    });

    test("a late waiting checkpoint cannot revive a cancelled run and step", async () => {
      const workflow = await createWorkflow({
        name: `approval-checkpoint-race-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      await updateWorkflowRun(runId, { status: "cancelled", error: "Superseded" });
      await updateWorkflowRunStep(stepId, { status: "cancelled", error: "Superseded" });

      expect(await checkpointStepWaiting(runId, stepId, {})).toBe(false);
      const approval = await createApprovalRequest(
        makeApprovalData({ workflowRunId: runId, workflowRunStepId: stepId }),
      );
      expect(await getWorkflowApprovalUnavailableReason(approval)).toContain(
        "workflow run is cancelled",
      );
    });

    test("direct HITL step cancellation terminalizes its pending approval", async () => {
      const workflow = await createWorkflow({
        name: `approval-step-cancel-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      const approval = await createApprovalRequest(
        makeApprovalData({
          workflowRunId: runId,
          workflowRunStepId: stepId,
          notificationChannels: [{ channel: "slack", target: "C123", messageTs: "123.456" }],
        }),
      );

      const postMessage = mock(async () => ({}));
      await cancelWorkflowRunStep(stepId, "Step superseded", {
        chat: { postMessage },
      });

      expect(await getApprovalRequestById(approval.id)).toMatchObject({
        status: "cancelled",
        resolutionReason: "Step superseded",
      });
      expect(postMessage).toHaveBeenCalledWith({
        channel: "C123",
        thread_ts: "123.456",
        text: "This approval is no longer actionable: Step superseded",
        unfurl_links: false,
        unfurl_media: false,
      });
    });

    test("retrying a cancelled HITL step reuses its persisted reason", async () => {
      const workflow = await createWorkflow({
        name: `approval-step-retry-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      await createApprovalRequest(
        makeApprovalData({
          workflowRunId: runId,
          workflowRunStepId: stepId,
          notificationChannels: [{ channel: "slack", target: "C123", messageTs: "123.456" }],
        }),
      );

      const failedPost = mock(async () => {
        throw new Error("temporary Slack outage");
      });
      await cancelWorkflowRunStep(stepId, "Original reason", {
        chat: { postMessage: failedPost },
      });

      const retryPost = mock(async () => ({}));
      await cancelWorkflowRunStep(stepId, "Different retry reason", {
        chat: { postMessage: retryPost },
      });
      expect(retryPost.mock.calls[0]?.[0].text).toBe(
        "This approval is no longer actionable: Original reason",
      );
    });
  });

  describe("DB: listApprovalRequests", () => {
    test("lists all requests (with limit)", async () => {
      const results = await listApprovalRequests({ limit: 1000 });
      expect(results.length).toBeGreaterThan(0);
    });

    test("filters by status", async () => {
      // Create a fresh pending one
      const data = makeApprovalData();
      await createApprovalRequest(data);

      const pending = await listApprovalRequests({ status: "pending" });
      expect(pending.length).toBeGreaterThan(0);
      for (const r of pending) {
        expect(r.status).toBe("pending");
      }
    });

    test("filters by workflowRunId", async () => {
      const runId = crypto.randomUUID();
      const data = makeApprovalData({ workflowRunId: runId });
      await createApprovalRequest(data);

      const results = await listApprovalRequests({ workflowRunId: runId });
      expect(results).toHaveLength(1);
      expect(results[0].workflowRunId).toBe(runId);
    });

    test("respects limit", async () => {
      const results = await listApprovalRequests({ limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  describe("DB: getExpiredPendingApprovals", () => {
    test("returns empty for non-expired requests", async () => {
      // All our test requests with timeout have expiresAt in the future
      const expired = await getExpiredPendingApprovals();
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

    test("applies status before limiting newer rows", async () => {
      const pending = await createApprovalRequest(
        makeApprovalData({ title: "Older pending request" }),
      );
      await getDbClient().run("UPDATE approval_requests SET createdAt = ? WHERE id = ?", [
        "2099-01-01T00:00:00.000Z",
        pending.id,
      ]);

      for (const index of [1, 2]) {
        const resolved = await createApprovalRequest(
          makeApprovalData({ title: `Newer resolved request ${index}` }),
        );
        await resolveApprovalRequest(resolved.id, {
          status: "approved",
          responses: { q1: { approved: true } },
        });
        await getDbClient().run("UPDATE approval_requests SET createdAt = ? WHERE id = ?", [
          `2100-01-0${index}T00:00:00.000Z`,
          resolved.id,
        ]);
      }

      const unfiltered = await fetch(`${baseUrl}/api/approval-requests?limit=1`);
      const unfilteredData = (await unfiltered.json()) as {
        approvalRequests: Array<{ id: string }>;
      };
      expect(unfilteredData.approvalRequests[0]?.id).not.toBe(pending.id);

      const filtered = await fetch(`${baseUrl}/api/approval-requests?status=pending&limit=1`);
      expect(filtered.status).toBe(200);
      const filteredData = (await filtered.json()) as {
        approvalRequests: Array<{ id: string; status: string }>;
      };
      expect(filteredData.approvalRequests).toEqual([
        expect.objectContaining({ id: pending.id, status: "pending" }),
      ]);
    });

    test("filters by workflowRunId", async () => {
      const runId = crypto.randomUUID();
      // Create one with this runId
      await createApprovalRequest(makeApprovalData({ workflowRunId: runId }));

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
      const created = await createApprovalRequest(makeApprovalData());
      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { approvalRequest: { id: string; title: string } };
      expect(data.approvalRequest.id).toBe(created.id);
    });
  });

  describe("HTTP: POST /api/approval-requests/:id/respond", () => {
    test("production route rejects a late response after workflow cancellation", async () => {
      const workflow = await createWorkflow({
        name: `approval-http-cancel-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      const approval = await createApprovalRequest(
        makeApprovalData({ workflowRunId: runId, workflowRunStepId: stepId }),
      );
      await updateWorkflowRun(runId, { status: "cancelled", error: "Superseded" });
      await updateWorkflowRunStep(stepId, { status: "cancelled", error: "Superseded" });

      const productionServer = createProductionApprovalServer();
      const port = await listenOnFreePort(productionServer);
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/approval-requests/${approval.id}/respond`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ responses: { q1: { approved: true } } }),
          },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: "Approval request already resolved with status: cancelled: Superseded",
        });
        expect((await getApprovalRequestById(approval.id))?.status).toBe("cancelled");
      } finally {
        await new Promise<void>((resolve, reject) =>
          productionServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    test("approves a pending request", async () => {
      const created = await createApprovalRequest(makeApprovalData());

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
      const created = await createApprovalRequest(makeApprovalData());

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

    test("keeps the request pending when a required rejection reason is blank", async () => {
      const created = await createApprovalRequest(
        makeApprovalData({
          questions: [
            { id: "q1", type: "approval", label: "Approve?", required: true },
            { id: "reason", type: "text", label: "Reason", required: true },
          ],
        }),
      );

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          responses: { q1: { approved: false }, reason: "   " },
        }),
      });

      expect(res.status).toBe(400);
      expect((await getApprovalRequestById(created.id))?.status).toBe("pending");
    });

    test("keeps the request pending when a required approval decision is missing", async () => {
      const created = await createApprovalRequest(makeApprovalData());

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses: {} }),
      });

      expect(res.status).toBe(400);
      expect((await getApprovalRequestById(created.id))?.status).toBe("pending");
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
      const created = await createApprovalRequest(makeApprovalData());
      await resolveApprovalRequest(created.id, { status: "approved" });

      const res = await fetch(`${baseUrl}/api/approval-requests/${created.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses: { q1: { approved: true } } }),
      });
      expect(res.status).toBe(409);
    });

    test("approves when there are no approval-type questions", async () => {
      const created = await createApprovalRequest(
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
      expect((result as any).async).toBe(true);
      expect((result as any).waitFor).toBe("approval.resolved");
      expect((result as any).correlationId).toBeTruthy();

      // Verify the request was created in DB
      const created = await getApprovalRequestByStepId(stepId);
      expect(created).not.toBeNull();
      expect(created!.title).toBe("Deploy approval");
      expect(created!.workflowRunStepId).toBe(stepId);
    });

    test("creates a terminal approval when cancellation wins the creation race", async () => {
      const workflow = await createWorkflow({
        name: `approval-create-race-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      await createWorkflowRun({ id: runId, workflowId: workflow.id });
      await createWorkflowRunStep({
        id: stepId,
        runId,
        nodeId: "approval",
        nodeType: "human-in-the-loop",
      });
      await updateWorkflowRun(runId, { status: "cancelled", error: "Superseded" });
      await updateWorkflowRunStep(stepId, { status: "cancelled", error: "Superseded" });

      const executor = new HumanInTheLoopExecutor({
        ...mockDeps,
        db: (await import("../be/db")) as typeof import("../be/db"),
      });
      const result = await executor.run({
        config: {
          title: "Stale approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?" }],
          approvers: { policy: "any" },
        },
        context: {},
        meta: { ...mockMeta, runId, stepId },
      });

      expect(result.status).toBe("success");
      expect((result as { async?: boolean }).async).toBe(true);
      expect((await getApprovalRequestByStepId(stepId))?.status).toBe("cancelled");
      expect((await getApprovalRequestByStepId(stepId))?.resolutionReason).toBe("Superseded");
    });

    test("stamps createdBy from meta.requestedByUserId (workflow-run provenance)", async () => {
      const requester = await createUser({
        name: "HITL Requester",
        email: "hitl-requester@example.com",
      });
      const stepId = crypto.randomUUID();
      const meta = { ...mockMeta, stepId, requestedByUserId: requester.id };
      const executor = new HumanInTheLoopExecutor(mockDeps);

      await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
          approvers: { policy: "any" },
        },
        context: {},
        meta,
      });

      const created = await getApprovalRequestByStepId(stepId);
      expect(created?.createdBy).toBe(requester.id);
    });

    test("leaves createdBy unset when the workflow run carries no requester", async () => {
      const stepId = crypto.randomUUID();
      const meta = { ...mockMeta, stepId };
      const executor = new HumanInTheLoopExecutor(mockDeps);

      await executor.run({
        config: {
          title: "Deploy approval",
          questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
          approvers: { policy: "any" },
        },
        context: {},
        meta,
      });

      const created = await getApprovalRequestByStepId(stepId);
      expect(created?.createdBy).toBeUndefined();
    });

    test("idempotency: returns async marker for pending existing request", async () => {
      const stepId = crypto.randomUUID();
      // Pre-create an approval request for this step
      const existingId = crypto.randomUUID();
      await createApprovalRequest({
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
      expect((result as any).async).toBe(true);
      expect((result as any).correlationId).toBe(existingId);
    });

    test("idempotency: returns resolved result for completed request", async () => {
      const stepId = crypto.randomUUID();
      const existingId = crypto.randomUUID();
      await createApprovalRequest({
        id: existingId,
        title: "Already resolved",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });
      await resolveApprovalRequest(existingId, {
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
      expect((result as any).async).toBeUndefined();
      expect(result.output).toBeDefined();
      expect(result.output!.requestId).toBe(existingId);
      expect(result.output!.status).toBe("approved");
      expect(result.nextPort).toBe("approved");
    });

    test("idempotency: fails instead of routing a cancelled request as approved", async () => {
      const stepId = crypto.randomUUID();
      const existingId = crypto.randomUUID();
      await createApprovalRequest({
        id: existingId,
        title: "Cancelled request",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });
      await cancelPendingApprovalRequestsForRun(mockMeta.runId, "Run superseded");

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

      expect(result).toEqual({
        status: "failed",
        error: "Approval request was cancelled: Run superseded",
      });
    });

    test("idempotency: returns rejected result with correct nextPort", async () => {
      const stepId = crypto.randomUUID();
      const existingId = crypto.randomUUID();
      await createApprovalRequest({
        id: existingId,
        title: "Rejected request",
        questions: [{ id: "q1", type: "approval", label: "Approve?" }],
        approvers: { policy: "any" },
        workflowRunId: mockMeta.runId,
        workflowRunStepId: stepId,
      });
      await resolveApprovalRequest(existingId, {
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

      const created = await getApprovalRequestByStepId(stepId);
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
    test("sourceTaskId is stored and returned on resolved approval request", async () => {
      // Create a source task with Slack metadata
      const agent = await createAgent({
        name: "test-follow-up-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = await createTaskExtended("original task with slack context", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_TEST_CHANNEL",
        slackThreadTs: "1234567890.123456",
        slackUserId: "U_TEST_USER",
      });

      // Create approval request linked to source task
      const approvalData = makeApprovalData({ sourceTaskId: sourceTask.id });
      const approval = await createApprovalRequest(approvalData);
      expect(approval.sourceTaskId).toBe(sourceTask.id);

      // Resolve it
      const resolved = await resolveApprovalRequest(approval.id, {
        status: "approved",
        responses: { q1: { approved: true } },
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.sourceTaskId).toBe(sourceTask.id);
    });

    test("follow-up task inherits Slack metadata from source task via parentTaskId", async () => {
      const agent = await createAgent({
        name: "test-slack-inherit-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = await createTaskExtended("source task", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_FOLLOW_UP",
        slackThreadTs: "9999999999.000000",
        slackUserId: "U_FOLLOW_UP",
      });

      // Simulate what the respond handler does: create follow-up with parentTaskId
      const followUp = await createTaskExtended("follow-up task text", {
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

    test("follow-up task inherits Slack metadata even without explicit pass (auto-inheritance)", async () => {
      const agent = await createAgent({
        name: "test-auto-inherit-agent",
        isLead: false,
        status: "idle",
      });
      const sourceTask = await createTaskExtended("source task auto", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_AUTO",
        slackThreadTs: "1111111111.000000",
        slackUserId: "U_AUTO",
      });

      // Without explicit Slack metadata — relies on auto-inheritance from parentTaskId
      const followUp = await createTaskExtended("auto-inherit follow-up", {
        agentId: sourceTask.agentId ?? undefined,
        parentTaskId: sourceTask.id,
        source: "system",
        taskType: "hitl-follow-up",
      });

      expect(followUp.slackChannelId).toBe("C_AUTO");
      expect(followUp.slackThreadTs).toBe("1111111111.000000");
      expect(followUp.slackUserId).toBe("U_AUTO");
    });

    test("no follow-up for workflow-linked requests (workflowRunId set)", async () => {
      const approvalData = makeApprovalData({
        sourceTaskId: crypto.randomUUID(),
        workflowRunId: crypto.randomUUID(),
        workflowRunStepId: crypto.randomUUID(),
      });
      const approval = await createApprovalRequest(approvalData);

      // The condition in the handler is: !updated.workflowRunId && updated.sourceTaskId
      // With workflowRunId set, this should be false
      expect(approval.workflowRunId).toBeTruthy();
      expect(approval.sourceTaskId).toBeTruthy();
      // The handler would NOT create a follow-up task here
      expect(!approval.workflowRunId && approval.sourceTaskId).toBe(false);
    });

    test("no follow-up when sourceTaskId is missing", async () => {
      const approvalData = makeApprovalData(); // no sourceTaskId
      const approval = await createApprovalRequest(approvalData);

      expect(approval.sourceTaskId).toBeNull();
      // The handler condition would be false
      expect(!approval.workflowRunId && approval.sourceTaskId).toBeFalsy();
    });
  });

  // ─── Server-side sourceTaskId fallback ───────────────────────
  describe("getAgentCurrentTask fallback for sourceTaskId", () => {
    test("returns the most recent in-progress task for an agent", async () => {
      const agent = await createAgent({
        name: "test-current-task-agent",
        isLead: true,
        status: "idle",
      });

      // Create a task and set it to in_progress
      const task = await createTaskExtended("lead agent task", {
        agentId: agent.id,
        source: "mcp",
      });
      await startTask(task.id);

      const currentTask = await getAgentCurrentTask(agent.id);
      expect(currentTask).not.toBeNull();
      expect(currentTask!.id).toBe(task.id);
    });

    test("returns null when agent has no in-progress tasks", async () => {
      const agent = await createAgent({
        name: "test-no-task-agent",
        isLead: true,
        status: "idle",
      });

      const currentTask = await getAgentCurrentTask(agent.id);
      expect(currentTask).toBeNull();
    });

    test("fallback sourceTaskId resolves correctly for approval request", async () => {
      const agent = await createAgent({
        name: "test-fallback-agent",
        isLead: true,
        status: "idle",
      });
      const task = await createTaskExtended("lead task calling request-human-input", {
        agentId: agent.id,
        source: "mcp",
        slackChannelId: "C_LEAD_CHANNEL",
        slackThreadTs: "1111111111.000000",
        slackUserId: "U_LEAD_USER",
      });
      await startTask(task.id);

      // Simulate what the fixed request-human-input tool does:
      // sourceTaskId from header is missing, so fall back to agent's current task
      const headerSourceTaskId: string | undefined = undefined;
      let sourceTaskId = headerSourceTaskId;
      if (!sourceTaskId) {
        const currentTask = await getAgentCurrentTask(agent.id);
        if (currentTask) {
          sourceTaskId = currentTask.id;
        }
      }

      const approval = await createApprovalRequest(makeApprovalData({ sourceTaskId }));
      expect(approval.sourceTaskId).toBe(task.id);
    });
  });

  describe("updateApprovalRequestNotifications", () => {
    test("stores messageTs back in notification channels", async () => {
      const channels = [
        { channel: "slack", target: "C12345" },
        { channel: "email", target: "user@example.com" },
      ];
      const approval = await createApprovalRequest(
        makeApprovalData({ notificationChannels: channels }),
      );
      expect(approval.notificationChannels).toEqual(channels);

      const updatedChannels = [
        { channel: "slack", target: "C12345", messageTs: "1234567890.123456" },
        { channel: "email", target: "user@example.com" },
      ];
      await updateApprovalRequestNotifications(approval.id, updatedChannels);

      const fetched = await getApprovalRequestById(approval.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.notificationChannels).toEqual(updatedChannels);
    });
  });
});
