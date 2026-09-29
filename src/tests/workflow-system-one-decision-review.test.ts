import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getApprovalRequestByStepId,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  resolveApprovalRequest,
  updateWorkflowRunStep,
} from "../be/db";
import type { ApprovalRequest, WorkflowDefinition, WorkflowNode } from "../types";
import { shapeApprovalResolution } from "../workflows/approval-resolution";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import {
  answerConfidence,
  resolveReviewedDecision,
  SystemOneDecisionConfigSchema,
  SystemOneDecisionExecutor,
  SystemOneDecisionOutputSchema,
  systemOneStaticShapeViolations,
  validateSystemOneResponse,
} from "../workflows/executors/system-one-decision";
import { SYSTEM_ONE_PROVIDERS } from "../workflows/executors/system-one-providers";
import { recoverIncompleteRuns } from "../workflows/recovery";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-system-one-decision-review.sqlite";
const API_KEY = "tsk_example-review-test-key.0123456789";

// ─── Harness ────────────────────────────────────────────────

let deps: ExecutorDependencies;
let agentId: string;
const bus = new InProcessEventBus();
let stopListening: (() => void) | undefined;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

class MarkerExecutor extends BaseExecutor<
  typeof MarkerExecutor.schema,
  typeof MarkerExecutor.outSchema
> {
  static readonly schema = z.object({ label: z.string() });
  static readonly outSchema = z.object({ label: z.string() });
  readonly type = "marker";
  readonly mode = "instant" as const;
  readonly configSchema = MarkerExecutor.schema;
  readonly outputSchema = MarkerExecutor.outSchema;
  protected async execute(
    config: z.infer<typeof MarkerExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof MarkerExecutor.outSchema>>> {
    return { status: "success", output: { label: config.label } };
  }
}

const noulAnswer = { type: "noul", noul: 0.82 };
const choiceAnswer = {
  type: "choice",
  choice: "buyer",
  confidence: 0.75,
  probabilities: { buyer: 0.9, champion: 0.07, unknown: 0.03 },
};
const scoreAnswer = {
  type: "score",
  score: 1.7,
  confidence: 0.65,
  legend: { "0": "No timeline", "1": "This quarter", "2": "Blocked now" },
  probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 },
};

function mixedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    state: { lead: { name: "Ada", message: "We are blocked on agent workflow tooling now" } },
    questions: {
      fit: {
        type: "noul",
        instructions: "Is this a real engineering team seeking agent workflow automation?",
      },
      authority: {
        type: "choice",
        instructions: "What purchasing authority is supported by this lead's message?",
        criteria: {
          buyer: "Can approve the purchase",
          champion: "Influences the decision",
          unknown: "The message does not establish authority",
        },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is the stated need?",
        criteria: ["No timeline", "This quarter", "Blocked now"],
      },
    },
    returns: {
      fit: { type: "noul" },
      authority: { type: "choice" },
      urgency: { type: "score" },
    },
    ...overrides,
  };
}

function mixedBody(answers: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: { fit: noulAnswer, authority: choiceAnswer, urgency: scoreAnswer, ...answers },
    usage: { input_tokens: 400, output_tokens: 80 },
  };
}

const APPROVERS = { users: ["reviewer@example.com"], policy: "any" as const };
/** authority (0.75) and urgency (0.65) are in this band; fit (0.82) is not. */
const REVIEW = { band: { min: 0.5, max: 0.8 }, approvers: APPROVERS };

const PORTS = { approved: "accepted", rejected: "declined", timeout: "timed-out" };

function reviewedDefinition(
  humanReview: Record<string, unknown> = REVIEW,
  next: WorkflowNode["next"] = PORTS,
): WorkflowDefinition {
  const marker = (id: string): WorkflowNode => ({
    id,
    type: "marker",
    inputs: { decision: "decide" },
    config: { label: `${id}:{{decision.answers.authority.choice}}` },
  });
  // Only the successors `next` names, or the rest would be unreachable entry nodes.
  const targets = [
    ...new Set(typeof next === "string" ? [next] : Object.values(next ?? {}).flat()),
  ];
  return {
    nodes: [
      { id: "decide", type: "system-one-decision", config: mixedConfig({ humanReview }), next },
      ...targets.map(marker),
    ],
  };
}

