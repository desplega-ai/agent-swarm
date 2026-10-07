import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { recordWorkflowPreflightFailure } from "../be/automation-preflight";
import {
  closeDb,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { scrubJsonValue } from "../be/scrub-json";
import * as scrubber from "../utils/secret-scrubber";
import { checkpointStep, checkpointStepFailure } from "../workflows/checkpoint";
import { type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-workflow-scrub.sqlite";

type RunRow = { triggerData: string | null; context: string | null; error: string | null };
type StepRow = {
  input: string | null;
  output: string | null;
  error: string | null;
  diagnostics: string | null;
  idempotencyKey: string | null;
  nextPort: string | null;
};

let secret: SyntheticSecret;
let workflowId: string;

async function readRun(id: string): Promise<RunRow> {
  const row = await getDbClient().get<RunRow>(
    "SELECT triggerData, context, error FROM workflow_runs WHERE id = ?",
    [id],
  );
  if (!row) throw new Error(`run ${id} not found`);
  return row;
}

async function readStep(id: string): Promise<StepRow> {
  const row = await getDbClient().get<StepRow>(
    "SELECT input, output, error, diagnostics, idempotencyKey, nextPort FROM workflow_run_steps WHERE id = ?",
    [id],
  );
  if (!row) throw new Error(`step ${id} not found`);
  return row;
}

/** Secret gone, a redaction marker present, and the non-secret context kept. */
function expectRedacted(stored: string | null, context: string): void {
  expect(stored).not.toBeNull();
  expect(stored).not.toContain(secret.value);
  expect(stored).toContain(`[REDACTED:${secret.name}]`);
  expect(stored).toContain(context);
}

async function newRun(): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRun({ id, workflowId });
  return id;
}

async function newStep(runId: string, nodeId = "node-a"): Promise<string> {
  const id = crypto.randomUUID();
  await createWorkflowRunStep({ id, runId, nodeId, nodeType: "script" });
  return id;
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  const workflow = await createWorkflow({
    name: `workflow-scrub-${crypto.randomUUID()}`,
    definition: { nodes: [] },
  });
  workflowId = workflow.id;
});

