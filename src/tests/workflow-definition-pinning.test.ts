import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createWorkflow,
  deleteWorkflow,
  failTask,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWaitStateByStepId,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  PINNED_WORKFLOW_KEYS,
  pinWorkflowDefinition,
  resolveWaitState,
  toPinnedDefinition,
} from "../be/db";
import { hashPinnedDefinition, mergePinnedDefinition } from "../be/db/workflow-run-definitions";
import {
  type ExecutorMeta,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRunStep,
  type WorkflowSnapshot,
  WorkflowSnapshotSchema,
} from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry, type ExecutorRegistry } from "../workflows/executors/registry";
import {
  recoverResolvedWaitState,
  resumeWaitState,
  retryFailedRun,
  setupWorkflowResumeListener,
} from "../workflows/resume";
import { startRetryPoller, stopRetryPoller } from "../workflows/retry-poller";
import { interpolate } from "../workflows/template";
import { snapshotAndUpdateWorkflow } from "../workflows/version";

// Each test starts a run on definition A (`n1 → a2`), edits the workflow to B
// (`n1 → b2`, with a changed config value) through the real edit path, then
// drives one resume path. The run must finish on A.

const TEST_DB_PATH = "./test-workflow-definition-pinning.sqlite";

type Variant = "A" | "B";

/** Every instant node execution: which run, which node, which config tag. */
const executions: { runId: string; nodeId: string; tag: string }[] = [];

class ProbeExecutor extends BaseExecutor<typeof ProbeExecutor.schema, typeof ProbeExecutor.out> {
  static readonly schema = z.object({ tag: z.string() });
  static readonly out = z.object({ tag: z.string() });
  readonly type = "probe";
  readonly mode = "instant" as const;
  readonly configSchema = ProbeExecutor.schema;
  readonly outputSchema = ProbeExecutor.out;

  protected async execute(
    config: z.infer<typeof ProbeExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof ProbeExecutor.out>>> {
    executions.push({ runId: meta.runId, nodeId: meta.nodeId, tag: config.tag });
    return { status: "success", output: { tag: config.tag } };
  }
}

/** Fails until `gateOpen` is set; records the config tag it ran with. */
let gateOpen = false;
class GateExecutor extends BaseExecutor<typeof GateExecutor.schema, typeof GateExecutor.out> {
  static readonly schema = z.object({ tag: z.string() });
  static readonly out = z.object({ tag: z.string() });
  readonly type = "gate";
  readonly mode = "instant" as const;
  readonly configSchema = GateExecutor.schema;
  readonly outputSchema = GateExecutor.out;

  protected async execute(
    config: z.infer<typeof GateExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof GateExecutor.out>>> {
    executions.push({ runId: meta.runId, nodeId: meta.nodeId, tag: config.tag });
    if (!gateOpen) return { status: "failed", error: "gate closed" };
    return { status: "success", output: { tag: config.tag } };
  }
}

class MockHitlExecutor extends BaseExecutor<
  typeof MockHitlExecutor.schema,
  typeof MockHitlExecutor.out
> {
  static readonly schema = z.object({ title: z.string() });
  static readonly out = z.object({
    requestId: z.string(),
    status: z.string(),
    responses: z.record(z.string(), z.unknown()).nullable(),
  });
  readonly type = "mock-hitl";
  readonly mode = "async" as const;
  readonly configSchema = MockHitlExecutor.schema;
  readonly outputSchema = MockHitlExecutor.out;
  lastRequestId: string | null = null;

  protected async execute(
    config: z.infer<typeof MockHitlExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof MockHitlExecutor.out>>> {
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
    } as unknown as ExecutorResult<z.infer<typeof MockHitlExecutor.out>>;
  }
}

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};

let registry: ExecutorRegistry;
let teardownResumeListener: (() => void) | undefined;
const createdWorkflowIds: string[] = [];
let counter = 0;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  registry = createExecutorRegistry(deps);
  registry.register(new ProbeExecutor(deps));
  registry.register(new GateExecutor(deps));
  registry.register(new MockHitlExecutor(deps));
  teardownResumeListener = setupWorkflowResumeListener(workflowEventBus, registry);
});

afterEach(() => {
  stopRetryPoller();
  gateOpen = false;
});

