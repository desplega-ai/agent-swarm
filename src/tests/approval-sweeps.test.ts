import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";

// Every Slack post from the sweeps goes through getSlackApp(); capture them.
const postMessage = mock(async (_args: Record<string, unknown>) => ({}));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({ client: { chat: { postMessage } } }),
}));

import { z } from "zod";
import {
  autoCancelStaleApprovalRequests,
  timeoutExpiredApprovalRequests,
} from "../be/approval-sweeps";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getApprovalRequestById,
  getDbClient,
  getTaskById,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  resolveApprovalRequest,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";

const TEST_DB_PATH = "./test-approval-sweeps.sqlite";
const KEY = "APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS";
const DAY = 86_400_000;
const REASON_7 = "Auto-cancelled by the approval sweep after 7 days with no response";

class EchoExecutor extends BaseExecutor<typeof EchoExecutor.schema, typeof EchoExecutor.outSchema> {
  static readonly schema = z.object({ message: z.string() });
  static readonly outSchema = z.object({ echo: z.string() });

  readonly type = "echo";
  readonly mode = "instant" as const;
  readonly configSchema = EchoExecutor.schema;
  readonly outputSchema = EchoExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof EchoExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof EchoExecutor.outSchema>>> {
    return { status: "success", output: { echo: config.message } };
  }
}

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (t: string) => t,
};

let agentId = "";

async function makeRequest(opts: {
  ageDays: number;
  expiresInMs?: number | null;
  workflowRunId?: string;
  workflowRunStepId?: string;
  sourceTaskId?: string;
  notificationChannels?: unknown[];
}) {
  const id = crypto.randomUUID();
  await createApprovalRequest({
    id,
    title: "Stale approval",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers: { policy: "any" },
    workflowRunId: opts.workflowRunId,
    workflowRunStepId: opts.workflowRunStepId,
    sourceTaskId: opts.sourceTaskId,
    notificationChannels: opts.notificationChannels,
  });
  const createdAt = new Date(Date.now() - opts.ageDays * DAY).toISOString();
  const expiresAt =
    opts.expiresInMs == null ? null : new Date(Date.now() + opts.expiresInMs).toISOString();
  await getDbClient().run(
    "UPDATE approval_requests SET createdAt = ?, expiresAt = ? WHERE id = ?",
    [createdAt, expiresAt, id],
  );
  return id;
}

const definition = {
  nodes: [
    {
      id: "review",
      type: "human-in-the-loop",
      config: {},
      next: { approved: "deploy", rejected: "reject", timeout: "notify-timeout" },
    },
    { id: "deploy", type: "echo", config: { message: "deploying" } },
    { id: "reject", type: "echo", config: { message: "rejected" } },
    { id: "notify-timeout", type: "echo", config: { message: "timed out" } },
  ],
};

async function makeRun(runStatus: "running" | "waiting" | "failed" | "completed") {
  const workflow = await createWorkflow({
    name: `approval-sweep-${crypto.randomUUID()}`,
    definition,
  });
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: workflow.id });
  await createWorkflowRunStep({
    id: stepId,
    runId,
    nodeId: "review",
    nodeType: "human-in-the-loop",
  });
  await updateWorkflowRunStep(stepId, { status: "waiting" });
  await updateWorkflowRun(runId, { status: runStatus });
  return { runId, stepId };
}

async function makeSourceTask(status: string) {
  const task = await createTaskExtended(`source task ${crypto.randomUUID()}`, {
    agentId,
    source: "mcp",
  });
  await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, task.id]);
  return task.id;
}

// Slack posts run in an afterCommit hook, after the sweep call returns.
async function waitForSlackPosts(count: number) {
  for (let i = 0; i < 100 && postMessage.mock.calls.length < count; i++) {
    await Bun.sleep(10);
  }
}

async function followUpsFor(parentTaskId: string) {
  return getDbClient().query<{ id: string; agentId: string | null; task: string }>(
    "SELECT id, agentId, task FROM agent_tasks WHERE taskType = 'hitl-follow-up' AND parentTaskId = ?",
    [parentTaskId],
  );
}