function makeRegistry(body: unknown = mixedBody()) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const executor = new SystemOneDecisionExecutor(deps, {
    fetch: fetcher,
    getApiKey: async () => API_KEY,
  });
  const registry = new ExecutorRegistry();
  registry.register(executor);
  registry.register(new MarkerExecutor(deps));
  return { registry, executor, calls: () => calls };
}

async function startRun(
  definition: WorkflowDefinition,
  registry: ExecutorRegistry,
  listen = true,
): Promise<string> {
  if (listen) {
    stopListening?.();
    stopListening = setupWorkflowResumeListener(bus, registry);
  }
  const workflow = await createWorkflow({
    name: `sod-review-${crypto.randomUUID()}`,
    definition,
    createdByAgentId: agentId,
  });
  return startWorkflowExecution(workflow, {}, registry);
}

async function stepOf(runId: string, nodeId: string) {
  const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === nodeId);
  if (!step) throw new Error(`no step for ${nodeId}`);
  return step;
}

async function approvalOf(runId: string, nodeId = "decide"): Promise<ApprovalRequest> {
  const approval = await getApprovalRequestByStepId((await stepOf(runId, nodeId)).id);
  if (!approval) throw new Error("no approval request raised");
  return approval;
}

/** Answer the request the way the HTTP route does, then tell the resume listener. */
async function respond(
  runId: string,
  status: "approved" | "rejected" | "timeout",
  responses: Record<string, unknown> | null = null,
  { emit = true }: { emit?: boolean } = {},
): Promise<void> {
  const approval = await approvalOf(runId);
  const updated = await resolveApprovalRequest(
    approval.id,
    { status, responses, resolvedBy: "reviewer@example.com" },
    { requireActionableWorkflow: true },
  );
  if (!updated) throw new Error("approval could not be resolved");
  if (emit) {
    bus.emit("approval.resolved", {
      requestId: updated.id,
      status: updated.status,
      responses: updated.responses,
      workflowRunId: updated.workflowRunId,
      workflowRunStepId: updated.workflowRunStepId,
    });
  }
}

async function settle(runId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const run = await getWorkflowRun(runId);
    if (run && run.status !== "waiting" && run.status !== "running") return run.status;
    await Bun.sleep(25);
  }
  throw new Error("run did not settle");
}

type Output = z.infer<typeof SystemOneDecisionOutputSchema>;

async function decideOutput(runId: string): Promise<Output> {
  return SystemOneDecisionOutputSchema.parse((await stepOf(runId, "decide")).output);
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const agent = await createAgent({ name: "review-test-agent", isLead: true, status: "idle" });
  agentId = agent.id;
  const db = await import("../be/db");
  deps = {
    db,
    eventBus: new InProcessEventBus(),
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
});

afterAll(async () => {
  stopListening?.();
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  stopListening?.();
  stopListening = undefined;
  const client = getDbClient();
  await client.run("DELETE FROM approval_requests");
  await client.run("DELETE FROM workflow_run_steps");
  await client.run("DELETE FROM workflow_runs");
  await client.run("DELETE FROM workflows");
});

// ─── Authoring ──────────────────────────────────────────────

