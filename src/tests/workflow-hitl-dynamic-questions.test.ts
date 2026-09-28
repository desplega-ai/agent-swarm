import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  createWorkflow,
  getApprovalRequestByStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { validateDefinition } from "../workflows/definition";
import { interpolateNodeConfig, startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import {
  buildSlackQuestionsSummary,
  HumanInTheLoopExecutor,
  MAX_HITL_QUESTIONS,
  resolveHitlQuestions,
} from "../workflows/executors/human-in-the-loop";
import { ExecutorRegistry } from "../workflows/executors/registry";

const TEST_DB_PATH = "./test-workflow-hitl-dynamic-questions.sqlite";

/**
 * Emits a fixed payload, standing in for an upstream agent-task. The payload is
 * held outside node config so it reaches downstream nodes uninterpolated, like
 * real LLM output would.
 */
class EmitExecutor extends BaseExecutor<typeof EmitExecutor.schema, typeof EmitExecutor.outSchema> {
  static readonly schema = z.object({});
  static readonly outSchema = z.object({ payload: z.unknown() });

  readonly type = "emit";
  readonly mode = "instant" as const;
  readonly configSchema = EmitExecutor.schema;
  readonly outputSchema = EmitExecutor.outSchema;

  constructor(
    deps: ExecutorDependencies,
    private readonly payload: unknown,
  ) {
    super(deps);
  }

  protected async execute(): Promise<ExecutorResult<z.infer<typeof EmitExecutor.outSchema>>> {
    return { status: "success", output: { payload: this.payload } };
  }
}

function makeRegistry(payload: unknown = {}): ExecutorRegistry {
  const deps: ExecutorDependencies = {
    db: db as typeof import("../be/db"),
    eventBus: new InProcessEventBus(),
    interpolate: (t: string) => t,
  };
  const registry = new ExecutorRegistry();
  registry.register(new EmitExecutor(deps, payload));
  registry.register(new HumanInTheLoopExecutor(deps));
  return registry;
}

function alertQuestion(n: number) {
  return {
    id: `alert_${n}`,
    type: "single-select",
    label: `#${n} lodash (high): prototype pollution, proposed fix`,
    required: false,
    options: [
      { value: "fix", label: "Fix (PR)" },
      { value: "dismiss", label: "Dismiss" },
      { value: "triage", label: "Triage" },
    ],
  };
}

function dynamicDef(questionsToken = "{{plan.payload.questions}}") {
  return {
    nodes: [
      { id: "triage", type: "emit", config: {}, next: "card" },
      {
        id: "card",
        type: "human-in-the-loop",
        inputs: { plan: "triage" },
        config: {
          title: "Plan for {{plan.payload.count}} alerts",
          questions: questionsToken,
          approvers: { policy: "any" },
        },
      },
    ],
  } satisfies WorkflowDefinition;
}

async function runDefinition(def: WorkflowDefinition, payload: unknown) {
  const registry = makeRegistry(payload);
  const workflow = await createWorkflow({
    name: `hitl-dynamic-${crypto.randomUUID()}`,
    definition: def,
  });
  const runId = await startWorkflowExecution(workflow, {}, registry);
  const steps = await getWorkflowRunStepsByRunId(runId);
  const card = steps.find((s) => s.nodeId === "card");
  return { runId, run: await getWorkflowRun(runId), card };
}

describe("human-in-the-loop dynamic questions", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // File may not exist
      }
    }
  });

  test("builds one card question per upstream item and keeps upstream text literal", async () => {
    const questions = [
      ...Array.from({ length: 32 }, (_, i) => alertQuestion(i + 1)),
      {
        id: "approve_plan",
        type: "approval",
        label: "Run the selected actions? {{trigger.secret}} <!channel>",
        llmExtra: "stripped",
      },
    ];
    const { run, card } = await runDefinition(dynamicDef(), { count: 32, questions });

    expect(run!.status).toBe("waiting");
    expect(card!.status).toBe("waiting");
    const request = await getApprovalRequestByStepId(card!.id);
    expect(request).not.toBeNull();
    expect(request!.title).toBe("Plan for 32 alerts");
    const stored = request!.questions as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(33);
    expect(stored[0]).toMatchObject({ id: "alert_1", type: "single-select", required: false });
    expect(stored[32]).toEqual({
      id: "approve_plan",
      type: "approval",
      label: "Run the selected actions? {{trigger.secret}} <!channel>",
      required: true,
    });
  });

  test("static questions keep string interpolation and create the card unchanged", async () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: "triage", type: "emit", config: {}, next: "card" },
        {
          id: "card",
          type: "human-in-the-loop",
          inputs: { plan: "triage" },
          config: {
            title: "Deploy",
            questions: [{ id: "q1", type: "approval", label: "{{plan.payload}}" }],
            approvers: { policy: "any" },
          },
        },
      ],
    };
    const { card } = await runDefinition(def, { env: "prod" });
    const request = await getApprovalRequestByStepId(card!.id);
    expect(request!.questions).toEqual([
      { id: "q1", type: "approval", label: '{"env":"prod"}', required: true },
    ]);
  });

  test("an empty array fails the node and creates no card", async () => {
    const { run, card } = await runDefinition(dynamicDef(), { count: 0, questions: [] });
    expect(card!.status).toBe("failed");
    expect(card!.error).toContain("resolved to an empty array");
    expect(run!.status).toBe("failed");
    expect(await getApprovalRequestByStepId(card!.id)).toBeNull();
  });

  test("a malformed item fails the node with the item index and field", async () => {
    const bad = { id: "alert_2", type: "single-select", label: "#2" };
    const { card } = await runDefinition(dynamicDef(), {
      count: 2,
      questions: [alertQuestion(1), bad],
    });
    expect(card!.status).toBe("failed");
    expect(card!.error).toContain("[1].options");
    expect(await getApprovalRequestByStepId(card!.id)).toBeNull();
  });

  test("an unresolved token fails the node instead of creating an empty card", async () => {
    const { card } = await runDefinition(dynamicDef("{{plan.payload.missing}}"), { count: 1 });
    expect(card!.status).toBe("failed");
    expect(card!.error).toContain("did not resolve");
    expect(await getApprovalRequestByStepId(card!.id)).toBeNull();
  });
});

