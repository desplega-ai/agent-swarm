import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createApprovalRequest,
  createScheduledTask,
  initDb,
  listApprovalRequestSummaries,
  listApprovalRequests,
  resolveApprovalRequest,
} from "../be/db";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleStats } from "../http/stats";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-ui-list-slim-projections.sqlite";

/**
 * `/api/scheduled-tasks` and `/api/approval-requests` serve the UI list pages.
 * `fields=slim` is opt-in: callers that don't pass it keep the full rows.
 */
describe("UI list slim projections", () => {
  let server: Server;
  let baseUrl = "";
  let approvalId = "";
  const template = `T${"x".repeat(5000)}`;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);

    server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      if (await handleStats(req, res, segments, url.searchParams)) return;
      if (await handleApprovalRequests(req, res, segments, url.searchParams)) return;
      res.writeHead(404);
      res.end();
    });
    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;

    await createScheduledTask({
      name: "slim-list-schedule",
      taskTemplate: template,
      cronExpression: "0 9 * * *",
      description: "daily report",
    });

    approvalId = crypto.randomUUID();
    await createApprovalRequest({
      id: approvalId,
      title: "Ship it?",
      questions: [
        { id: "q1", type: "approval", label: "Approve?", description: "D".repeat(2000) },
        { id: "q2", type: "text", label: "Why?" },
      ],
      approvers: { policy: "any" },
      sourceTaskId: "source-task-1",
      timeoutSeconds: 3600,
      notificationChannels: [{ channel: "slack", target: "C123" }],
    });
    await resolveApprovalRequest(approvalId, {
      status: "approved",
      responses: { q1: { approved: true }, q2: "because" },
      resolvedBy: "user-1",
    });
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

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, Array<Record<string, unknown>>>;
  }

  test("/api/scheduled-tasks keeps full rows by default", async () => {
    const { scheduledTasks } = await get("/api/scheduled-tasks");
    const row = scheduledTasks.find((s) => s.name === "slim-list-schedule");
    expect(row?.taskTemplate).toBe(template);
    expect(row && "taskTemplatePreview" in row).toBe(false);
  });

  test("/api/scheduled-tasks?fields=slim swaps taskTemplate for a preview", async () => {
    const { scheduledTasks } = await get("/api/scheduled-tasks?fields=slim");
    const row = scheduledTasks.find((s) => s.name === "slim-list-schedule");
    expect(row).toBeDefined();
    expect(row && "taskTemplate" in row).toBe(false);
    expect(String(row?.taskTemplatePreview).length).toBeLessThan(template.length);
    // Every other field the schedules list page reads is identical to the full row.
    const full = (await get("/api/scheduled-tasks")).scheduledTasks.find(
      (s) => s.name === "slim-list-schedule",
    );
    const { taskTemplate: _omitted, ...fullWithoutTemplate } = full ?? {};
    const { taskTemplatePreview: _preview, ...slimWithoutPreview } = row ?? {};
    expect(slimWithoutPreview).toEqual(fullWithoutTemplate);
  });

  test("/api/approval-requests keeps full rows by default", async () => {
    const { approvalRequests } = await get("/api/approval-requests");
    const row = approvalRequests.find((r) => r.id === approvalId);
    expect(row?.questions).toHaveLength(2);
    expect(row?.responses).toEqual({ q1: { approved: true }, q2: "because" });
    expect(row && "questionCount" in row).toBe(false);
  });

  test("/api/approval-requests?fields=slim drops bodies and counts questions", async () => {
    const { approvalRequests } = await get("/api/approval-requests?fields=slim&status=approved");
    const row = approvalRequests.find((r) => r.id === approvalId);
    expect(row).toBeDefined();
    for (const dropped of [
      "questions",
      "approvers",
      "responses",
      "resolutionReason",
      "notificationChannels",
    ]) {
      expect(row && dropped in row).toBe(false);
    }
    expect(row?.questionCount).toBe(2);
    expect(row?.title).toBe("Ship it?");
    expect(row?.status).toBe("approved");
    expect(row?.resolvedBy).toBe("user-1");
    expect(row?.sourceTaskId).toBe("source-task-1");
    expect(row?.workflowRunId).toBeNull();
    expect(typeof row?.createdAt).toBe("string");
    expect(typeof row?.expiresAt).toBe("string");
  });

  test("slim and full DB reads agree on filters, order and limit", async () => {
    for (let i = 0; i < 3; i++) {
      await createApprovalRequest({
        id: crypto.randomUUID(),
        title: `pending ${i}`,
        questions: [{ id: "q1", type: "boolean", label: "Ok?" }],
        approvers: { policy: "any" },
      });
    }
    const filters = { status: "pending", limit: 2 };
    const full = await listApprovalRequests(filters);
    const slim = await listApprovalRequestSummaries(filters);
    expect(slim.map((r) => r.id)).toEqual(full.map((r) => r.id));
    expect(slim.map((r) => r.questionCount)).toEqual(full.map((r) => r.questions.length));
  });
});