describe("approval sweeps", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    agentId = (await createAgent({ name: "sweep-agent", isLead: false, status: "idle" })).id;
  });

  afterAll(async () => {
    delete process.env[KEY];
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  beforeEach(async () => {
    process.env[KEY] = "7";
    postMessage.mockClear();
    // Each test starts with no pending rows, so sweep results stay local.
    await getDbClient().run(
      "UPDATE approval_requests SET status = 'rejected' WHERE status = 'pending'",
    );
  });

  describe("auto-cancel sweep", () => {
    test("cancels a standalone request older than the setting", async () => {
      const id = await makeRequest({ ageDays: 8 });

      const result = await autoCancelStaleApprovalRequests();

      expect(result.cancelled.map((r) => r.id)).toEqual([id]);
      const row = await getApprovalRequestById(id);
      expect(row!.status).toBe("cancelled");
      expect(row!.resolvedAt).toBeTruthy();
      expect(row!.resolvedBy).toBeNull();
      expect(row!.resolutionReason).toBe(REASON_7);
    });

    test("does nothing when the setting is 0", async () => {
      process.env[KEY] = "0";
      const id = await makeRequest({ ageDays: 8 });

      expect((await autoCancelStaleApprovalRequests()).cancelled).toEqual([]);
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("leaves a request younger than the setting pending", async () => {
      const id = await makeRequest({ ageDays: 6 });
      await autoCancelStaleApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("never cancels a request with a future expiresAt", async () => {
      const id = await makeRequest({ ageDays: 8, expiresInMs: 30 * DAY });
      await autoCancelStaleApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("leaves an expired request to the timeout sweep", async () => {
      const id = await makeRequest({ ageDays: 8, expiresInMs: -DAY });
      await autoCancelStaleApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("cancels the waiting run, its step, and its linked task", async () => {
      const { runId, stepId } = await makeRun("waiting");
      const task = await createTaskExtended("step task", {
        agentId,
        source: "mcp",
        workflowRunId: runId,
        workflowRunStepId: stepId,
      });
      await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
        task.id,
      ]);
      const id = await makeRequest({ ageDays: 8, workflowRunId: runId, workflowRunStepId: stepId });

      const result = await autoCancelStaleApprovalRequests();

      expect(result.runsCancelled).toEqual([runId]);
      const row = await getApprovalRequestById(id);
      expect(row!.status).toBe("cancelled");
      expect(row!.resolutionReason).toBe(REASON_7);
      expect(row!.resolvedBy).toBeNull();
      const run = await getWorkflowRun(runId);
      expect(run!.status).toBe("cancelled");
      expect(run!.error).toBe(REASON_7);
      const steps = await getWorkflowRunStepsByRunId(runId);
      expect(steps.find((s) => s.id === stepId)!.status).toBe("cancelled");
      expect((await getTaskById(task.id))!.status).toBe("cancelled");
    });

    test("cancels a running run", async () => {
      const { runId, stepId } = await makeRun("running");
      const id = await makeRequest({ ageDays: 8, workflowRunId: runId, workflowRunStepId: stepId });

      await autoCancelStaleApprovalRequests();

      expect((await getApprovalRequestById(id))!.status).toBe("cancelled");
      expect((await getWorkflowRun(runId))!.status).toBe("cancelled");
    });

    test("cancels a run once when 2 of its requests are stale", async () => {
      const { runId, stepId } = await makeRun("waiting");
      const first = await makeRequest({
        ageDays: 9,
        workflowRunId: runId,
        workflowRunStepId: stepId,
      });
      const second = await makeRequest({ ageDays: 8, workflowRunId: runId });

      const result = await autoCancelStaleApprovalRequests();

      expect(result.runsCancelled).toEqual([runId]);
      expect((await getApprovalRequestById(first))!.status).toBe("cancelled");
      expect((await getApprovalRequestById(second))!.status).toBe("cancelled");
      expect((await getWorkflowRun(runId))!.status).toBe("cancelled");
    });

    test("a failed run cancel rolls the request cancel back", async () => {
      const { runId, stepId } = await makeRun("waiting");
      const id = await makeRequest({ ageDays: 8, workflowRunId: runId, workflowRunStepId: stepId });
      await getDbClient().run(
        `CREATE TRIGGER fail_run_cancel BEFORE UPDATE OF status ON workflow_runs
           WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'run cancel failed'); END`,
      );
      try {
        const result = await autoCancelStaleApprovalRequests();
        expect(result.cancelled).toEqual([]);
        expect((await getApprovalRequestById(id))!.status).toBe("pending");
        expect((await getWorkflowRun(runId))!.status).toBe("waiting");
        expect((await getWorkflowRunStepsByRunId(runId))[0]!.status).toBe("waiting");
      } finally {
        await getDbClient().run("DROP TRIGGER fail_run_cancel");
      }

      // The next tick retries the row and cancels both.
      await autoCancelStaleApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("cancelled");
      expect((await getWorkflowRun(runId))!.status).toBe("cancelled");
    });

    test("leaves a failed run as it is", async () => {
      const { runId, stepId } = await makeRun("failed");
      const id = await makeRequest({ ageDays: 8, workflowRunId: runId, workflowRunStepId: stepId });

      const result = await autoCancelStaleApprovalRequests();

      expect((await getApprovalRequestById(id))!.status).toBe("cancelled");
      expect((await getWorkflowRun(runId))!.status).toBe("failed");
      expect(result.runsCancelled).toEqual([]);
    });

    test("creates no follow-up task", async () => {
      const sourceTaskIds = [
        await makeSourceTask("in_progress"),
        await makeSourceTask("in_progress"),
        await makeSourceTask("in_progress"),
      ];
      for (const sourceTaskId of sourceTaskIds) await makeRequest({ ageDays: 8, sourceTaskId });

      expect((await autoCancelStaleApprovalRequests()).cancelled).toHaveLength(3);
      for (const sourceTaskId of sourceTaskIds) {
        expect(await followUpsFor(sourceTaskId)).toHaveLength(0);
      }
    });

    test("does not touch an approved request", async () => {
      const id = await makeRequest({ ageDays: 8 });
      await resolveApprovalRequest(id, { status: "approved" });

      await autoCancelStaleApprovalRequests();

      expect((await getApprovalRequestById(id))!.status).toBe("approved");
    });

    test("a second sweep finds nothing", async () => {
      await makeRequest({ ageDays: 8 });
      expect((await autoCancelStaleApprovalRequests()).cancelled).toHaveLength(1);
      expect((await autoCancelStaleApprovalRequests()).cancelled).toHaveLength(0);
    });

    test("posts to a recorded Slack thread only", async () => {
      await makeRequest({
        ageDays: 8,
        notificationChannels: [{ channel: "slack", target: "C1", messageTs: "111.222" }],
      });
      await makeRequest({ ageDays: 8 });

      await autoCancelStaleApprovalRequests();
      await waitForSlackPosts(1);

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0]![0]).toMatchObject({ channel: "C1", thread_ts: "111.222" });
    });
  });

  describe("timeout sweep", () => {
    test("sets timeout on a standalone request past expiresAt", async () => {
      const id = await makeRequest({ ageDays: 0, expiresInMs: -3_600_000 });

      const result = await timeoutExpiredApprovalRequests();

      expect(result.timedOut.map((r) => r.id)).toEqual([id]);
      const row = await getApprovalRequestById(id);
      expect(row!.status).toBe("timeout");
      expect(row!.resolvedAt).toBeTruthy();
      expect(row!.resolvedBy).toBeNull();
      expect(row!.responses).toBeNull();
      expect(row!.resolutionReason).toStartWith(
        "Timed out by the approval sweep: no answer before",
      );
    });

    test("leaves a request with a future expiresAt pending", async () => {
      const id = await makeRequest({ ageDays: 0, expiresInMs: 3_600_000 });
      await timeoutExpiredApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("leaves a request with no expiresAt to the auto-cancel sweep", async () => {
      const id = await makeRequest({ ageDays: 100 });
      await timeoutExpiredApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("pending");
    });

    test("times out a request on a waiting run; recovery routes it on the timeout port", async () => {
      const { runId, stepId } = await makeRun("waiting");
      const id = await makeRequest({
        ageDays: 0,
        expiresInMs: -60_000,
        workflowRunId: runId,
        workflowRunStepId: stepId,
      });

      await timeoutExpiredApprovalRequests();

      const row = await getApprovalRequestById(id);
      expect(row!.status).toBe("timeout");
      expect(row!.resolutionReason).toStartWith("Timed out by the approval sweep");
      expect((await getWorkflowRun(runId))!.status).toBe("waiting");
      expect((await getWorkflowRunStepsByRunId(runId))[0]!.status).toBe("waiting");

      const registry = new ExecutorRegistry();
      registry.register(new EchoExecutor(deps));
      await recoverIncompleteRuns(registry);

      const nodeIds = (await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId);
      expect(nodeIds).toContain("notify-timeout");
      expect(nodeIds).not.toContain("deploy");
      const followUps = await getDbClient().query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE taskType = 'hitl-follow-up' AND task LIKE ?",
        [`%${id}%`],
      );
      expect(followUps).toHaveLength(0);
    });

    test("times out a request on a completed run", async () => {
      const { runId, stepId } = await makeRun("completed");
      const id = await makeRequest({
        ageDays: 0,
        expiresInMs: -60_000,
        workflowRunId: runId,
        workflowRunStepId: stepId,
      });
      await timeoutExpiredApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("timeout");
    });

    test("notifies the agent of an active source task", async () => {
      const sourceTaskId = await makeSourceTask("in_progress");
      const id = await makeRequest({ ageDays: 0, expiresInMs: -60_000, sourceTaskId });

      await timeoutExpiredApprovalRequests();

      const followUps = await followUpsFor(sourceTaskId);
      expect(followUps).toHaveLength(1);
      expect(followUps[0]!.agentId).toBe(agentId);
      expect(followUps[0]!.task).toContain("timed out with no answer");
      expect(followUps[0]!.task).toContain(id);
    });

    test("a failed follow-up insert rolls the timeout back; the next tick retries", async () => {
      const sourceTaskId = await makeSourceTask("in_progress");
      const id = await makeRequest({ ageDays: 0, expiresInMs: -60_000, sourceTaskId });
      await getDbClient().run(
        `CREATE TRIGGER fail_follow_up BEFORE INSERT ON agent_tasks
           WHEN NEW.taskType = 'hitl-follow-up' BEGIN SELECT RAISE(ABORT, 'insert failed'); END`,
      );
      try {
        expect((await timeoutExpiredApprovalRequests()).timedOut).toEqual([]);
        expect((await getApprovalRequestById(id))!.status).toBe("pending");
      } finally {
        await getDbClient().run("DROP TRIGGER fail_follow_up");
      }

      expect((await timeoutExpiredApprovalRequests()).timedOut.map((r) => r.id)).toEqual([id]);
      expect(await followUpsFor(sourceTaskId)).toHaveLength(1);
    });

    for (const status of ["completed", "failed", "cancelled", "superseded"]) {
      test(`does not notify when the source task is ${status}`, async () => {
        const sourceTaskId = await makeSourceTask(status);
        await makeRequest({ ageDays: 0, expiresInMs: -60_000, sourceTaskId });

        await timeoutExpiredApprovalRequests();

        expect(await followUpsFor(sourceTaskId)).toHaveLength(0);
      });
    }

    test("creates no task for a request with no source task", async () => {
      const before = await getDbClient().query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE taskType = 'hitl-follow-up'",
      );
      await makeRequest({ ageDays: 0, expiresInMs: -60_000 });

      await timeoutExpiredApprovalRequests();

      const after = await getDbClient().query<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE taskType = 'hitl-follow-up'",
      );
      expect(after).toHaveLength(before.length);
    });

    test("does not touch an approved request", async () => {
      const id = await makeRequest({ ageDays: 0, expiresInMs: -60_000 });
      await resolveApprovalRequest(id, { status: "approved" });
      await timeoutExpiredApprovalRequests();
      expect((await getApprovalRequestById(id))!.status).toBe("approved");
    });

    test("a second sweep finds nothing", async () => {
      await makeRequest({ ageDays: 0, expiresInMs: -60_000 });
      expect((await timeoutExpiredApprovalRequests()).timedOut).toHaveLength(1);
      expect((await timeoutExpiredApprovalRequests()).timedOut).toHaveLength(0);
    });

    test("posts nothing to Slack", async () => {
      await makeRequest({
        ageDays: 0,
        expiresInMs: -60_000,
        notificationChannels: [{ channel: "slack", target: "C1", messageTs: "111.222" }],
      });
      await timeoutExpiredApprovalRequests();
      expect(postMessage).not.toHaveBeenCalled();
    });
  });
});