describe("humanReview authoring", () => {
  const registry = () => makeRegistry().registry;

  test("a valid band with approvers is accepted, and the field is optional", () => {
    expect(validateDefinition(reviewedDefinition(), registry()).errors).toEqual([]);
    const plain = reviewedDefinition();
    plain.nodes[0].config = mixedConfig();
    plain.nodes[0].next = "accepted";
    plain.nodes = plain.nodes.slice(0, 2);
    expect(validateDefinition(plain, registry()).errors).toEqual([]);
  });

  test("an inverted band is rejected", () => {
    const { errors } = validateDefinition(
      reviewedDefinition({ band: { min: 0.9, max: 0.4 }, approvers: APPROVERS }),
      registry(),
    );
    expect(errors.join("\n")).toContain("band.min must not exceed band.max");
  });

  test("a band outside 0..1, a missing edge, and an unknown key are rejected", () => {
    for (const humanReview of [
      { band: { min: -0.1, max: 0.5 }, approvers: APPROVERS },
      { band: { min: 0.2, max: 1.5 }, approvers: APPROVERS },
      { band: { min: 0.2 }, approvers: APPROVERS },
      { band: { min: 0.2, max: 0.5, step: 1 }, approvers: APPROVERS },
      { band: { min: 0.2, max: 0.5 } },
      { ...REVIEW, threshold: 0.5 },
    ]) {
      const { errors } = validateDefinition(reviewedDefinition(humanReview), registry());
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toContain("humanReview");
    }
  });

  test("a bad timeout is rejected by the same schema human-in-the-loop uses", () => {
    const { errors } = validateDefinition(
      reviewedDefinition({ ...REVIEW, timeout: { seconds: 0, action: "reject" } }),
      registry(),
    );
    expect(errors.join("\n")).toContain("humanReview.timeout.seconds");
  });

  test("next must map ports so a rejection cannot run the accepted path", () => {
    for (const next of ["accepted", ["accepted", "declined"]] as WorkflowNode["next"][]) {
      const { errors } = validateDefinition(reviewedDefinition(REVIEW, next), registry());
      expect(errors.join("\n")).toContain("sets humanReview, so next must map output ports");
    }
    const noApproved = validateDefinition(
      reviewedDefinition(REVIEW, { rejected: "declined" }),
      registry(),
    );
    expect(noApproved.errors.join("\n")).toContain('must define the "approved" port');
    const stray = validateDefinition(
      reviewedDefinition(REVIEW, { approved: "accepted", pass: "declined" }),
      registry(),
    );
    expect(stray.errors.join("\n")).toContain('got "pass"');
  });

  test("approved alone, all three ports, and no next at all are valid", () => {
    for (const next of [
      { approved: "accepted" },
      { approved: "accepted", rejected: "declined" },
      PORTS,
    ]) {
      expect(validateDefinition(reviewedDefinition(REVIEW, next), registry()).errors).toEqual([]);
    }
    expect(
      systemOneStaticShapeViolations({
        id: "decide",
        type: "system-one-decision",
        config: mixedConfig({ humanReview: REVIEW }),
      }),
    ).toEqual([]);
  });

  test("a node without humanReview may still use a list next", () => {
    expect(
      systemOneStaticShapeViolations({
        id: "decide",
        type: "system-one-decision",
        config: mixedConfig(),
        next: ["a", "b"],
      }),
    ).toEqual([]);
  });
});

// ─── Confidence ─────────────────────────────────────────────

describe("answerConfidence", () => {
  test("choice and score use the confidence the provider reported", () => {
    expect(answerConfidence(choiceAnswer as never)).toBe(0.75);
    expect(answerConfidence(scoreAnswer as never)).toBe(0.65);
  });

  test("noul is the probability of the side the model took, and the output gains no field", () => {
    expect(answerConfidence({ type: "noul", noul: 0.9 })).toBe(0.9);
    expect(answerConfidence({ type: "noul", noul: 0.1 })).toBe(0.9);
    expect(answerConfidence({ type: "noul", noul: 0.5 })).toBe(0.5);
    // 1 - 0.35 is 0.6499999999999999 in floating point; it must still count as 0.65.
    expect(answerConfidence({ type: "noul", noul: 0.35 })).toBe(0.65);
  });
});

// ─── Run behaviour ──────────────────────────────────────────