afterAll(async () => {
  // Detach from the process-wide bus: a leaked listener resumes runs in later files.
  teardownResumeListener?.();
  stopRetryPoller();
  for (const id of createdWorkflowIds) {
    await deleteWorkflow(id).catch(() => {});
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

// ─── Helpers ─────────────────────────────────────────────────

type FirstNode = (variant: Variant, successor: string) => WorkflowNode;

/** `n1 → a2` for A, `n1 → b2` for B; the successor probe carries the variant tag. */
function twoNode(variant: Variant, first: FirstNode, extra: Partial<WorkflowDefinition> = {}) {
  const successor = variant === "A" ? "a2" : "b2";
  return {
    ...extra,
    nodes: [first(variant, successor), { id: successor, type: "probe", config: { tag: variant } }],
  } as WorkflowDefinition;
}

const agentTaskFirst: FirstNode = (variant, successor) => ({
  id: "n1",
  type: "agent-task",
  config: { template: `Work ${variant}` },
  next: successor,
});

async function makeWorkflow(
  definition: WorkflowDefinition,
  extra: Partial<Parameters<typeof createWorkflow>[0]> = {},
): Promise<Workflow> {
  counter++;
  const workflow = await createWorkflow({
    name: `pinning-${counter}-${Date.now()}`,
    definition,
    ...extra,
  });
  createdWorkflowIds.push(workflow.id);
  return workflow;
}

async function editTo(workflowId: string, definition: WorkflowDefinition, extra = {}) {
  const { workflow } = await snapshotAndUpdateWorkflow(workflowId, { definition, ...extra });
  expect(workflow?.definition.nodes.map((n) => n.id)).toEqual(definition.nodes.map((n) => n.id));
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stepFor(runId: string, nodeId: string): Promise<WorkflowRunStep> {
  const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === nodeId);
  if (!step) throw new Error(`no ${nodeId} step in run ${runId}`);
  return step;
}

async function waitForRunStatus(runId: string, status: string) {
  return waitFor(async () => {
    const run = await getWorkflowRun(runId);
    return run?.status === status ? run : null;
  }, `run ${runId} ${status}`);
}

/** The run walked `variant`'s successor with `variant`'s config, and never the other one. */
async function expectFollowed(runId: string, variant: Variant) {
  const [own, other] = variant === "A" ? ["a2", "b2"] : ["b2", "a2"];
  const nodeIds = (await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId);
  expect(nodeIds).toContain(own);
  expect(nodeIds).not.toContain(other);
  const successorTags = executions
    .filter((e) => e.runId === runId && e.nodeId !== "n1")
    .map((e) => `${e.nodeId}:${e.tag}`);
  expect(successorTags).toEqual([`${own}:${variant}`]);
}

/** `workflow_runs.definitionHash` is internal: not on the public `WorkflowRun`. */
async function pinHash(runId: string): Promise<string | null> {
  const row = await getDbClient().get<{ definitionHash: string | null }>(
    "SELECT definitionHash FROM workflow_runs WHERE id = ?",
    [runId],
  );
  return row?.definitionHash ?? null;
}

async function startOnA(workflow: Workflow): Promise<string> {
  const runId = await startWorkflowExecution(workflow, {}, registry);
  expect(await pinHash(runId)).toBeTruthy();
  return runId;
}

async function completeN1Task(runId: string, output = "done") {
  const task = await getTaskByWorkflowRunStepId((await stepFor(runId, "n1")).id);
  expect(task).toBeTruthy();
  await completeTask(task!.id, output);
}

// ─── Resume paths ────────────────────────────────────────────

describe("a run finishes on the definition it started with", () => {
  test("task completion resumes on A after an edit to B", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const runId = await startOnA(workflow);
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await editTo(workflow.id, twoNode("B", agentTaskFirst));
    await completeN1Task(runId);

    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "A");
  });

  test("task failure follows A's onNodeFailure, not B's", async () => {
    const workflow = await makeWorkflow(
      twoNode("A", agentTaskFirst, { onNodeFailure: "continue" }),
    );
    const runId = await startOnA(workflow);

    await editTo(workflow.id, twoNode("B", agentTaskFirst, { onNodeFailure: "fail" }));
    const task = await getTaskByWorkflowRunStepId((await stepFor(runId, "n1")).id);
    await failTask(task!.id, "agent crashed");

    // B would fail the run; A continues past the failed node to a2.
    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "A");
  });

  test("manual retry re-executes A's failed node and successor", async () => {
    const gateFirst: FirstNode = (variant, successor) => ({
      id: "n1",
      type: "gate",
      config: { tag: variant },
      next: successor,
    });
    const workflow = await makeWorkflow(twoNode("A", gateFirst));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("failed");

    await editTo(workflow.id, twoNode("B", gateFirst));
    gateOpen = true;
    await retryFailedRun(runId, registry);

    await waitForRunStatus(runId, "completed");
    expect(
      executions.filter((e) => e.runId === runId && e.nodeId === "n1").map((e) => e.tag),
    ).toEqual(["A", "A"]);
    await expectFollowed(runId, "A");
  });

  test("the retry poller re-executes A's node config", async () => {
    const retry = { maxRetries: 1, strategy: "static" as const, baseDelayMs: 0, maxDelayMs: 0 };
    const gateFirst: FirstNode = (variant, successor) => ({
      id: "n1",
      type: "gate",
      config: { tag: variant },
      retry,
      next: successor,
    });
    const workflow = await makeWorkflow(twoNode("A", gateFirst));
    const runId = await startWorkflowExecution(workflow, {}, registry);
    const queued = await stepFor(runId, "n1");
    expect(queued.status).toBe("failed");
    expect(queued.nextRetryAt).toBeTruthy();

    await editTo(workflow.id, twoNode("B", gateFirst));
    gateOpen = true;
    startRetryPoller(registry, 10);

    await waitForRunStatus(runId, "completed");
    stopRetryPoller();
    expect(
      executions.filter((e) => e.runId === runId && e.nodeId === "n1").map((e) => e.tag),
    ).toEqual(["A", "A"]);
    await expectFollowed(runId, "A");
  });

  test("approval resolution routes on A's ports", async () => {
    const hitlFirst: FirstNode = (variant, successor) => ({
      id: "n1",
      type: "mock-hitl",
      config: { title: `Review ${variant}` },
      next: { approved: successor },
    });
    const workflow = await makeWorkflow(twoNode("A", hitlFirst));
    const runId = await startOnA(workflow);
    const requestId = (registry.get("mock-hitl") as MockHitlExecutor).lastRequestId!;

    await editTo(workflow.id, twoNode("B", hitlFirst));
    workflowEventBus.emit("approval.resolved", {
      requestId,
      status: "approved",
      responses: { q1: true },
      workflowRunId: runId,
      workflowRunStepId: (await stepFor(runId, "n1")).id,
    });

    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "A");
  });

  const waitFirst: FirstNode = (_variant, successor) => ({
    id: "n1",
    type: "wait",
    config: { mode: "time", durationMs: 10 },
    next: { default: successor },
  });

  test("a claimed wait (resumeWaitState) continues on A", async () => {
    const workflow = await makeWorkflow(twoNode("A", waitFirst));
    const runId = await startOnA(workflow);
    const wait = await getWaitStateByStepId((await stepFor(runId, "n1")).id);
    expect(wait?.status).toBe("pending");

    await editTo(workflow.id, twoNode("B", waitFirst));
    await resumeWaitState(wait!.id, "fired", undefined, registry);

    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "A");
  });

  test("a resolved wait recovered after a crash (recoverResolvedWaitState) continues on A", async () => {
    const workflow = await makeWorkflow(twoNode("A", waitFirst));
    const runId = await startOnA(workflow);
    const wait = await getWaitStateByStepId((await stepFor(runId, "n1")).id);
    // The wait resolved, then the process died before the step checkpoint.
    expect((await resolveWaitState(wait!.id, { status: "fired" })).updated).toBe(true);
    expect((await stepFor(runId, "n1")).status).toBe("waiting");

    await editTo(workflow.id, twoNode("B", waitFirst));
    await recoverResolvedWaitState(wait!.id, registry);

    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "A");
  });

  test("a later agent-task step inherits A's workflow dir, not one B adds", async () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "n1", type: "agent-task", config: { template: "first" }, next: "n2" },
        { id: "n2", type: "agent-task", config: { template: "second" } },
      ],
    };
    const workflow = await makeWorkflow(definition);
    const runId = await startOnA(workflow);

    await editTo(workflow.id, definition, { dir: "/b" });
    expect((await getWorkflow(workflow.id))?.dir).toBe("/b");
    await completeN1Task(runId);

    const n2Task = await waitFor(async () => {
      const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "n2");
      return step ? getTaskByWorkflowRunStepId(step.id) : null;
    }, "n2 task");
    expect(n2Task.dir).toBeUndefined();
  });
});

