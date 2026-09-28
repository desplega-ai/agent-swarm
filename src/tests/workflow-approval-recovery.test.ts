import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  getApprovalRequestById,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { ExecutorMeta, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { recoverIncompleteRuns } from "../workflows/recovery";

const TEST_DB_PATH = "./test-workflow-approval-recovery.sqlite";

class MockHITLExecutor extends BaseExecutor<
  typeof MockHITLExecutor.schema,
  typeof MockHITLExecutor.outSchema
> {
  static readonly schema = z.object({ title: z.string() });
  static readonly outSchema = z.object({
    requestId: z.string(),
    status: z.string(),
    responses: z.record(z.string(), z.unknown()).nullable(),
  });

  readonly type = "mock-hitl";
  readonly mode = "async" as const;
  readonly configSchema = MockHITLExecutor.schema;
  readonly outputSchema = MockHITLExecutor.outSchema;
  lastRequestId: string | null = null;

  protected async execute(
    config: z.infer<typeof MockHITLExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof MockHITLExecutor.outSchema>>> {
    const requestId = crypto.randomUUID();
    this.lastRequestId = requestId;
    await this.deps.db.createApprovalRequest({
      id: requestId,
      title: config.title,
      questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
      approvers: { policy: "any" as const },
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
    });
    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<z.infer<typeof MockHITLExecutor.outSchema>>;
  }
}

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

const definition: WorkflowDefinition = {
  nodes: [
    {
      id: "review",
      type: "mock-hitl",
      config: { title: "Review" },
      next: { approved: "deploy", rejected: "reject", timeout: "notify-timeout" },
    },
    { id: "deploy", type: "echo", config: { message: "deploying" } },
    { id: "reject", type: "echo", config: { message: "rejected" } },
    { id: "notify-timeout", type: "echo", config: { message: "timed out" } },
  ],
};

let counter = 0;

async function startWaitingRun(registry: ExecutorRegistry) {
  counter++;
  const workflow = await createWorkflow({
    name: `approval-recovery-${counter}-${Date.now()}`,
    definition,
  });
  const runId = await startWorkflowExecution(workflow, {}, registry);
  const requestId = (registry.get("mock-hitl") as MockHITLExecutor).lastRequestId!;
  expect((await getWorkflowRun(runId))!.status).toBe("waiting");
  return { runId, requestId };
}

function makeRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new MockHITLExecutor(deps));
  registry.register(new EchoExecutor(deps));
  return registry;
}

describe("recoverApprovalWaitingRuns", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("a cancelled request never routes its waiting step", async () => {
    const registry = makeRegistry();
    const { runId, requestId } = await startWaitingRun(registry);
    await getDbClient().run(
      "UPDATE approval_requests SET status = 'cancelled', resolutionReason = 'x' WHERE id = ?",
      [requestId],
    );

    await recoverIncompleteRuns(registry);

    expect((await getWorkflowRun(runId))!.status).toBe("waiting");
    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => s.nodeId)).toEqual(["review"]);
    expect(steps[0]!.status).toBe("waiting");
  });

  test("an expired pending request becomes timeout and routes on the timeout port", async () => {
    const registry = makeRegistry();
    const { runId, requestId } = await startWaitingRun(registry);
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    await getDbClient().run("UPDATE approval_requests SET expiresAt = ? WHERE id = ?", [
      expiresAt,
      requestId,
    ]);

    await recoverIncompleteRuns(registry);

    const request = await getApprovalRequestById(requestId);
    expect(request!.status).toBe("timeout");
    expect(request!.resolutionReason).toStartWith("Timed out: no answer before");
    const nodeIds = (await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId);
    expect(nodeIds).toContain("notify-timeout");
    expect(nodeIds).not.toContain("deploy");
  });

  test("a request cancelled after the snapshot never routes its waiting step", async () => {
    const registry = makeRegistry();
    const { runId, requestId } = await startWaitingRun(registry);
    await getDbClient().run("UPDATE approval_requests SET expiresAt = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      requestId,
    ]);

    // The snapshot still reads pending past expiresAt; a cancel then lands
    // before the recovery pass writes timeout.
    const original = db.getStuckApprovalRuns;
    const spy = spyOn(db, "getStuckApprovalRuns").mockImplementation(async () => {
      const rows = await original();
      await db.cancelApprovalRequestById(requestId, { reason: "cancelled", resolvedBy: null });
      return rows;
    });
    try {
      await recoverIncompleteRuns(registry);
    } finally {
      spy.mockRestore();
    }

    expect((await getApprovalRequestById(requestId))!.status).toBe("cancelled");
    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => s.nodeId)).toEqual(["review"]);
    expect(steps[0]!.status).toBe("waiting");
  });
});