describe("in the band: the run parks", () => {
  test("waits for a person, with a card built for the answers that need one", async () => {
    const { registry, calls } = makeRegistry();
    const runId = await startRun(
      reviewedDefinition({
        ...REVIEW,
        title: "Check the lead",
        timeout: { seconds: 3600, action: "reject" },
        notifications: [{ channel: "slack", target: "C123" }],
      }),
      registry,
    );

    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.map((s) => [s.nodeId, s.status])).toEqual([["decide", "waiting"]]);
    expect(calls()).toBe(1);

    const approval = await approvalOf(runId);
    expect(approval.status).toBe("pending");
    expect(approval.title).toBe("Check the lead");
    expect(approval.approvers).toEqual(APPROVERS);
    expect(approval.timeoutSeconds).toBe(3600);
    expect(approval.notificationChannels).toEqual([{ channel: "slack", target: "C123" }]);
    expect(approval.workflowRunId).toBe(runId);
    expect(approval.workflowRunStepId).toBe(steps[0]?.id);

    // Only the answers in the band are asked; `fit` (0.82) is not.
    const questions = approval.questions as Array<Record<string, unknown>>;
    expect(questions.map((q) => q.id)).toEqual(["$confirm", "authority", "urgency"]);
    const [confirm, authority, urgency] = questions;
    expect(confirm).toMatchObject({ type: "approval", required: true });
    expect(String(confirm?.description)).toContain("Ada");
    expect(authority).toMatchObject({ type: "single-select", required: false });
    expect((authority?.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      "buyer",
      "champion",
      "unknown",
    ]);
    expect(String(authority?.description)).toContain('"buyer" at confidence 0.75');
    expect((urgency?.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      "0",
      "1",
      "2",
    ]);
  });

  test("the model's answer is stored on the waiting step, marked pending", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry);
    const parked = await decideOutput(runId);
    expect(parked.review?.status).toBe("pending");
    expect(parked.answers.authority).toMatchObject({ choice: "buyer" });
    expect(parked.review?.questions).toEqual({
      fit: { confidence: 0.82, inBand: false, decidedBy: "model" },
      authority: { confidence: 0.75, inBand: true, decidedBy: "model" },
      urgency: { confidence: 0.65, inBand: true, decidedBy: "model" },
    });
  });

  test("one answer in the band is enough, and the card asks only about it", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(
      reviewedDefinition({ band: { min: 0.7, max: 0.8 }, approvers: APPROVERS }),
      registry,
    );
    const questions = (await approvalOf(runId)).questions as Array<{ id: string }>;
    expect(questions.map((q) => q.id)).toEqual(["$confirm", "authority"]);
  });

  test("both ends of the band count as inside it", async () => {
    for (const band of [
      { min: 0.75, max: 0.9 },
      { min: 0.5, max: 0.75 },
    ]) {
      const { registry } = makeRegistry(
        mixedBody({ urgency: { ...scoreAnswer, confidence: 0.1 } }),
      );
      const runId = await startRun(reviewedDefinition({ band, approvers: APPROVERS }), registry);
      expect((await getWorkflowRun(runId))?.status).toBe("waiting");
      expect(
        ((await approvalOf(runId)).questions as Array<{ id: string }>).map((q) => q.id),
      ).toContain("authority");
    }
  });

  test("a noul answer in the band gets a switch that starts on the model's side", async () => {
    const { registry } = makeRegistry(mixedBody({ fit: { type: "noul", noul: 0.4 } }));
    const runId = await startRun(
      reviewedDefinition({ band: { min: 0.55, max: 0.65 }, approvers: APPROVERS }),
      registry,
    );
    const questions = (await approvalOf(runId)).questions as Array<Record<string, unknown>>;
    const fit = questions.find((q) => q.id === "fit");
    expect(fit).toMatchObject({ type: "boolean", required: false, defaultValue: false });
  });
});

describe("outside the band: the answer passes straight through", () => {
  test("no approval request, and the node leaves through approved", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(
      reviewedDefinition({ band: { min: 0.1, max: 0.2 }, approvers: APPROVERS }),
      registry,
    );
    expect(await settle(runId)).toBe("completed");
    expect((await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId).sort()).toEqual([
      "accepted",
      "decide",
    ]);
    const done = await decideOutput(runId);
    expect(done.review).toEqual({
      status: "not_required",
      questions: {
        fit: { confidence: 0.82, inBand: false, decidedBy: "model" },
        authority: { confidence: 0.75, inBand: false, decidedBy: "model" },
        urgency: { confidence: 0.65, inBand: false, decidedBy: "model" },
      },
    });
    expect(done.answers.authority).toMatchObject({ choice: "buyer" });
    const client = getDbClient();
    expect(
      (await client.get<{ n: number }>("SELECT COUNT(*) AS n FROM approval_requests"))?.n,
    ).toBe(0);
  });

  test("without humanReview nothing changes: no review block, no port", async () => {
    const { registry } = makeRegistry();
    const definition = reviewedDefinition();
    definition.nodes[0].config = mixedConfig();
    definition.nodes[0].next = "accepted";
    definition.nodes = definition.nodes.slice(0, 2);
    const runId = await startRun(definition, registry);
    expect(await settle(runId)).toBe("completed");
    const done = await decideOutput(runId);
    expect(done.review).toBeUndefined();
    expect((await stepOf(runId, "decide")).nextPort ?? null).toBeNull();
  });
});