// ─── New runs, legacy runs, no restart ───────────────────────

describe("which definition a run uses", () => {
  test("a run started after the edit uses B", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const runA = await startOnA(workflow);
    await editTo(workflow.id, twoNode("B", agentTaskFirst));

    const runB = await startWorkflowExecution((await getWorkflow(workflow.id))!, {}, registry);
    expect(await pinHash(runB)).not.toBe(await pinHash(runA));
    await completeN1Task(runB);

    await waitForRunStatus(runB, "completed");
    await expectFollowed(runB, "B");
  });

  test("a run with no pin (created before migration 282) follows the live row", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const runId = await startOnA(workflow);
    await getDbClient().run("UPDATE workflow_runs SET definitionHash = NULL WHERE id = ?", [runId]);

    await editTo(workflow.id, twoNode("B", agentTaskFirst));
    await completeN1Task(runId);

    await waitForRunStatus(runId, "completed");
    await expectFollowed(runId, "B");
  });

  test("no restart: an old run resumes on A while a new run in the same process uses B", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const run1 = await startOnA(workflow);
    await editTo(workflow.id, twoNode("B", agentTaskFirst));
    const run2 = await startWorkflowExecution((await getWorkflow(workflow.id))!, {}, registry);
    expect((await getWorkflowRun(run2))?.status).toBe("waiting");

    await completeN1Task(run1);
    await completeN1Task(run2);

    await waitForRunStatus(run1, "completed");
    await waitForRunStatus(run2, "completed");
    await expectFollowed(run1, "A");
    await expectFollowed(run2, "B");
  });
});