// The test preload clears volatile secrets after every test, so register per test.
beforeEach(() => {
  secret = syntheticSecret("workflow");
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

describe("workflow_runs writers scrub at write", () => {
  test("createWorkflowRun redacts triggerData and keeps valid JSON", async () => {
    const id = crypto.randomUUID();
    await createWorkflowRun({
      id,
      workflowId,
      triggerType: "api",
      triggerData: { source: "webhook-trigger", token: secret.value },
    });
    const row = await readRun(id);
    expectRedacted(row.triggerData, "webhook-trigger");
    expect(JSON.parse(row.triggerData!).source).toBe("webhook-trigger");
  });

  test("updateWorkflowRun redacts error and context; the exact context is sealed", async () => {
    const id = await newRun();
    await updateWorkflowRun(id, {
      status: "failed",
      error: `run exploded with ${secret.value} in the message`,
      context: { input: { apiKey: secret.value, region: "eu-west-1" } },
    });
    const row = await readRun(id);
    expectRedacted(row.error, "run exploded with");
    expectRedacted(row.context, "eu-west-1");
    // Resume rebuilds the live ctx from the sealed copy (workflow-replay.test.ts).
    const sealed = await getDbClient().get<{ context_replay: string }>(
      "SELECT context_replay FROM workflow_runs WHERE id = ?",
      [id],
    );
    expect(sealed?.context_replay?.startsWith("sealed:v1:")).toBe(true);
    expect(sealed?.context_replay).not.toContain(secret.value);
  });

  test("recordWorkflowPreflightFailure redacts triggerData and error, keeps the dedupe prefix", async () => {
    const preflightWorkflow = await createWorkflow({
      name: `workflow-scrub-preflight-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const first = await recordWorkflowPreflightFailure({
      workflowId: preflightWorkflow.id,
      triggerType: "schedule",
      triggerData: { scheduleName: "nightly-sync", header: secret.value },
      failureReason: `needs_setup: slack token ${secret.value} rejected`,
    });
    expect(first.recorded).toBe(true);
    const row = await readRun(first.runId);
    expectRedacted(row.triggerData, "nightly-sync");
    expectRedacted(row.error, "needs_setup: slack token");

    // The `needs_setup:%` dedupe still matches the scrubbed row.
    const second = await recordWorkflowPreflightFailure({
      workflowId: preflightWorkflow.id,
      triggerType: "schedule",
      triggerData: {},
      failureReason: "needs_setup: again",
    });
    expect(second).toEqual({ runId: first.runId, recorded: false });
  });
});

describe("workflow_run_steps writers scrub at write", () => {
  test("createWorkflowRunStep redacts input and keeps the idempotency key byte-exact", async () => {
    const runId = await newRun();
    const id = crypto.randomUUID();
    const idempotencyKey = `${runId}:node-a:0`;
    await createWorkflowRunStep({
      id,
      runId,
      nodeId: "node-a",
      nodeType: "script",
      input: { prompt: "summarize-the-repo", auth: secret.value, index: 3 },
      idempotencyKey,
    });
    const row = await readStep(id);
    expectRedacted(row.input, "summarize-the-repo");
    expect(JSON.parse(row.input!).index).toBe(3);
    expect(row.idempotencyKey).toBe(idempotencyKey);
  });

  test("updateWorkflowRunStep redacts output, error and diagnostics", async () => {
    const runId = await newRun();
    const id = await newStep(runId);
    await updateWorkflowRunStep(id, {
      status: "failed",
      output: { stdout: "deploy-finished", leaked: secret.value },
      error: `step failed: ${secret.value}`,
      diagnostics: `trace line ${secret.value} end`,
      nextPort: "default",
    });
    const row = await readStep(id);
    expectRedacted(row.output, "deploy-finished");
    expect(JSON.parse(row.output!).stdout).toBe("deploy-finished");
    expectRedacted(row.error, "step failed:");
    expectRedacted(row.diagnostics, "trace line");
    expect(row.nextPort).toBe("default");
  });

  test("checkpointStep redacts the persisted step output", async () => {
    const runId = await newRun();
    const id = await newStep(runId, "node-out");
    await checkpointStep(
      runId,
      id,
      "node-out",
      { output: { result: "build-green", token: secret.value }, nextPort: "pass" },
      {},
    );
    const row = await readStep(id);
    expectRedacted(row.output, "build-green");
    expect(row.nextPort).toBe("pass");
  });

  test("checkpointStepFailure redacts the step error and the run error", async () => {
    const runId = await newRun();
    await updateWorkflowRun(runId, { status: "running" });
    const id = await newStep(runId, "node-fail");
    const result = await checkpointStepFailure(runId, id, `upstream 401 for ${secret.value}`, 0);
    expect(result.shouldRetry).toBe(false);
    expectRedacted((await readStep(id)).error, "upstream 401 for");
    expectRedacted((await readRun(runId)).error, "Step failed: upstream 401 for");
  });
});

describe("scrubJsonValue JSON-validity guard", () => {
  test("falls back to per-leaf scrubbing when a whole-string redaction breaks JSON", () => {
    // The real scrubber is JSON-escape aware, so force the failure shape the
    // guard exists for: a whole-string pass that leaves an unbalanced quote.
    const realScrub = scrubber.scrubSecrets;
    const spy = spyOn(scrubber, "scrubSecrets").mockImplementation((text) => {
      const out = realScrub(text);
      return (text?.startsWith("{") ? out.replace("guard-context", '"') : out) as typeof out;
    });
    try {
      const out = scrubJsonValue({ note: "guard-context", key: secret.value });
      const parsed = JSON.parse(out) as { note: string; key: string };
      expect(parsed.note).toBe("guard-context");
      expect(parsed.key).toBe(`[REDACTED:${secret.name}]`);
      expect(out).not.toContain(secret.value);
      // One whole-string call, then one per leaf string.
      expect(spy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });
});
