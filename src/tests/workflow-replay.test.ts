import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { runBootScrubSweep } from "../be/boot-scrub-sweep";
import { __resetEncryptionKeyForTests, encryptSecret, resolveEncryptionKey } from "../be/crypto";
import {
  closeDb,
  createUser,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  deleteUser,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { getExecutorRegistry } from "../workflows";
import { checkpointStep } from "../workflows/checkpoint";
import { walkGraph } from "../workflows/engine";
import { ScriptExecutor } from "../workflows/executors/script";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { retryFailedRun } from "../workflows/resume";
import { type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = `./test-workflow-replay-${crypto.randomUUID()}.sqlite`;

let secret: SyntheticSecret;

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

// The test preload clears volatile secrets after every test, so register per test.
beforeEach(() => {
  secret = syntheticSecret("replay");
});

afterAll(() => {
  secret.cleanup();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

/**
 * `fetch` returns the registered token; `consume` declares it (and a trigger
 * field) as inputs, the way an authenticated request or equality check would.
 */
const definition: WorkflowDefinition = {
  nodes: [
    {
      id: "fetch",
      type: "script",
      config: { runtime: "bash", script: "echo fetch" },
      next: "consume",
    },
    {
      id: "consume",
      type: "script",
      inputs: { token: "fetch.stdout", header: "trigger.header" },
      config: { runtime: "bash", script: "echo consume" },
    },
  ],
};

type Seen = { token: unknown; header: unknown };

/** Mock the script executor: `fetch` emits the token, `consume` records its inputs. */
function mockExecutor(opts: { consumeFailsFirst?: boolean } = {}) {
  const seen: Seen[] = [];
  const calls: string[] = [];
  let consumeFailed = false;
  const spy = spyOn(ScriptExecutor.prototype, "run").mockImplementation(async (input) => {
    calls.push(input.meta.nodeId);
    if (input.meta.nodeId === "fetch") {
      return { status: "success", output: { exitCode: 0, stdout: secret.value, stderr: "" } };
    }
    seen.push({ token: input.context.token, header: input.context.header });
    if (opts.consumeFailsFirst && !consumeFailed) {
      consumeFailed = true;
      return { status: "failed", error: "downstream 503" };
    }
    return { status: "success", output: { exitCode: 0, stdout: "consumed", stderr: "" } };
  });
  return { seen, calls, restore: () => spy.mockRestore() };
}

async function newWorkflow(): Promise<Workflow> {
  return createWorkflow({ name: `workflow-replay-${crypto.randomUUID()}`, definition });
}

async function newRunningRun(workflowId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId, triggerType: "manual" });
  await updateWorkflowRun(runId, { status: "running" });
  return runId;
}

/** Recovery sweeps every live run in the DB; settle the other tests' runs first. */
async function onlyLiveRun(runId: string): Promise<void> {
  await getDbClient().run(
    "UPDATE workflow_runs SET status = 'completed' WHERE status IN ('running', 'waiting') AND id != ?",
    [runId],
  );
}

function triggerCtx(): Record<string, unknown> {
  return { trigger: { header: secret.value } };
}

/**
 * The state a crash leaves after `fetch` checkpointed: its output and the run
 * context written by the engine's own checkpoint writer, and `consume` started
 * but never finished.
 */
async function persistCrashAfterFetch(runId: string): Promise<void> {
  const fetchStep = await createWorkflowRunStep({
    id: crypto.randomUUID(),
    runId,
    nodeId: "fetch",
    nodeType: "script",
    idempotencyKey: `${runId}:fetch:0`,
  });
  await checkpointStep(
    runId,
    fetchStep.id,
    "fetch",
    { output: { exitCode: 0, stdout: secret.value, stderr: "" } },
    { ...triggerCtx(), run: { id: runId } },
  );
  await createWorkflowRunStep({
    id: crypto.randomUUID(),
    runId,
    nodeId: "consume",
    nodeType: "script",
    idempotencyKey: `${runId}:consume:0`,
  });
}

/** What the consumer saw in a run that was never interrupted. */
async function uninterruptedValue(workflow: Workflow): Promise<Seen> {
  const runId = await newRunningRun(workflow.id);
  const mock = mockExecutor();
  try {
    await walkGraph(
      definition,
      runId,
      triggerCtx(),
      [definition.nodes[0]!],
      getExecutorRegistry(),
      workflow.id,
    );
  } finally {
    mock.restore();
  }
  expect((await getWorkflowRun(runId))?.status).toBe("completed");
  expect(mock.seen).toHaveLength(1);
  return mock.seen[0]!;
}

describe("workflow replay columns", () => {
  test("step output and run context: scrubbed column for display, sealed copy for replay", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    await updateWorkflowRun(runId, {
      context: { swarm: { requestedByUserId: "user-filter-check" }, input: { key: secret.value } },
    });
    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId,
      nodeId: "fetch",
      nodeType: "script",
    });
    await updateWorkflowRunStep(step.id, { status: "completed", output: { token: secret.value } });

    const stored = await getDbClient().get<{
      output: string;
      output_replay: string;
      context: string;
      context_replay: string;
    }>(
      `SELECT s.output, s.output_replay, r.context, r.context_replay
         FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.runId WHERE s.id = ?`,
      [step.id],
    );
    for (const text of Object.values(stored!)) expect(text).not.toContain(secret.value);
    expect(stored!.output_replay.startsWith("sealed:v1:")).toBe(true);
    expect(stored!.context_replay.startsWith("sealed:v1:")).toBe(true);

    // Replay (the default view) is byte-exact.
    expect((await getWorkflowRun(runId))?.context?.input).toEqual({ key: secret.value });
    expect((await getWorkflowRunStepsByRunId(runId))[0]?.output).toEqual({ token: secret.value });
    // Display is the scrubbed column.
    const marker = `[REDACTED:${secret.name}]`;
    expect((await getWorkflowRun(runId, "display"))?.context?.input).toEqual({ key: marker });
    expect((await getWorkflowRunStepsByRunId(runId, "display"))[0]?.output).toEqual({
      token: marker,
    });
    // The scrubbed column still serves SQL filters.
    const filtered = await getDbClient().get<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE json_extract(context, '$.swarm.requestedByUserId') = ?",
      ["user-filter-check"],
    );
    expect(filtered?.id).toBe(runId);
  });

  test("rows written before the replay columns fall back to the plain column", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    const stepId = crypto.randomUUID();
    await createWorkflowRunStep({ id: stepId, runId, nodeId: "fetch", nodeType: "script" });
    await getDbClient().run(
      "UPDATE workflow_run_steps SET status = 'completed', output = ?, output_replay = NULL WHERE id = ?",
      [JSON.stringify({ stdout: "legacy-output" }), stepId],
    );
    await getDbClient().run(
      "UPDATE workflow_runs SET context = ?, context_replay = NULL WHERE id = ?",
      [JSON.stringify({ trigger: { header: "legacy-header" } }), runId],
    );
    expect((await getWorkflowRunStepsByRunId(runId))[0]?.output).toEqual({
      stdout: "legacy-output",
    });
    expect((await getWorkflowRun(runId))?.context).toEqual({
      trigger: { header: "legacy-header" },
    });
  });
});