// ─── Pin storage ─────────────────────────────────────────────

describe("pinned definition storage", () => {
  test("PINNED_WORKFLOW_KEYS plus enabled is exactly WorkflowSnapshot", () => {
    type Pinned = (typeof PINNED_WORKFLOW_KEYS)[number];
    type Unclassified = Exclude<keyof WorkflowSnapshot, Pinned | "enabled">;
    type Unknown = Exclude<Pinned | "enabled", keyof WorkflowSnapshot>;
    const unclassified: [Unclassified] extends [never] ? true : false = true;
    const unknown: [Unknown] extends [never] ? true : false = true;
    expect(unclassified && unknown).toBe(true);

    expect([...PINNED_WORKFLOW_KEYS, "enabled"].sort()).toEqual(
      Object.keys(WorkflowSnapshotSchema.shape).sort(),
    );
  });

  test("merge takes every pinned key from the pin, so a dir the edit added does not leak", async () => {
    const definition = twoNode("A", agentTaskFirst);
    const pinnedFrom = await makeWorkflow(definition);
    const live: Workflow = {
      ...pinnedFrom,
      definition: twoNode("B", agentTaskFirst),
      dir: "/b",
      enabled: false,
      createdByAgentId: "live-agent",
    };

    const merged = mergePinnedDefinition(live, toPinnedDefinition(pinnedFrom));

    expect(merged.dir).toBeUndefined();
    expect(merged.definition).toEqual(definition);
    expect(merged.enabled).toBe(false);
    expect(merged.createdByAgentId).toBe("live-agent");
    expect(merged.id).toBe(pinnedFrom.id);
  });

  test("the hash ignores key order and absent-vs-undefined fields", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const pinned = toPinnedDefinition(workflow);
    const reversed = Object.fromEntries(
      Object.entries({ ...pinned, dir: undefined }).reverse(),
    ) as typeof pinned;
    reversed.definition = Object.fromEntries(
      Object.entries(pinned.definition).reverse(),
    ) as WorkflowDefinition;

    expect(hashPinnedDefinition(reversed).hash).toBe(hashPinnedDefinition(pinned).hash);
  });

  test("toggling enabled mints no new definition row", async () => {
    const workflow = await makeWorkflow(twoNode("A", agentTaskFirst));
    const before = await pinWorkflowDefinition(workflow);
    const rowsBefore = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_run_definitions",
    );

    await snapshotAndUpdateWorkflow(workflow.id, { enabled: false });
    const after = await pinWorkflowDefinition((await getWorkflow(workflow.id))!);
    const rowsAfter = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_run_definitions",
    );

    expect(after).toBe(before);
    expect(rowsAfter?.n).toBe(rowsBefore?.n);
  });

  test("deleteWorkflow drops only the definition rows no remaining run references", async () => {
    const wf1 = await makeWorkflow(twoNode("A", agentTaskFirst));
    const wf2 = await makeWorkflow(twoNode("A", agentTaskFirst));
    const run1 = await startOnA(wf1);
    const run2 = await startOnA(wf2);
    const run3 = await startOnA(wf2);
    const h1 = (await pinHash(run1))!;
    const h2 = (await pinHash(run2))!;
    expect(h1).not.toBe(h2);
    // A wf2 run shares wf1's snapshot row, as identical content does.
    await getDbClient().run("UPDATE workflow_runs SET definitionHash = ? WHERE id = ?", [h1, run3]);
    const exists = async (hash: string) =>
      (await getDbClient().get("SELECT 1 FROM workflow_run_definitions WHERE hash = ?", [hash])) !=
      null;

    await deleteWorkflow(wf1.id);
    expect(await exists(h1)).toBe(true);
    expect(await exists(h2)).toBe(true);

    await deleteWorkflow(wf2.id);
    expect(await exists(h1)).toBe(false);
    expect(await exists(h2)).toBe(false);
  });
});