describe("approve", () => {
  test("confirming as is: the answers stay, and they are marked human-decided", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry);
    const approval = await approvalOf(runId);

    await respond(runId, "approved", { $confirm: { approved: true } });
    expect(await settle(runId)).toBe("completed");

    const done = await decideOutput(runId);
    expect(done.review).toMatchObject({ status: "approved", approvalRequestId: approval.id });
    expect(done.answers).toEqual(mixedBody().answers);
    expect(done.review?.questions).toEqual({
      fit: { confidence: 0.82, inBand: false, decidedBy: "model" },
      authority: { confidence: 0.75, inBand: true, decidedBy: "human", modelAnswer: "buyer" },
      urgency: { confidence: 0.65, inBand: true, decidedBy: "human", modelAnswer: 1.7 },
    });
    // The accepted branch ran, and it read the final answer through the alias.
    expect((await stepOf(runId, "accepted")).output).toEqual({ label: "accepted:buyer" });
    expect((await stepOf(runId, "decide")).nextPort).toBe("approved");
  });

  test("a person's answers become the node output, the model's numbers stay the model's", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry);

    await respond(runId, "approved", {
      $confirm: { approved: true },
      authority: "champion",
      urgency: "2",
    });
    expect(await settle(runId)).toBe("completed");

    const done = await decideOutput(runId);
    expect(done.answers.authority).toEqual({
      ...choiceAnswer,
      choice: "champion",
    });
    expect(done.answers.urgency).toEqual({ ...scoreAnswer, score: 2 });
    // The answer outside the band is untouched.
    expect(done.answers.fit).toEqual(noulAnswer);
    expect(done.review?.questions.authority).toMatchObject({
      decidedBy: "human",
      modelAnswer: "buyer",
    });
    expect(done.review?.questions.fit?.decidedBy).toBe("model");
    expect((await stepOf(runId, "accepted")).output).toEqual({ label: "accepted:champion" });
  });

  test("a replaced yes/no becomes certain, a confirmed one keeps the model's probability", async () => {
    const { registry } = makeRegistry(mixedBody({ fit: { type: "noul", noul: 0.6 } }));
    const definition = reviewedDefinition({ band: { min: 0.55, max: 0.65 }, approvers: APPROVERS });
    const flipped = await startRun(definition, registry);
    await respond(flipped, "approved", { $confirm: { approved: true }, fit: false });
    expect(await settle(flipped)).toBe("completed");
    expect((await decideOutput(flipped)).answers.fit).toEqual({ type: "noul", noul: 0 });

    const kept = await startRun(definition, registry);
    await respond(kept, "approved", { $confirm: { approved: true }, fit: true });
    expect(await settle(kept)).toBe("completed");
    const keptOutput = await decideOutput(kept);
    expect(keptOutput.answers.fit).toEqual({ type: "noul", noul: 0.6 });
    expect(keptOutput.review?.questions.fit).toMatchObject({
      decidedBy: "human",
      modelAnswer: 0.6,
    });
  });
});

describe("reject and timeout", () => {
  test("a rejection leaves through rejected with the model's answers untouched", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry);
    const approval = await approvalOf(runId);

    await respond(runId, "rejected", { $confirm: { approved: false }, authority: "unknown" });
    expect(await settle(runId)).toBe("completed");

    const done = await decideOutput(runId);
    expect(done.review).toMatchObject({ status: "rejected", approvalRequestId: approval.id });
    // Nobody accepted an answer, so even a selection made on a rejected card is ignored.
    expect(done.answers).toEqual(mixedBody().answers);
    expect(Object.values(done.review?.questions ?? {}).every((q) => q.decidedBy === "model")).toBe(
      true,
    );
    expect((await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId).sort()).toEqual([
      "decide",
      "declined",
    ]);
    expect((await stepOf(runId, "decide")).nextPort).toBe("rejected");
  });

  test("no answer in time leaves through timeout", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(
      reviewedDefinition({ ...REVIEW, timeout: { seconds: 60, action: "reject" } }),
      registry,
    );
    await respond(runId, "timeout");
    expect(await settle(runId)).toBe("completed");
    const done = await decideOutput(runId);
    expect(done.review?.status).toBe("timeout");
    expect(done.answers).toEqual(mixedBody().answers);
    expect((await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId).sort()).toEqual([
      "decide",
      "timed-out",
    ]);
  });

  test("a port that `next` does not map ends the branch instead of running another", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(REVIEW, { approved: "accepted" }), registry);
    await respond(runId, "rejected", { $confirm: { approved: false } });
    expect(await settle(runId)).toBe("completed");
    expect((await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId)).toEqual(["decide"]);
  });
});

