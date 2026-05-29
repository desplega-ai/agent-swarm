import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDb,
  getLogsByTaskId,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
  updateAgentStatus,
} from "../be/db";
import { buildResumeContextPreamble } from "../commands/context-preamble";
import { createResumeFollowUp } from "../tasks/worker-follow-up";

const TEST_DB_PATH = "./test-task-supersede-resume.sqlite";

async function cleanup() {
  try {
    await unlink(TEST_DB_PATH);
    await unlink(`${TEST_DB_PATH}-wal`);
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
}

function freshAgent(prefix: string, opts?: { maxTasks?: number; lastActivityAt?: string }) {
  const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const agent = createAgent({
    id,
    name: prefix,
    isLead: false,
    status: "idle",
  });
  if (opts?.maxTasks !== undefined || opts?.lastActivityAt) {
    getDb().run(
      "UPDATE agents SET maxTasks = COALESCE(?, maxTasks), lastActivityAt = COALESCE(?, lastActivityAt) WHERE id = ?",
      [opts.maxTasks ?? null, opts.lastActivityAt ?? null, id],
    );
  }
  return agent;
}

describe("Task Supersede + Resume", () => {
  beforeAll(async () => {
    await cleanup();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. supersedeTask() status transition + terminal guards
  // ──────────────────────────────────────────────────────────────────────────

  describe("supersedeTask()", () => {
    test("transitions in_progress → superseded and sets finishedAt", () => {
      const worker = freshAgent("worker-1");
      const task = createTaskExtended("Test supersede transition", {
        agentId: worker.id,
      });
      startTask(task.id);
      const inProgress = getTaskById(task.id);
      expect(inProgress?.status).toBe("in_progress");

      const result = supersedeTask(task.id, {
        reason: "graceful_shutdown",
        resumeTaskId: null,
      });
      expect(result?.status).toBe("superseded");
      expect(result?.finishedAt).toBeTruthy();

      const log = getLogsByTaskId(task.id).find((l) => l.eventType === "task_superseded");
      expect(log).toBeTruthy();
    });

    test("idempotent — second supersede returns null (alreadyFinished shape)", () => {
      const worker = freshAgent("worker-1b");
      const task = createTaskExtended("Idempotent supersede", { agentId: worker.id });
      startTask(task.id);
      const first = supersedeTask(task.id, { reason: "graceful_shutdown", resumeTaskId: null });
      expect(first?.status).toBe("superseded");

      const second = supersedeTask(task.id, {
        reason: "graceful_shutdown",
        resumeTaskId: null,
      });
      expect(second).toBeNull();
    });

    test("completeTask on a superseded task short-circuits", () => {
      const worker = freshAgent("worker-2");
      const task = createTaskExtended("Complete after supersede", { agentId: worker.id });
      startTask(task.id);
      supersedeTask(task.id, { reason: "graceful_shutdown", resumeTaskId: null });
      const result = completeTask(task.id, "should not happen");
      expect(result).toBeNull();
      expect(getTaskById(task.id)?.status).toBe("superseded");
    });

    test("failTask on a superseded task short-circuits", () => {
      const worker = freshAgent("worker-3");
      const task = createTaskExtended("Fail after supersede", { agentId: worker.id });
      startTask(task.id);
      supersedeTask(task.id, { reason: "graceful_shutdown", resumeTaskId: null });
      const result = failTask(task.id, "should not happen");
      expect(result).toBeNull();
      expect(getTaskById(task.id)?.status).toBe("superseded");
    });

    test("cancelTask on a superseded task short-circuits", () => {
      const worker = freshAgent("worker-4");
      const task = createTaskExtended("Cancel after supersede", { agentId: worker.id });
      startTask(task.id);
      supersedeTask(task.id, { reason: "graceful_shutdown", resumeTaskId: null });
      const result = cancelTask(task.id, "should not happen");
      expect(result).toBeNull();
      expect(getTaskById(task.id)?.status).toBe("superseded");
    });

    test("supersede on already completed task returns null", () => {
      const worker = freshAgent("worker-5");
      const task = createTaskExtended("Complete then supersede", { agentId: worker.id });
      startTask(task.id);
      completeTask(task.id, "done");
      const result = supersedeTask(task.id, {
        reason: "graceful_shutdown",
        resumeTaskId: null,
      });
      expect(result).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. createResumeFollowUp()
  // ──────────────────────────────────────────────────────────────────────────

  describe("createResumeFollowUp()", () => {
    test("non-workflow parent → creates resume task with inherited fields", () => {
      const worker = freshAgent("worker-6", { lastActivityAt: new Date().toISOString() });
      const parent = createTaskExtended("Parent with model+dir+vcs", {
        agentId: worker.id,
        model: "openrouter/openai/gpt-5-nano",
        dir: "/workspace/project-x",
        vcsRepo: "owner/repo",
        vcsProvider: "github",
      });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "graceful_shutdown",
      });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;

      const child = result.task;
      expect(child.taskType).toBe("resume");
      expect(child.parentTaskId).toBe(parent.id);
      expect(child.model).toBe("openrouter/openai/gpt-5-nano");
      expect(child.dir).toBe("/workspace/project-x");
      expect(child.vcsRepo).toBe("owner/repo");
      expect(child.vcsProvider).toBe("github");
      expect(child.tags).toContain("auto-resume");
      expect(child.tags).toContain("reason:graceful_shutdown");
      expect(child.priority).toBeGreaterThanOrEqual(parent.priority);
    });

    test("non-workflow parent with outputSchema → schema carries forward to resume child", () => {
      const worker = freshAgent("worker-6-schema", {
        lastActivityAt: new Date().toISOString(),
      });
      const schema = {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "fail"] },
          report: { type: "string" },
        },
        required: ["status"],
      };
      const parent = createTaskExtended("Parent with outputSchema", {
        agentId: worker.id,
        outputSchema: schema,
      });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "graceful_shutdown",
      });
      expect(result.kind).toBe("created");
      if (result.kind !== "created") return;

      // outputSchema must be preserved so `store-progress` still validates
      // completion output and the runner still injects structured-output
      // instructions (PR #594 review feedback).
      expect(result.task.outputSchema).toEqual(schema);
    });

    test("non-workflow parent with full VCS identity → all VCS fields carry forward", () => {
      // PR #594 review: codex flagged that `vcsNumber` (+ url/comment/installation/etc.)
      // were dropped on resume, breaking webhook routing via findTaskByVcs.
      // The fix lives in `createTaskExtended`'s parent-inheritance block —
      // this test guards against regression for ALL VCS identity fields at once.
      const worker = freshAgent("worker-vcs", {
        lastActivityAt: new Date().toISOString(),
      });
      const parent = createTaskExtended("Parent with full VCS context", {
        agentId: worker.id,
        vcsProvider: "github",
        vcsRepo: "desplega-ai/agent-swarm",
        vcsNumber: 594,
        vcsEventType: "pull_request.opened",
        vcsCommentId: 12345,
        vcsAuthor: "tarasyarema",
        vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/594",
        vcsInstallationId: 999,
        vcsNodeId: "PR_kwDOQr3Tmc7abcdef",
      });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "context_limits",
      });
      if (result.kind !== "created") throw new Error("expected created");

      expect(result.task.vcsProvider).toBe("github");
      expect(result.task.vcsRepo).toBe("desplega-ai/agent-swarm");
      expect(result.task.vcsNumber).toBe(594);
      expect(result.task.vcsEventType).toBe("pull_request.opened");
      expect(result.task.vcsCommentId).toBe(12345);
      expect(result.task.vcsAuthor).toBe("tarasyarema");
      expect(result.task.vcsUrl).toBe("https://github.com/desplega-ai/agent-swarm/pull/594");
      expect(result.task.vcsInstallationId).toBe(999);
      expect(result.task.vcsNodeId).toBe("PR_kwDOQr3Tmc7abcdef");
    });

    test("workflow-step parent → returns workflow-skip (no task created)", () => {
      const worker = freshAgent("worker-7");
      const parent = createTaskExtended("Workflow-step parent", {
        agentId: worker.id,
      });
      // Backfill workflowRunStepId directly (createTaskExtended doesn't take
      // it). Temporarily disable FKs since this test exercises only the
      // supersede carve-out, not the workflow engine itself.
      const stepId = crypto.randomUUID();
      getDb().exec("PRAGMA foreign_keys = OFF");
      try {
        getDb().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
          stepId,
          parent.id,
        ]);
      } finally {
        getDb().exec("PRAGMA foreign_keys = ON");
      }
      startTask(parent.id);

      const before = getDb()
        .prepare<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM agent_tasks WHERE taskType = 'resume'",
        )
        .get();
      const beforeCount = before?.count ?? 0;

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "graceful_shutdown",
      });
      expect(result.kind).toBe("workflow-skip");
      if (result.kind === "workflow-skip") {
        expect(result.stepId).toBe(stepId);
      }

      const after = getDb()
        .prepare<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM agent_tasks WHERE taskType = 'resume'",
        )
        .get();
      const afterCount = after?.count ?? 0;
      expect(afterCount).toBe(beforeCount);
    });

    test("routing: graceful_shutdown ALWAYS goes to pool, even on fresh+capable worker (PR #594 review)", () => {
      // The worker is exiting moments after this check — keeping the resume on
      // the same agent would orphan it once `closeAgent` runs. graceful_shutdown
      // must force the unassigned-pool path regardless of liveness.
      const worker = freshAgent("worker-fresh-shutdown", {
        maxTasks: 5,
        lastActivityAt: new Date().toISOString(),
      });
      const parent = createTaskExtended("Routing graceful_shutdown", { agentId: worker.id });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "graceful_shutdown",
      });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBeNull();
      expect(result.task.status).toBe("unassigned");
    });

    test("routing: fresh worker + capacity (non-shutdown) → resume pre-assigned to same worker", () => {
      // For context_limits / manual_supersede the worker is alive and can
      // continue handling the resume on a fresh session.
      const worker = freshAgent("worker-fresh", {
        maxTasks: 5,
        lastActivityAt: new Date().toISOString(),
      });
      const parent = createTaskExtended("Routing fresh", { agentId: worker.id });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "context_limits",
      });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBe(worker.id);
      expect(result.task.status).toBe("pending");
    });

    test("routing: stale heartbeat → unassigned", () => {
      const worker = freshAgent("worker-stale", {
        maxTasks: 5,
        lastActivityAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      });
      const parent = createTaskExtended("Routing stale", { agentId: worker.id });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "context_limits",
      });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBeNull();
      expect(result.task.status).toBe("unassigned");
    });

    test("routing: worker at capacity → unassigned", () => {
      const worker = freshAgent("worker-full", {
        maxTasks: 1,
        lastActivityAt: new Date().toISOString(),
      });
      // Parent is already in_progress, which counts as 1 in_progress task →
      // worker has zero remaining capacity (maxTasks=1).
      const parent = createTaskExtended("Routing capped", { agentId: worker.id });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "context_limits",
      });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBeNull();
    });

    test("routing: offline worker → unassigned", () => {
      const worker = freshAgent("worker-offline", {
        maxTasks: 5,
        lastActivityAt: new Date().toISOString(),
      });
      updateAgentStatus(worker.id, "offline");
      const parent = createTaskExtended("Routing offline", { agentId: worker.id });
      startTask(parent.id);

      const result = createResumeFollowUp({
        parentId: parent.id,
        reason: "context_limits",
      });
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBeNull();
    });

    test("missing parent → skipped(parent_not_found)", () => {
      const result = createResumeFollowUp({
        parentId: "00000000-0000-0000-0000-000000000000",
        reason: "graceful_shutdown",
      });
      expect(result.kind).toBe("skipped");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. buildResumeContextPreamble()
  // ──────────────────────────────────────────────────────────────────────────

  describe("buildResumeContextPreamble()", () => {
    // Spin a tiny HTTP server emulating the two endpoints the preamble fetches.
    let server: import("node:http").Server | undefined;
    let baseUrl = "";
    let testTaskId = "";
    let testTaskDescription = "";
    let mockSessionLogs: Array<{ createdAt: string; content: string }> = [];

    beforeAll(async () => {
      const { createServer } = await import("node:http");
      testTaskId = crypto.randomUUID();
      testTaskDescription =
        "Build a feature that processes user uploads end-to-end. " +
        "Include validation, virus scan, S3 upload, and a notification.";
      mockSessionLogs = [];

      server = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        const url = req.url ?? "";
        if (url === `/api/tasks/${testTaskId}`) {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              id: testTaskId,
              task: testTaskDescription,
              attachments: [],
            }),
          );
          return;
        }
        if (url === `/api/tasks/${testTaskId}/session-logs`) {
          res.writeHead(200);
          res.end(JSON.stringify({ logs: mockSessionLogs }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      });
      const port = 13099;
      await new Promise<void>((r) => server?.listen(port, () => r()));
      baseUrl = `http://localhost:${port}`;
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((r) => server?.close(() => r()));
      }
    });

    test("preserves the full parent task description", async () => {
      mockSessionLogs = [];
      const preamble = await buildResumeContextPreamble(baseUrl, "", testTaskId);
      expect(preamble).toBeTruthy();
      expect(preamble).toContain(testTaskDescription);
      expect(preamble).toContain("Resuming Interrupted Task");
    });

    test("scrubs secret-shaped values from session-log summaries", async () => {
      // GitHub PAT-shaped token — matches a structural pattern in
      // scrubSecrets (regardless of env state).
      const fakeToken = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      mockSessionLogs = [
        {
          createdAt: new Date().toISOString(),
          content: JSON.stringify({
            type: "tool_use",
            name: "Bash",
            input: { command: `curl -H 'Authorization: ${fakeToken}' https://api` },
          }),
        },
      ];

      const preamble = await buildResumeContextPreamble(baseUrl, "", testTaskId);
      expect(preamble).toBeTruthy();
      expect(preamble).not.toContain(fakeToken);
    });

    test("respects the 4000-token (16000-char) cap when over budget", async () => {
      // Generate a lot of session logs to push past the cap.
      mockSessionLogs = Array.from({ length: 200 }, (_, i) => ({
        createdAt: new Date().toISOString(),
        content: JSON.stringify({
          type: "tool_use",
          name: "Read",
          input: { file_path: `/workspace/src/long-path-${i}/file-${i}.ts` },
        }),
      }));

      const preamble = await buildResumeContextPreamble(baseUrl, "", testTaskId);
      expect(preamble).toBeTruthy();
      const text = preamble ?? "";
      // 4000 tokens * 4 chars/token = 16_000 chars hard cap; allow small
      // trailing truncation marker.
      expect(text.length).toBeLessThanOrEqual(16_500);
      // Description must remain intact.
      expect(text).toContain(testTaskDescription);
    });

    test("returns null when parent task is not found", async () => {
      const preamble = await buildResumeContextPreamble(
        baseUrl,
        "",
        "00000000-0000-0000-0000-000000000999",
      );
      expect(preamble).toBeNull();
    });
  });
});