describe("resume and recovery replay the exact value to a downstream consumer", () => {
  test("crash after a checkpoint: recovery feeds the consumer what the uninterrupted run did", async () => {
    const workflow = await newWorkflow();
    const expected = await uninterruptedValue(workflow);
    expect(expected).toEqual({ token: secret.value, header: secret.value });

    const runId = await newRunningRun(workflow.id);
    await persistCrashAfterFetch(runId);
    // The scrubbed copy holds markers: replaying it would change the consumer's input.
    const scrubbed = await getDbClient().get<{ output: string }>(
      "SELECT output FROM workflow_run_steps WHERE runId = ? AND nodeId = 'fetch'",
      [runId],
    );
    expect(scrubbed?.output).toContain(`[REDACTED:${secret.name}]`);

    await onlyLiveRun(runId);
    const mock = mockExecutor();
    try {
      expect(await recoverIncompleteRuns(getExecutorRegistry())).toBe(1);
    } finally {
      mock.restore();
    }
    expect(mock.calls).toEqual(["consume"]);
    expect(mock.seen).toEqual([expected]);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
  });

  test("retry of a failed downstream step feeds it the uninterrupted value", async () => {
    const workflow = await newWorkflow();
    const expected = await uninterruptedValue(workflow);

    const runId = await newRunningRun(workflow.id);
    const mock = mockExecutor({ consumeFailsFirst: true });
    try {
      await walkGraph(
        definition,
        runId,
        triggerCtx(),
        [definition.nodes[0]!],
        getExecutorRegistry(),
        workflow.id,
      );
      expect((await getWorkflowRun(runId))?.status).toBe("failed");
      await retryFailedRun(runId, getExecutorRegistry());
    } finally {
      mock.restore();
    }
    expect(mock.calls).toEqual(["fetch", "consume", "consume"]);
    expect(mock.seen).toEqual([expected, expected]);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
  });
});