describe("recovery and re-execution", () => {
  test("an answer that landed while the API was down is applied the same way", async () => {
    const { registry } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry);
    // Resolved in the database, but the resume event never reached the listener.
    await respond(
      runId,
      "approved",
      { $confirm: { approved: true }, authority: "champion" },
      { emit: false },
    );
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");

    await recoverIncompleteRuns(registry);
    expect(await settle(runId)).toBe("completed");
    const done = await decideOutput(runId);
    expect(done.review?.status).toBe("approved");
    expect(done.answers.authority).toMatchObject({ choice: "champion" });
    expect((await stepOf(runId, "accepted")).output).toEqual({ label: "accepted:champion" });
  });

  test("running the step again reuses the parked decision: no second paid call, no second card", async () => {
    const { registry, executor, calls } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry, false);
    const step = await stepOf(runId, "decide");
    const approval = await approvalOf(runId);
    const rerun = () =>
      executor.run({
        config: mixedConfig({ humanReview: REVIEW }),
        context: {},
        meta: {
          runId,
          stepId: step.id,
          nodeId: "decide",
          workflowId: "wf",
          dryRun: false,
        },
      });

    const again = await rerun();
    expect(again).toMatchObject({ status: "success", async: true, correlationId: approval.id });
    expect(calls()).toBe(1);
    expect(
      (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM approval_requests"))?.n,
    ).toBe(1);

    // Answered while the step was between attempts: the re-run finishes it.
    await respond(runId, "approved", { $confirm: { approved: true } }, { emit: false });
    const answered = await rerun();
    expect(answered.status).toBe("success");
    expect(answered.nextPort).toBe("approved");
    expect((answered.output as Output).review?.status).toBe("approved");
    expect(calls()).toBe(1);
  });

  test("a step that lost its parked decision fails with a message, and does not buy another", async () => {
    const { registry, executor, calls } = makeRegistry();
    const runId = await startRun(reviewedDefinition(), registry, false);
    const step = await stepOf(runId, "decide");
    await updateWorkflowRunStep(step.id, { output: {} });

    const result = await executor.run({
      config: mixedConfig({ humanReview: REVIEW }),
      context: {},
      meta: { runId, stepId: step.id, nodeId: "decide", workflowId: "wf", dryRun: false },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("parked with is missing");
    expect(calls()).toBe(1);
  });
});

// ─── The resolution step on its own ─────────────────────────

describe("resolveReviewedDecision", () => {
  const parked = (): Output =>
    SystemOneDecisionOutputSchema.parse({
      ...mixedBody(),
      review: {
        status: "pending",
        questions: {
          fit: { confidence: 0.82, inBand: false, decidedBy: "model" },
          authority: { confidence: 0.75, inBand: true, decidedBy: "model" },
          urgency: { confidence: 0.65, inBand: true, decidedBy: "model" },
        },
      },
    });
  const approval = (
    status: "approved" | "rejected" | "timeout",
    responses: Record<string, unknown> | null,
  ) => ({ requestId: "req-1", status, responses });

  test("an approved response outside the options is a rejection, never a confirmation", () => {
    for (const responses of [
      { authority: "nobody" },
      { authority: 7 },
      { urgency: "9" },
      { urgency: 2 },
    ]) {
      const outcome = resolveReviewedDecision(parked(), approval("approved", responses));
      expect(outcome?.nextPort).toBe("rejected");
      const output = outcome?.output as Output;
      expect(output.review?.status).toBe("rejected");
      expect(output.review?.reason).toContain("is not one of its options");
      expect(output.answers).toEqual(mixedBody().answers);
    }
  });

  test("empty and absent responses confirm the model's answer", () => {
    for (const responses of [null, {}, { authority: "", urgency: null }]) {
      const outcome = resolveReviewedDecision(parked(), approval("approved", responses));
      expect(outcome?.nextPort).toBe("approved");
      expect((outcome?.output as Output).answers).toEqual(mixedBody().answers);
    }
  });

  test("the result is always a valid node output", () => {
    for (const [status, responses] of [
      ["approved", { authority: "champion", urgency: "0" }],
      ["rejected", null],
      ["timeout", null],
    ] as const) {
      const outcome = resolveReviewedDecision(parked(), approval(status, responses));
      expect(SystemOneDecisionOutputSchema.safeParse(outcome?.output).success).toBe(true);
    }
  });

  test("anything that is not a pending decision returns null", () => {
    for (const value of [null, undefined, {}, { requestId: "x" }, mixedBody()]) {
      expect(resolveReviewedDecision(value, approval("approved", null))).toBeNull();
    }
  });

  test("the resume paths fall back to the plain approval output rather than wedge the run", () => {
    const { registry } = makeRegistry();
    const definition = reviewedDefinition();
    const outcome = shapeApprovalResolution(registry, definition, "decide", null, {
      requestId: "req-1",
      status: "rejected",
      responses: { $confirm: { approved: false } },
    });
    expect(outcome).toEqual({
      output: {
        requestId: "req-1",
        status: "rejected",
        responses: { $confirm: { approved: false } },
      },
      nextPort: "rejected",
    });
  });
});

// ─── A second backend on the same contract ──────────────────

/**
 * What `@desplega.ai/laya-server` returns from `POST /v1/systemone`: the
 * `agent.predict` result (`SystemOneResult`) plus `routing`. Values follow a live
 * call to laya.agent-swarm.dev (2026-09-29): probabilities rounded to 4 places,
 * a fractional score, an entropy-based `confidence` next to `answer_confidence`
 * (the top probability), and the extra fields laya adds.
 */
const layaResult = {
  model: "laya-rl-agent",
  answers: {
    team: {
      type: "choice",
      choice: "technical",
      probabilities: { billing: 0.1801, technical: 0.7302, sales: 0.0897 },
      confidence: 0.5211,
      answer_confidence: 0.7302,
      action: { act_probability: 0.9712 },
    },
    urgent: {
      type: "noul",
      noul: 0.7649,
      confidence: 0.7649,
      answer_confidence: 0.7649,
      action: { act_probability: 0.9 },
    },
    frustration: {
      type: "score",
      score: 1.8249,
      legend: { "0": "calm", "1": "annoyed", "2": "furious" },
      probabilities: { "0": 0.0412, "1": 0.1127, "2": 0.8461 },
      confidence: 0.4183,
      answer_confidence: 0.8461,
      action: { act_probability: 0.88 },
    },
  },
  usage: { input_tokens: 512, output_tokens: 0 },
  routing: {
    model: "english",
    repo: "desplega/laya-onnx/english/fp32",
    reason: "English Latin text",
    detection: { script: "latin", language: "en", isEnglish: true },
    workflow: null,
  },
};

const layaQuestions = {
  team: {
    type: "choice",
    instructions: "Which team handles `message`?",
    criteria: { billing: "charges, invoices", technical: "bugs, outages", sales: "pricing" },
  },
  urgent: { type: "noul", instructions: "Is the customer blocked or on a deadline?" },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["calm", "annoyed", "furious"],
  },
};