describe("resolveHitlQuestions", () => {
  test("rejects non-arrays, duplicates, empty options and oversize sets", () => {
    expect(resolveHitlQuestions({ questions: [] })).toMatchObject({ ok: false });
    expect(resolveHitlQuestions('[{"id":"q"}]')).toMatchObject({ ok: false });

    const dup = resolveHitlQuestions([alertQuestion(1), alertQuestion(1)]);
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.error).toContain('duplicate id "alert_1"');

    const noOptions = resolveHitlQuestions([{ ...alertQuestion(1), options: [] }]);
    expect(!noOptions.ok && noOptions.error).toContain("at least one option");

    const tooMany = Array.from({ length: MAX_HITL_QUESTIONS + 1 }, (_, i) => alertQuestion(i));
    const oversize = resolveHitlQuestions(tooMany);
    expect(!oversize.ok && oversize.error).toContain(`limit of ${MAX_HITL_QUESTIONS}`);

    const atLimit = tooMany.slice(0, MAX_HITL_QUESTIONS);
    expect(resolveHitlQuestions(atLimit).ok).toBe(true);
  });
});

describe("buildSlackQuestionsSummary", () => {
  test("stays inside the Block Kit section limit and escapes upstream text", () => {
    const labels = Array.from({ length: 32 }, (_, i) => ({
      label: `#${i + 1} ${"very-long-package-name ".repeat(6)}<!channel> & <https://evil|x>`,
    }));
    const text = buildSlackQuestionsSummary(labels, "\n⏱ _Timeout: 72h_");
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toContain("more. Answer all of them on the dashboard.");
    expect(text).toContain("&lt;!channel&gt; &amp; &lt;https://evil|x&gt;");
    expect(text).not.toContain("<!channel>");
    expect(text.endsWith("⏱ _Timeout: 72h_")).toBe(true);
  });

  test("lists every question when they fit", () => {
    const text = buildSlackQuestionsSummary([{ label: "A" }, { label: "B" }]);
    expect(text).toBe("*Questions:*\n• A\n• B");
  });
});

describe("dynamic questions authoring", () => {
  const registry = makeRegistry();
  const withQuestions = (questions: unknown): WorkflowDefinition => ({
    nodes: [
      { id: "triage", type: "emit", config: {}, next: "card" },
      {
        id: "card",
        type: "human-in-the-loop",
        inputs: { plan: "triage" },
        config: { title: "t", questions, approvers: { policy: "any" } },
      },
    ],
  });

  test("accepts one exact token and rejects a token with surrounding text", () => {
    expect(validateDefinition(withQuestions("{{plan.payload.questions}}"), registry).valid).toBe(
      true,
    );
    const mixed = validateDefinition(withQuestions("x {{plan.payload.questions}}"), registry);
    expect(mixed.valid).toBe(false);
    expect(mixed.errors.join("\n")).toContain("one exact {{interpolation}} token");
  });

  test("interpolateNodeConfig injects the raw array for the token form only", () => {
    const questions = [alertQuestion(1)];
    const ctx = { plan: { questions } };
    const dynamic = interpolateNodeConfig(
      { type: "human-in-the-loop", config: { title: "t", questions: "{{plan.questions}}" } },
      ctx,
    );
    expect((dynamic.value as { questions: unknown }).questions).toBe(questions);
  });
});