describe("an unreadable sealed copy fails the run instead of replaying markers", () => {
  afterEach(() => {
    // Restore the preload key after the missing-key case.
    resolveEncryptionKey(TEST_DB_PATH);
  });

  async function expectFailedClosed(runId: string, target: string): Promise<void> {
    await onlyLiveRun(runId);
    const mock = mockExecutor();
    try {
      await recoverIncompleteRuns(getExecutorRegistry());
    } finally {
      mock.restore();
    }
    expect(mock.calls).toEqual([]);
    const run = await getWorkflowRun(runId, "display");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain(`cannot replay ${target}`);
    expect(run?.error).toContain("The redacted copy is never replayed");
    expect(run?.error).not.toContain(secret.value);
  }

  test("step output sealed under a rotated key", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    await persistCrashAfterFetch(runId);
    const rotated = `sealed:v1:${encryptSecret(JSON.stringify({ stdout: secret.value }), randomBytes(32))}`;
    await getDbClient().run(
      "UPDATE workflow_run_steps SET output_replay = ? WHERE runId = ? AND nodeId = 'fetch'",
      [rotated, runId],
    );
    await expectFailedClosed(runId, "the output of step");
  });

  test("run context sealed under a rotated key", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    await persistCrashAfterFetch(runId);
    const rotated = `sealed:v1:${encryptSecret(JSON.stringify(triggerCtx()), randomBytes(32))}`;
    await getDbClient().run("UPDATE workflow_runs SET context_replay = ? WHERE id = ?", [
      rotated,
      runId,
    ]);
    await expectFailedClosed(runId, "its context");
  });

  test("missing encryption key", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    await persistCrashAfterFetch(runId);
    __resetEncryptionKeyForTests();
    await expectFailedClosed(runId, "its context");
  });
});

describe("writers that rewrite replay state", () => {
  test("deleteUser rewrites the requester in the sealed context too", async () => {
    const workflow = await newWorkflow();
    const user = await createUser({ name: "replay requester" });
    const replacement = await createUser({ name: "replay replacement" });
    const runId = await newRunningRun(workflow.id);
    await updateWorkflowRun(runId, {
      context: { swarm: { requestedByUserId: user.id }, input: { key: secret.value } },
    });
    expect(await deleteUser(user.id, replacement.id)).toBe(true);
    const context = (await getWorkflowRun(runId))?.context;
    expect(context?.swarm).toEqual({ requestedByUserId: replacement.id });
    expect(context?.input).toEqual({ key: secret.value });
  });

  test("the boot sweep seals a legacy row's original before redacting it", async () => {
    const workflow = await newWorkflow();
    const runId = await newRunningRun(workflow.id);
    const stepId = crypto.randomUUID();
    await createWorkflowRunStep({ id: stepId, runId, nodeId: "fetch", nodeType: "script" });
    const legacyOutput = { exitCode: 0, stdout: secret.value, stderr: "" };
    const legacyContext = { trigger: { header: secret.value } };
    await getDbClient().run(
      "UPDATE workflow_run_steps SET status = 'completed', output = ?, output_replay = NULL WHERE id = ?",
      [JSON.stringify(legacyOutput), stepId],
    );
    await getDbClient().run(
      "UPDATE workflow_runs SET context = ?, context_replay = NULL WHERE id = ?",
      [JSON.stringify(legacyContext), runId],
    );

    await runBootScrubSweep({ version: 9_000 + Math.floor(Math.random() * 1_000), reembed: false });

    const stored = await getDbClient().get<{ output: string; context: string }>(
      `SELECT s.output, r.context FROM workflow_run_steps s
         JOIN workflow_runs r ON r.id = s.runId WHERE s.id = ?`,
      [stepId],
    );
    expect(stored?.output).not.toContain(secret.value);
    expect(stored?.context).not.toContain(secret.value);
    expect((await getWorkflowRunStepsByRunId(runId))[0]?.output).toEqual(legacyOutput);
    expect((await getWorkflowRun(runId))?.context).toEqual(legacyContext);
  });
});