const LAYA_URL = "https://laya.example.test";
const layaField = SYSTEM_ONE_PROVIDERS.laya.confidenceField;

describe("a laya result fits the node's output contract", () => {
  const config = () =>
    SystemOneDecisionConfigSchema.parse({
      provider: "laya",
      state: { message: "Production orders stopped syncing" },
      questions: layaQuestions,
      returns: {
        team: { type: "choice" },
        urgent: { type: "noul" },
        frustration: { type: "score" },
      },
      humanReview: { band: { min: 0.7, max: 0.8 }, approvers: APPROVERS },
    });

  test("questions written for laya are valid node questions", () => {
    expect(config().questions.team?.type).toBe("choice");
    expect(config().provider).toBe("laya");
  });

  test("the confidence of a choice or score is laya's answer_confidence, the top probability", () => {
    expect(layaField).toBe("answer_confidence");
    const output = validateSystemOneResponse(config().questions, layaResult, undefined, layaField);
    expect(output.model).toBe("laya-rl-agent");
    expect(output.usage).toEqual({ input_tokens: 512, output_tokens: 0 });
    expect(output.answers.team).toEqual({
      type: "choice",
      choice: "technical",
      probabilities: layaResult.answers.team.probabilities,
      confidence: 0.7302,
    });
    expect(output.answers.frustration).toMatchObject({
      type: "score",
      score: 1.8249,
      confidence: 0.8461,
    });
    // laya's own entropy-based number is not kept, and neither is its action head.
    expect(JSON.stringify(output)).not.toContain("0.5211");
    expect(JSON.stringify(output)).not.toContain("answer_confidence");
    expect(JSON.stringify(output)).not.toContain("act_probability");
  });

  test("the checkpoint that answered is kept as routing.model; the rest of routing is dropped", () => {
    const output = validateSystemOneResponse(config().questions, layaResult, undefined, layaField);
    expect(output.routing).toEqual({ model: "english" });
    expect(output.model).toBe("laya-rl-agent");
    expect(JSON.stringify(output)).not.toContain("laya-onnx");
    expect(JSON.stringify(output)).not.toContain("detection");
    expect(SystemOneDecisionOutputSchema.safeParse(output).success).toBe(true);
  });

  test("a missing or malformed routing is left out, not a failure", () => {
    const { routing: _routing, ...noRouting } = layaResult;
    for (const routing of [undefined, null, "english", {}, { model: "" }, { model: 3 }]) {
      const body = routing === undefined ? noRouting : { ...layaResult, routing };
      const output = validateSystemOneResponse(config().questions, body, undefined, layaField);
      expect(output.routing).toBeUndefined();
      expect("routing" in output).toBe(false);
    }
    const long = { ...layaResult, routing: { model: "x".repeat(129) } };
    expect(
      validateSystemOneResponse(config().questions, long, undefined, layaField).routing,
    ).toBeUndefined();
  });

  test("usage.windows from predictLong is dropped, not rejected", () => {
    const output = validateSystemOneResponse(
      config().questions,
      { ...layaResult, usage: { input_tokens: 900, output_tokens: 0, windows: 3 } },
      undefined,
      layaField,
    );
    expect(output.usage).toEqual({ input_tokens: 900, output_tokens: 0 });
  });

  test("one band means the same on every question type: team 0.7302 and urgent 0.7649 in 0.7 to 0.8", () => {
    const output = validateSystemOneResponse(config().questions, layaResult, undefined, layaField);
    const inBand = Object.entries(output.answers)
      .filter(([, answer]) => {
        const c = answerConfidence(answer);
        return c >= 0.7 && c <= 0.8;
      })
      .map(([id]) => id);
    expect(inBand).toEqual(["team", "urgent"]);
  });

  const nodeConfig = (overrides: Record<string, unknown> = {}) => ({
    provider: "laya",
    state: { message: "Production orders stopped syncing" },
    questions: layaQuestions,
    returns: {
      team: { type: "choice" },
      urgent: { type: "noul" },
      frustration: { type: "score" },
    },
    ...overrides,
  });
  const layaFetch = (calls: { url: string; init: RequestInit }[]) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(layaResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

  test("a humanReview band tested on answer_confidence parks, and routing survives the wait", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const registry = new ExecutorRegistry();
    registry.register(
      new SystemOneDecisionExecutor(deps, {
        fetch: layaFetch(calls),
        getApiKey: async () => API_KEY,
        getServerUrl: async () => LAYA_URL,
      }),
    );
    registry.register(new MarkerExecutor(deps));
    const marker = (id: string): WorkflowNode => ({ id, type: "marker", config: { label: id } });
    const runId = await startRun(
      {
        nodes: [
          {
            id: "decide",
            type: "system-one-decision",
            config: nodeConfig({
              humanReview: { band: { min: 0.7, max: 0.8 }, approvers: APPROVERS },
            }),
            next: PORTS,
          },
          ...Object.values(PORTS).map(marker),
        ],
      },
      registry,
    );

    // team (0.7302) and urgent (0.7649) are in the band; frustration (0.8461) is not.
    expect((await getWorkflowRun(runId))?.status).toBe("waiting");
    const parked = await decideOutput(runId);
    expect(parked.routing).toEqual({ model: "english" });
    expect(parked.review?.questions.team).toMatchObject({ confidence: 0.7302, inBand: true });
    expect(parked.review?.questions.urgent).toMatchObject({ confidence: 0.7649, inBand: true });
    expect(parked.review?.questions.frustration).toMatchObject({
      confidence: 0.8461,
      inBand: false,
    });
    const approval = await approvalOf(runId);
    expect((approval.questions as Array<{ id: string }>).map((q) => q.id)).toEqual([
      "$confirm",
      "team",
      "urgent",
    ]);

    await respond(runId, "approved");
    expect(await settle(runId)).toBe("completed");
    const finished = await decideOutput(runId);
    expect(finished.review?.status).toBe("approved");
    expect(finished.routing).toEqual({ model: "english" });
    expect(calls).toHaveLength(1);
  });
});
