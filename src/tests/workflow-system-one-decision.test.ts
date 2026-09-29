import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import type { Workflow, WorkflowDefinition, WorkflowNode } from "../types";
import { validateDefinition } from "../workflows/definition";
import { interpolateNodeConfig, startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { PropertyMatchExecutor } from "../workflows/executors/property-match";
import { createExecutorRegistry, ExecutorRegistry } from "../workflows/executors/registry";
import {
  SYSTEM_ONE_ENDPOINT,
  SystemOneDecisionConfigSchema,
  SystemOneDecisionExecutor,
  type SystemOneDecisionExecutorOptions,
  SystemOneDecisionOutputSchema,
} from "../workflows/executors/system-one-decision";
import { findWorkflowReadinessProblems, workflowSaveWarnings } from "../workflows/readiness";
import { retryFailedRun } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-system-one-decision.sqlite";
// Shaped like a token but obviously fake; must never appear in any output or error.
const API_KEY = "tsk_example-jev-test-key.0123456789";

// ─── Harness ────────────────────────────────────────────────

let deps: ExecutorDependencies;
let agentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type TransportStep = Response | Error | ((init: RequestInit) => Response | Promise<Response>);

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** Fake TypeSafe transport: serves `steps` in order, repeating the last one. */
function makeTransport(steps: TransportStep[]) {
  const calls: RecordedCall[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    const requestInit = init ?? {};
    calls.push({
      url: String(input),
      init: requestInit,
      body: JSON.parse(String(requestInit.body ?? "{}")) as Record<string, unknown>,
    });
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(requestInit);
    // A Response body can only be read once; hand out a fresh copy per call.
    return (step as Response).clone();
  }) as typeof fetch;
  return { calls, transport };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeExecutor(steps: TransportStep[], options: SystemOneDecisionExecutorOptions = {}) {
  const { calls, transport } = makeTransport(steps);
  const sleeps: number[] = [];
  const executor = new SystemOneDecisionExecutor(deps, {
    fetch: transport,
    getApiKey: async () => API_KEY,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    ...options,
  });
  return { executor, calls, sleeps };
}

function meta(nodeId = "qualify") {
  return {
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
    nodeId,
    workflowId: crypto.randomUUID(),
    dryRun: false,
  };
}

async function runSystemOne(executor: SystemOneDecisionExecutor, config: Record<string, unknown>) {
  return executor.run({ config, context: {}, meta: meta() });
}

// ─── Fixtures ───────────────────────────────────────────────

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
        criteria: {
          true: "A matching team with a concrete use case",
          false: "Spam, recruitment, unrelated need, or no matching team",
        },
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

function mixedBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: { fit: noulAnswer, authority: choiceAnswer, urgency: scoreAnswer },
    usage: { input_tokens: 400, output_tokens: 80 },
    ...overrides,
  };
}

/** A single-question config + body, for validation table tests. */
const authorityOnly = mixedConfig({
  questions: { authority: (mixedConfig().questions as Record<string, unknown>).authority },
  returns: { authority: { type: "choice" } },
});

function withAnswers(answers: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return mixedBody({ answers, ...overrides });
}

// ─── Lifecycle ──────────────────────────────────────────────

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const agent = await createAgent({ name: "jev-test-agent", isLead: true, status: "idle" });
  agentId = agent.id;
  const db = await import("../be/db");
  deps = {
    db,
    eventBus: new InProcessEventBus(),
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM workflow_run_steps");
  await client.run("DELETE FROM workflow_runs");
  await client.run("DELETE FROM workflows");
  await client.run("DELETE FROM swarm_config WHERE key = 'TYPESAFE_API_KEY'");
});

// ─── Config schema ──────────────────────────────────────────

describe("system-one-decision config schema", () => {
  test("accepts a mixed-primitive call and applies defaults", () => {
    const parsed = SystemOneDecisionConfigSchema.parse({
      state: "text",
      questions: { fit: { type: "noul", instructions: "Is it real?" } },
      returns: { fit: { type: "noul" } },
    });
    expect(parsed.provider).toBe("typesafe");
    // The model default belongs to the provider, so the schema leaves it unset.
    expect(parsed.model).toBeUndefined();
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.maxRetries).toBe(2);
    expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig()).success).toBe(true);
  });

  test("accepts structured state: string, string array, and JSON object", () => {
    for (const state of ["text", ["a", "b"], { nested: { list: [1, 2, 3] } }]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig({ state })).success).toBe(true);
    }
    for (const state of ["", [], 42, null]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig({ state })).success).toBe(false);
    }
  });

  test("rejects endpoint, credential, header, and unknown fields", () => {
    for (const extra of [
      { url: "https://evil.example/v1/systemone" },
      { endpoint: "https://evil.example" },
      { apiKey: "tsk_x" },
      { api_key: "tsk_x" },
      { headers: { authorization: "Bearer x" } },
      { outputSchema: { type: "object" } },
      { fallbackPort: "x" },
    ]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig(extra)).success).toBe(false);
    }
  });

  test("rejects misspelled question fields", () => {
    const config = mixedConfig({
      questions: { fit: { type: "noul", instruction: "typo" } },
      returns: { fit: { type: "noul" } },
    });
    expect(SystemOneDecisionConfigSchema.safeParse(config).success).toBe(false);
  });

  test("rejects out-of-range timeout and retry counts", () => {
    for (const bad of [
      { timeoutMs: 999 },
      { timeoutMs: 300_001 },
      { maxRetries: 4 },
      { maxRetries: -1 },
    ]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig(bad)).success).toBe(false);
    }
    expect(
      SystemOneDecisionConfigSchema.safeParse(mixedConfig({ timeoutMs: 1_000, maxRetries: 0 }))
        .success,
    ).toBe(true);
    expect(
      SystemOneDecisionConfigSchema.safeParse(mixedConfig({ timeoutMs: 300_000, maxRetries: 3 }))
        .success,
    ).toBe(true);
  });

  test("rejects invalid criteria counts", () => {
    const withQuestion = (question: Record<string, unknown>) =>
      mixedConfig({ questions: { q: question }, returns: { q: { type: question.type } } });
    const options = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`opt${i}`, `Option ${i}`]));
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `Level ${i}`);

    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ type: "choice", instructions: "pick", criteria: options(1) }, false],
      [{ type: "choice", instructions: "pick", criteria: options(2) }, true],
      [{ type: "choice", instructions: "pick", criteria: options(255) }, true],
      [{ type: "choice", instructions: "pick", criteria: options(256) }, false],
      [{ type: "choice", instructions: "pick" }, false],
      [{ type: "score", instructions: "rate", criteria: levels(1) }, false],
      [{ type: "score", instructions: "rate", criteria: levels(2) }, true],
      [{ type: "score", instructions: "rate", criteria: levels(10) }, true],
      [{ type: "score", instructions: "rate", criteria: levels(11) }, false],
      [{ type: "score", instructions: "rate" }, false],
      [{ type: "noul", instructions: "true?", criteria: {} }, false],
      [{ type: "noul", instructions: "true?", criteria: { true: "yes" } }, true],
      [{ type: "noul", instructions: "true?", criteria: ["a", "b"] }, false],
      [{ type: "noul", instructions: "  " }, false],
      [{ type: "noul", instructions: null }, false],
      [{ type: "noul", instructions: { rubric: ["a", "b"] } }, true],
    ];
    for (const [question, ok] of cases) {
      expect(SystemOneDecisionConfigSchema.safeParse(withQuestion(question)).success).toBe(ok);
    }
  });

  test("rejects a returns map that disagrees with the questions", () => {
    const base = mixedConfig();
    const missing = mixedConfig({
      returns: { fit: { type: "noul" }, authority: { type: "choice" } },
    });
    const extra = mixedConfig({
      returns: { ...(base.returns as object), ghost: { type: "noul" } },
    });
    const wrongType = mixedConfig({
      returns: {
        fit: { type: "score" },
        authority: { type: "choice" },
        urgency: { type: "score" },
      },
    });
    const noReturns = { ...base };
    delete noReturns.returns;

    for (const config of [missing, extra, wrongType, noReturns]) {
      expect(SystemOneDecisionConfigSchema.safeParse(config).success).toBe(false);
    }
    const issue = SystemOneDecisionConfigSchema.safeParse(wrongType);
    expect(JSON.stringify(issue.error?.issues)).toContain("returns.fit.type");
  });

  test("rejects an empty question map and unsafe question ids", () => {
    const question = { type: "noul", instructions: "true?" };
    expect(
      SystemOneDecisionConfigSchema.safeParse(mixedConfig({ questions: {}, returns: {} })).success,
    ).toBe(false);
    for (const id of ["1bad", "has space", "a.b", "", "constructor", "prototype", "toString"]) {
      const config = mixedConfig({
        questions: { [id]: question },
        returns: { [id]: { type: "noul" } },
      });
      expect(SystemOneDecisionConfigSchema.safeParse(config).success).toBe(false);
    }
    const proto = JSON.parse(
      `{"state":"x","questions":{"__proto__":{"type":"noul","instructions":"t"}},"returns":{"__proto__":{"type":"noul"}}}`,
    );
    expect(SystemOneDecisionConfigSchema.safeParse(proto).success).toBe(false);
    for (const id of ["fit", "_private", "a-b_c9", "Q1"]) {
      const config = mixedConfig({
        questions: { [id]: question },
        returns: { [id]: { type: "noul" } },
      });
      expect(SystemOneDecisionConfigSchema.safeParse(config).success).toBe(true);
    }
  });
});

// ─── Request + success path ─────────────────────────────────

describe("SystemOneDecisionExecutor request and output", () => {
  test("sends one state and the whole question map to the fixed TypeSafe endpoint", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(mixedBody())]);
    const config = mixedConfig();
    const result = await runSystemOne(executor, config);

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.url).toBe(SYSTEM_ONE_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    // `returns` is our own contract and must not be sent to the provider.
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    expect(call.body.model).toBe("jev-1.13.0");
    expect(call.body.state).toEqual(config.state as object);
    expect(call.body.questions).toEqual(config.questions as object);
  });

  test("defaults the model alias and preserves structured state types", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(mixedBody({ model: "jev-1.13.0" }))]);
    const state = { deal: { size: 12000, tags: ["a", "b"], open: true, owner: null } };
    const config = mixedConfig({ state });
    delete config.model;
    const result = await runSystemOne(executor, config);

    expect(result.status).toBe("success");
    expect(calls[0]?.body.model).toBe("jev-latest");
    expect(calls[0]?.body.state).toEqual(state);
    // The persisted model is the one the API reports, not the requested alias.
    expect(result.output?.model).toBe("jev-1.13.0");
  });

  test("returns all three primitives with distributions, confidence, and usage", async () => {
    const { executor } = makeExecutor([
      jsonResponse(mixedBody(), 200, { "x-request-id": "req_abc-123" }),
    ]);
    const result = await runSystemOne(executor, mixedConfig());

    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      model: "jev-1.13.0",
      answers: { fit: noulAnswer, authority: choiceAnswer, urgency: scoreAnswer },
      usage: { input_tokens: 400, output_tokens: 80 },
      requestId: "req_abc-123",
    });
    expect(SystemOneDecisionOutputSchema.safeParse(result.output).success).toBe(true);
    expect(result.nextPort).toBeUndefined();
  });

  test("each primitive works on its own", async () => {
    const cases: Array<[string, unknown]> = [
      ["fit", noulAnswer],
      ["authority", choiceAnswer],
      ["urgency", scoreAnswer],
    ];
    for (const [id, answer] of cases) {
      const full = mixedConfig();
      const config = mixedConfig({
        questions: { [id]: (full.questions as Record<string, unknown>)[id] },
        returns: { [id]: (full.returns as Record<string, unknown>)[id] },
      });
      const { executor, calls } = makeExecutor([jsonResponse(withAnswers({ [id]: answer }))]);
      const result = await runSystemOne(executor, config);
      expect(result.status).toBe("success");
      expect(Object.keys(result.output?.answers ?? {})).toEqual([id]);
      expect(Object.keys(calls[0]?.body.questions as object)).toEqual([id]);
    }
  });

  test("a Noul answer stays {type, noul}: no invented confidence or provider extras", async () => {
    const noisy = { type: "noul", noul: 0.5, confidence: 0.99, rationale: "because", extra: 1 };
    const { executor } = makeExecutor([jsonResponse(withAnswers({ fit: noisy }))]);
    const fitOnly = mixedConfig({
      questions: { fit: (mixedConfig().questions as Record<string, unknown>).fit },
      returns: { fit: { type: "noul" } },
    });
    const result = await runSystemOne(executor, fitOnly);

    expect(result.status).toBe("success");
    expect(result.output?.answers.fit).toEqual({ type: "noul", noul: 0.5 });
    expect(JSON.stringify(result.output)).not.toContain("confidence");
    expect(JSON.stringify(result.output)).not.toContain("rationale");
  });

  test("a low-confidence answer is a successful evaluation", async () => {
    const lowConfidence = { ...choiceAnswer, confidence: 0.05 };
    const { executor } = makeExecutor([jsonResponse(withAnswers({ authority: lowConfidence }))]);
    const result = await runSystemOne(executor, authorityOnly);
    expect(result.status).toBe("success");
    expect((result.output?.answers.authority as { confidence: number }).confidence).toBe(0.05);
  });
});

// ─── Answer validation ──────────────────────────────────────

describe("SystemOneDecisionExecutor answer validation", () => {
  async function failsWith(body: unknown, expected: string, config = mixedConfig()) {
    const { executor } = makeExecutor([jsonResponse(body)]);
    const result = await runSystemOne(executor, config);
    expect(result.status).toBe("failed");
    expect(result.output).toBeUndefined();
    expect(result.error).toContain(expected);
  }

  test("rejects a missing or extra answer", async () => {
    await failsWith(
      withAnswers({ fit: noulAnswer, authority: choiceAnswer }),
      'question "urgency"',
    );
    await failsWith(
      withAnswers({
        fit: noulAnswer,
        authority: choiceAnswer,
        urgency: scoreAnswer,
        ghost: noulAnswer,
      }),
      "undeclared",
    );
    await failsWith(withAnswers({}), "question", mixedConfig());
  });

  test("rejects an answer of the wrong primitive type", async () => {
    await failsWith(
      withAnswers({ fit: choiceAnswer, authority: choiceAnswer, urgency: scoreAnswer }),
      'declares "noul"',
    );
  });

  test("rejects a Noul outside [0,1] or non-numeric", async () => {
    for (const noul of [1.2, -0.1, "0.5", null, Number.NaN]) {
      await failsWith(
        withAnswers({ fit: { type: "noul", noul }, authority: choiceAnswer, urgency: scoreAnswer }),
        "answer",
      );
    }
  });

  test("rejects an unknown choice, bad probability keys, and a distribution that does not sum to 1", async () => {
    await failsWith(
      withAnswers({ authority: { ...choiceAnswer, choice: "vip" } }),
      "not one of the declared options",
      authorityOnly,
    );
    await failsWith(
      withAnswers({
        authority: { ...choiceAnswer, probabilities: { buyer: 0.9, champion: 0.1 } },
      }),
      "probabilities keys",
      authorityOnly,
    );
    await failsWith(
      withAnswers({
        authority: {
          ...choiceAnswer,
          probabilities: { buyer: 0.9, champion: 0.07, unknown: 0.03, vip: 0 },
        },
      }),
      "probabilities keys",
      authorityOnly,
    );
    await failsWith(
      withAnswers({
        authority: { ...choiceAnswer, probabilities: { buyer: 0.5, champion: 0.1, unknown: 0.1 } },
      }),
      "must sum to 1",
      authorityOnly,
    );
    await failsWith(
      withAnswers({ authority: { ...choiceAnswer, confidence: 1.5 } }),
      "confidence",
      authorityOnly,
    );
  });

  test("accepts a distribution within the rounding tolerance and never normalizes it", async () => {
    const probabilities = { buyer: 0.905, champion: 0.075, unknown: 0.03 };
    const { executor } = makeExecutor([
      jsonResponse(withAnswers({ authority: { ...choiceAnswer, probabilities } })),
    ]);
    const result = await runSystemOne(executor, authorityOnly);
    expect(result.status).toBe("success");
    expect((result.output?.answers.authority as { probabilities: object }).probabilities).toEqual(
      probabilities,
    );
  });

  test("rejects an out-of-range score, a missing legend level, and bad probabilities", async () => {
    const scoreOnly = mixedConfig({
      questions: { urgency: (mixedConfig().questions as Record<string, unknown>).urgency },
      returns: { urgency: { type: "score" } },
    });
    for (const score of [-0.1, 2.01, "1", Number.NaN]) {
      await failsWith(withAnswers({ urgency: { ...scoreAnswer, score } }), "score", scoreOnly);
    }
    await failsWith(
      withAnswers({
        urgency: { ...scoreAnswer, legend: { "0": "No timeline", "1": "This quarter" } },
      }),
      "legend is missing level 2",
      scoreOnly,
    );
    await failsWith(
      withAnswers({ urgency: { ...scoreAnswer, probabilities: { "0": 0.5, "1": 0.5 } } }),
      "probabilities keys",
      scoreOnly,
    );
    const boundary = { ...scoreAnswer, score: 2 };
    const { executor } = makeExecutor([jsonResponse(withAnswers({ urgency: boundary }))]);
    expect((await runSystemOne(executor, scoreOnly)).status).toBe("success");
  });

  test("rejects malformed success bodies and missing usage or model", async () => {
    await failsWith(mixedBody({ usage: undefined }), "usage");
    await failsWith(mixedBody({ usage: { input_tokens: 1 } }), "usage");
    await failsWith(mixedBody({ usage: { input_tokens: -1, output_tokens: 0 } }), "usage");
    await failsWith(mixedBody({ usage: { input_tokens: 1.5, output_tokens: 0 } }), "usage");
    await failsWith(mixedBody({ model: undefined }), "model");
    await failsWith(mixedBody({ model: "" }), "model");
    await failsWith(mixedBody({ answers: undefined }), "answers");
    await failsWith(mixedBody({ answers: [] }), "answers");
    await failsWith([mixedBody()], "JSON object");
  });

  test("rejects a success body that is not JSON", async () => {
    const { executor, calls } = makeExecutor([
      new Response("<html>gateway</html>", { status: 200 }),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not valid JSON");
    // A bad success body is never retried: it would repeat a paid call.
    expect(calls).toHaveLength(1);
  });

  test("a validation failure is not retried", async () => {
    const { executor, calls, sleeps } = makeExecutor([
      jsonResponse(mixedBody({ usage: undefined })),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

// ─── Transport ──────────────────────────────────────────────

describe("SystemOneDecisionExecutor transport", () => {
  test("401 and 422 make exactly one attempt", async () => {
    for (const status of [401, 422]) {
      const { executor, calls, sleeps } = makeExecutor([
        jsonResponse({ error: { code: "invalid_request", message: "state: bad" } }, status),
      ]);
      const result = await runSystemOne(executor, mixedConfig());
      expect(result.status).toBe("failed");
      expect(result.error).toContain(`HTTP ${status}`);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  test("other 4xx statuses are not retried", async () => {
    for (const status of [400, 403, 404, 413]) {
      const { executor, calls } = makeExecutor([jsonResponse({}, status)]);
      const result = await runSystemOne(executor, mixedConfig());
      expect(result.status).toBe("failed");
      expect(calls).toHaveLength(1);
    }
  });

  test("error diagnostics carry status, code, and request id, but not the provider message or state", async () => {
    const { executor } = makeExecutor([
      jsonResponse(
        { error: { code: "invalid_request", message: "state contained: We are blocked on agent" } },
        422,
        { "x-request-id": "req_422" },
      ),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.error).toBe(
      "SystemOne API returned HTTP 422 (invalid_request) [request req_422]",
    );
    expect(result.error).not.toContain("blocked");
  });

  test("429 then success retries once after a backoff", async () => {
    const { executor, calls, sleeps } = makeExecutor([
      jsonResponse({}, 429),
      jsonResponse(mixedBody()),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("success");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
    // A retry repeats the same request.
    expect(calls[1]?.body).toEqual(calls[0]?.body);
  });

  test("529 exhausts maxRetries with exponential, jittered waits", async () => {
    const { executor, calls, sleeps } = makeExecutor([jsonResponse({}, 529)], { random: () => 1 });
    const result = await runSystemOne(executor, mixedConfig({ maxRetries: 2 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 529");
    expect(result.error).toContain("after 3 attempts");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);

    const lower = makeExecutor([jsonResponse({}, 529)], { random: () => 0 });
    await runSystemOne(lower.executor, mixedConfig({ maxRetries: 2 }));
    expect(lower.sleeps).toEqual([250, 500]);
  });

  test("maxRetries 0 makes a single attempt", async () => {
    const { executor, calls, sleeps } = makeExecutor([jsonResponse({}, 429)]);
    const result = await runSystemOne(executor, mixedConfig({ maxRetries: 0 }));
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("retries 408, 5xx, and connection errors", async () => {
    for (const first of [
      jsonResponse({}, 408),
      jsonResponse({}, 503),
      new TypeError("fetch failed"),
    ]) {
      const { executor, calls } = makeExecutor([first, jsonResponse(mixedBody())]);
      const result = await runSystemOne(executor, mixedConfig());
      expect(result.status).toBe("success");
      expect(calls).toHaveLength(2);
    }
  });

  test("a connection error reports only a sanitized code", async () => {
    const error = Object.assign(new Error(`connect failed for Bearer ${API_KEY}`), {
      code: "ECONNRESET",
    });
    const { executor } = makeExecutor([error], { random: () => 1 });
    const result = await runSystemOne(executor, mixedConfig({ maxRetries: 0 }));
    expect(result.error).toBe("SystemOne request failed: network error (ECONNRESET)");
    expect(result.error).not.toContain(API_KEY);
  });

  test("Retry-After is honored: the wait is never shorter than the header", async () => {
    const { executor, sleeps } = makeExecutor([
      jsonResponse({}, 429, { "retry-after": "2" }),
      jsonResponse(mixedBody()),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("success");
    expect(sleeps).toEqual([2000]);
  });

  test("Retry-After accepts an HTTP date", async () => {
    const now = Date.UTC(2026, 8, 29, 12, 0, 0);
    const { executor, sleeps } = makeExecutor(
      [
        jsonResponse({}, 429, { "retry-after": new Date(now + 3_000).toUTCString() }),
        jsonResponse(mixedBody()),
      ],
      { now: () => now },
    );
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("success");
    expect(sleeps).toEqual([3000]);
  });

  test("a Retry-After beyond the time budget fails instead of retrying early", async () => {
    const { executor, calls, sleeps } = makeExecutor([
      jsonResponse({}, 429, { "retry-after": "120" }),
    ]);
    const result = await runSystemOne(executor, mixedConfig({ timeoutMs: 30_000 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 429");
    expect(result.error).toContain("does not fit");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("redirects are refused, not followed", async () => {
    const { executor, calls } = makeExecutor([
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    ]);
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("redirect");
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.url === SYSTEM_ONE_ENDPOINT)).toBe(true);
  });

  test("timeout aborts the in-flight request", async () => {
    let aborted = false;
    const { executor, calls } = makeExecutor([
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ]);
    const started = Date.now();
    const result = await runSystemOne(executor, mixedConfig({ timeoutMs: 1_000 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("1000ms time budget");
    expect(aborted).toBe(true);
    // The executor reports before the engine watchdog (timeoutMs) would fire.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  test("timeout aborts a backoff wait", async () => {
    const { executor, calls } = makeExecutor([jsonResponse({}, 429, { "retry-after": "0.5" })], {
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
    });
    const started = Date.now();
    const result = await runSystemOne(executor, mixedConfig({ timeoutMs: 1_000 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("time budget");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });
});

// ─── Credentials ────────────────────────────────────────────

describe("SystemOneDecisionExecutor credentials", () => {
  test("reads only the global TYPESAFE_API_KEY swarm config row", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "TYPESAFE_API_KEY",
      value: API_KEY,
      isSecret: true,
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "TYPESAFE_API_KEY",
      value: "agent-scoped-key-must-not-be-used",
    });
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const executor = new SystemOneDecisionExecutor(deps, { fetch: transport });
    const result = await runSystemOne(executor, mixedConfig());

    expect(result.status).toBe("success");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  test("fails without a request when the key is absent, blank, or malformed", async () => {
    for (const lookup of [
      async () => null,
      async () => undefined,
      async () => "   ",
      async () => "bad\nkey",
    ]) {
      const { executor, calls } = makeExecutor([jsonResponse(mixedBody())], { getApiKey: lookup });
      const result = await runSystemOne(executor, mixedConfig());
      expect(result.status).toBe("failed");
      expect(result.error).toContain("TYPESAFE_API_KEY");
      expect(calls).toHaveLength(0);
    }

    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const noRow = await runSystemOne(
      new SystemOneDecisionExecutor(deps, { fetch: transport }),
      mixedConfig(),
    );
    expect(noRow.status).toBe("failed");
    expect(noRow.error).toContain("not configured");
    expect(calls).toHaveLength(0);
  });

  test("a lookup failure does not leak its cause", async () => {
    const { executor } = makeExecutor([jsonResponse(mixedBody())], {
      getApiKey: async () => {
        throw new Error("Failed to decrypt config 'TYPESAFE_API_KEY' (id=row-1)");
      },
    });
    const result = await runSystemOne(executor, mixedConfig());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Could not read TYPESAFE_API_KEY from swarm config");
  });

  test("the key never appears in outputs or errors, even if the provider echoes it", async () => {
    const echoed = makeExecutor(
      [jsonResponse({ error: { code: API_KEY, message: API_KEY } }, 500)],
      {
        random: () => 1,
      },
    );
    const failed = await runSystemOne(echoed.executor, mixedConfig({ maxRetries: 1 }));
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain(API_KEY);

    const ok = makeExecutor([jsonResponse(mixedBody())]);
    const succeeded = await runSystemOne(ok.executor, mixedConfig());
    expect(JSON.stringify(succeeded)).not.toContain(API_KEY);
  });
});

// ─── Registry, discovery, authoring ─────────────────────────

describe("system-one-decision registration and authoring", () => {
  test("registers as an async executor (it can wait for a reviewer) and derives discovery JSON Schemas", () => {
    const registry = createExecutorRegistry(deps);
    expect(registry.has("system-one-decision")).toBe(true);
    const info = registry.describe("system-one-decision");
    expect(info.type).toBe("system-one-decision");
    expect(info.mode).toBe("async");
    // The refinements and the discriminated union must survive JSON Schema conversion.
    const config = info.configSchema as { required?: string[] };
    expect(config.required).toEqual(expect.arrayContaining(["state", "questions", "returns"]));
    const output = info.outputSchema as { required?: string[] };
    expect(output.required).toEqual(expect.arrayContaining(["model", "answers", "usage"]));
    expect(() => registry.describeAll()).not.toThrow();
  });

  const qualifyNode = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
    id: "qualify",
    type: "system-one-decision",
    inputs: { lead: "trigger.lead" },
    config: mixedConfig({ state: "{{lead}}" }),
    ...overrides,
  });

  const validate = (node: WorkflowNode) =>
    validateDefinition({ nodes: [node] }, createExecutorRegistry(deps));

  test("accepts a node whose state and descriptions are interpolated", () => {
    const node = qualifyNode({
      config: mixedConfig({
        state: "{{lead}}",
        questions: {
          fit: {
            type: "noul",
            instructions: "Is {{lead.company}} a fit?",
            criteria: "{{criteria}}",
          },
        },
        returns: { fit: { type: "noul" } },
      }),
    });
    expect(validate(node)).toEqual({ valid: true, errors: [] });
  });

  test("reports a static returns/questions disagreement at authoring time", () => {
    const node = qualifyNode({
      config: mixedConfig({
        returns: {
          fit: { type: "score" },
          authority: { type: "choice" },
          urgency: { type: "score" },
        },
      }),
    });
    const result = validate(node);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("returns.fit.type");
  });

  test("requires questions and returns to be static objects", () => {
    const result = validate(qualifyNode({ config: mixedConfig({ questions: "{{qs}}" }) }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("config.questions must be an object");
  });

  test("rejects an engine retry policy or a validation retry on a system-one-decision node", () => {
    const withRetry = validate(
      qualifyNode({ retry: { maxRetries: 2, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 } }),
    );
    expect(withRetry.valid).toBe(false);
    expect(withRetry.errors.join("\n")).toContain("retry.maxRetries > 0");

    const withValidationRetry = validate(
      qualifyNode({
        validation: {
          executor: "validate",
          config: {},
          mustPass: true,
          retry: { maxRetries: 1, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
        },
      }),
    );
    expect(withValidationRetry.valid).toBe(false);
    expect(withValidationRetry.errors.join("\n")).toContain("validation.retry.maxRetries > 0");

    const zeroRetries = validate(
      qualifyNode({ retry: { maxRetries: 0, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 } }),
    );
    expect(zeroRetries).toEqual({ valid: true, errors: [] });
  });

  test("the retry rule applies to system-one-decision nodes only", () => {
    const node: WorkflowNode = {
      id: "x",
      type: "property-match",
      config: { conditions: [{ field: "a", op: "exists" }] },
      retry: { maxRetries: 3, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
    };
    expect(validate(node)).toEqual({ valid: true, errors: [] });
  });
});

// ─── Interpolation ──────────────────────────────────────────

describe("system-one-decision interpolation", () => {
  const node = (config: Record<string, unknown>) => ({
    type: "system-one-decision",
    config,
    inputs: {},
  });

  test("a whole-token state keeps its JSON type; mixed text stays a string", () => {
    const lead = { name: "Ada", tags: ["a", "b"], size: 12 };
    const whole = interpolateNodeConfig(node({ state: "{{lead}}" }), { lead });
    expect((whole.value as { state: unknown }).state).toEqual(lead);
    expect(whole.strictUnresolved).toEqual([]);

    const mixed = interpolateNodeConfig(node({ state: "Lead: {{lead.name}}" }), { lead });
    expect((mixed.value as { state: unknown }).state).toBe("Lead: Ada");
  });

  test("question descriptions can carry an object token", () => {
    const rubric = { buyer: "Approves spend", champion: "Influences" };
    const result = interpolateNodeConfig(
      node({
        state: "x",
        questions: {
          authority: { type: "choice", instructions: "Pick for {{name}}", criteria: "{{rubric}}" },
        },
      }),
      { rubric, name: "Ada" },
    );
    const questions = (
      result.value as { questions: Record<string, { criteria: unknown; instructions: string }> }
    ).questions;
    expect(questions.authority?.criteria).toEqual(rubric);
    expect(questions.authority?.instructions).toBe("Pick for Ada");
  });

  test("resolved content is not interpolated a second time", () => {
    const lead = { message: "Please call {{trigger.secret}} now" };
    const result = interpolateNodeConfig(node({ state: "{{lead}}" }), {
      lead,
      trigger: { secret: "LEAK" },
    });
    expect(JSON.stringify((result.value as { state: unknown }).state)).toContain(
      "{{trigger.secret}}",
    );
    expect(JSON.stringify(result.value)).not.toContain("LEAK");

    const mixed = interpolateNodeConfig(node({ state: "Msg: {{lead.message}}" }), {
      lead,
      trigger: { secret: "LEAK" },
    });
    expect((mixed.value as { state: string }).state).toBe(
      "Msg: Please call {{trigger.secret}} now",
    );
  });

  test("unresolved tokens anywhere in a system-one-decision config are strict", () => {
    const result = interpolateNodeConfig(
      node({
        model: "{{model}}",
        state: "{{lead}}",
        questions: { q: { type: "noul", instructions: "About {{lead.company}}" } },
      }),
      { lead: { name: "Ada" } },
    );
    expect(result.strictUnresolved?.sort()).toEqual(["lead.company", "model"]);
  });

  test("other node types do not get strict tokens", () => {
    const result = interpolateNodeConfig(
      { type: "raw-llm", config: { prompt: "{{missing}}" } },
      {},
    );
    expect(result.strictUnresolved).toBeUndefined();
  });
});

// ─── Engine integration ─────────────────────────────────────

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

function engineRegistry(decision: SystemOneDecisionExecutor): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(decision);
  registry.register(new PropertyMatchExecutor(deps));
  registry.register(new MarkerExecutor(deps));
  return registry;
}

async function makeWorkflow(definition: WorkflowDefinition): Promise<Workflow> {
  return createWorkflow({
    name: `jev-test-${crypto.randomUUID()}`,
    definition,
    createdByAgentId: agentId,
  });
}

/** qualify -> gate on authority confidence -> approved | human-review. */
const gatedDefinition = (qualify: Partial<WorkflowNode> = {}): WorkflowDefinition => ({
  nodes: [
    {
      id: "qualify",
      type: "system-one-decision",
      inputs: { lead: "trigger.lead" },
      config: mixedConfig({ state: "{{lead}}" }),
      next: "gate",
      ...qualify,
    },
    {
      id: "gate",
      type: "property-match",
      inputs: { qualification: "qualify" },
      config: {
        conditions: [
          { field: "qualification.answers.authority.confidence", op: "gt", value: 0.55 },
        ],
      },
      next: { true: "approved", false: "human-review" },
    },
    { id: "approved", type: "marker", config: { label: "approved" } },
    { id: "human-review", type: "marker", config: { label: "human" } },
  ],
});

describe("system-one-decision in the workflow engine", () => {
  test("downstream aliases route on the answer, including to human review", async () => {
    const trigger = { lead: { name: "Ada", message: "Need workflow tooling now" } };

    const confident = makeTransport([jsonResponse(mixedBody())]);
    const registryA = engineRegistry(
      new SystemOneDecisionExecutor(deps, {
        fetch: confident.transport,
        getApiKey: async () => API_KEY,
      }),
    );
    const runA = await startWorkflowExecution(
      await makeWorkflow(gatedDefinition()),
      trigger,
      registryA,
    );
    const stepsA = await getWorkflowRunStepsByRunId(runA);
    expect((await getWorkflowRun(runA))?.status).toBe("completed");
    expect(stepsA.map((s) => s.nodeId).sort()).toEqual(["approved", "gate", "qualify"]);
    // The whole-token lead reached the API as an object, not a JSON string.
    expect(confident.calls[0]?.body.state).toEqual(trigger.lead);
    const qualifyStep = stepsA.find((s) => s.nodeId === "qualify");
    expect(qualifyStep?.status).toBe("completed");
    expect((qualifyStep?.output as { usage: unknown }).usage).toEqual({
      input_tokens: 400,
      output_tokens: 80,
    });

    const unsure = makeTransport([
      jsonResponse(
        withAnswers({
          fit: noulAnswer,
          authority: { ...choiceAnswer, confidence: 0.4 },
          urgency: scoreAnswer,
        }),
      ),
    ]);
    const registryB = engineRegistry(
      new SystemOneDecisionExecutor(deps, {
        fetch: unsure.transport,
        getApiKey: async () => API_KEY,
      }),
    );
    const runB = await startWorkflowExecution(
      await makeWorkflow(gatedDefinition()),
      trigger,
      registryB,
    );
    const stepsB = await getWorkflowRunStepsByRunId(runB);
    expect((await getWorkflowRun(runB))?.status).toBe("completed");
    expect(stepsB.map((s) => s.nodeId).sort()).toEqual(["gate", "human-review", "qualify"]);
  });

  test("an unresolved reference stops the step before any request is sent", async () => {
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, getApiKey: async () => API_KEY }),
    );
    // `lead` is declared, but the trigger has no `lead`, so {{lead}} cannot resolve.
    const runId = await startWorkflowExecution(
      await makeWorkflow(gatedDefinition()),
      { other: true },
      registry,
    ).catch(async () => undefined);
    const runs = await getDbClient().query<{ id: string }>("SELECT id FROM workflow_runs");
    const id = runId ?? runs[0]?.id;
    const steps = await getWorkflowRunStepsByRunId(id as string);
    const qualify = steps.find((s) => s.nodeId === "qualify");

    expect(calls).toHaveLength(0);
    expect(qualify?.status).toBe("failed");
    expect(qualify?.error).toContain("{{lead}}");
    expect(qualify?.error).toContain("No request was sent");
    expect((await getWorkflowRun(id as string))?.status).toBe("failed");
  });

  test("a missing alias in a question description stops the step before any request", async () => {
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, getApiKey: async () => API_KEY }),
    );
    const definition = gatedDefinition({
      inputs: { lead: "trigger.lead" },
      config: mixedConfig({
        state: "{{lead}}",
        questions: { fit: { type: "noul", instructions: "Is {{company}} a fit?" } },
        returns: { fit: { type: "noul" } },
      }),
    });
    const runId = await startWorkflowExecution(
      await makeWorkflow(definition),
      { lead: { name: "Ada" } },
      registry,
    ).catch(() => undefined);
    const runs = await getDbClient().query<{ id: string }>("SELECT id FROM workflow_runs");
    const steps = await getWorkflowRunStepsByRunId((runId ?? runs[0]?.id) as string);

    expect(calls).toHaveLength(0);
    expect(steps.find((s) => s.nodeId === "qualify")?.error).toContain("{{company}}");
  });

  test("a stored definition with an engine retry policy fails before dispatch", async () => {
    const { calls, transport } = makeTransport([jsonResponse({}, 500)]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, getApiKey: async () => API_KEY }),
    );
    const definition = gatedDefinition({
      retry: { maxRetries: 3, strategy: "static", baseDelayMs: 0, maxDelayMs: 0 },
    });
    const runId = await startWorkflowExecution(
      await makeWorkflow(definition),
      { lead: { name: "Ada" } },
      registry,
    ).catch(() => undefined);
    const runs = await getDbClient().query<{ id: string }>("SELECT id FROM workflow_runs");
    const id = (runId ?? runs[0]?.id) as string;
    const qualify = (await getWorkflowRunStepsByRunId(id)).find((s) => s.nodeId === "qualify");

    expect(calls).toHaveLength(0);
    expect(qualify?.status).toBe("failed");
    expect(qualify?.error).toContain("retry.maxRetries > 0");
    expect(qualify?.retryCount ?? 0).toBe(0);
    expect(qualify?.nextRetryAt ?? null).toBeNull();
  });

  test("a 401 fails the run after one attempt with nothing scheduled for retry", async () => {
    const { calls, transport } = makeTransport([
      jsonResponse({ error: { code: "unauthorized" } }, 401),
    ]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, getApiKey: async () => API_KEY }),
    );
    const runId = await startWorkflowExecution(
      await makeWorkflow(gatedDefinition()),
      { lead: { name: "Ada" } },
      registry,
    ).catch(() => undefined);
    const runs = await getDbClient().query<{ id: string }>("SELECT id FROM workflow_runs");
    const id = (runId ?? runs[0]?.id) as string;
    const steps = await getWorkflowRunStepsByRunId(id);
    const qualify = steps.find((s) => s.nodeId === "qualify");

    expect(calls).toHaveLength(1);
    expect(qualify?.status).toBe("failed");
    expect(qualify?.error).toContain("HTTP 401");
    expect(qualify?.nextRetryAt ?? null).toBeNull();
    expect(steps.map((s) => s.nodeId)).toEqual(["qualify"]);
    expect((await getWorkflowRun(id))?.status).toBe("failed");
    expect(JSON.stringify(steps)).not.toContain(API_KEY);
  });
});

// ─── Providers ──────────────────────────────────────────────

const OPENROUTER_KEY = "sk-or-example-jev-test-key-0123456789";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

/** OpenRouter's decisions body: the same contract plus id, provider, and usage.cost. */
const openRouterBody = () =>
  mixedBody({
    model: "typesafe/jev-1.13-20260917",
    id: "gen-dec-1790686228-example",
    provider: "TypeSafe",
    usage: { input_tokens: 418, output_tokens: 61, cost: 0.000017556 },
  });

function makeOpenRouterExecutor(steps: TransportStep[], env: NodeJS.ProcessEnv = {}) {
  const { calls, transport } = makeTransport(steps);
  const executor = new SystemOneDecisionExecutor(deps, {
    fetch: transport,
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY, ...env },
    sleep: async () => {},
    random: () => 1,
  });
  return { executor, calls };
}

describe("system-one-decision providers", () => {
  test("a definition can name only a listed provider and carries no endpoint, header, or key", () => {
    for (const evil of ["https://evil.example", "typesafe.ai", "", "constructor"]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig({ provider: evil })).success).toBe(
        false,
      );
    }
    // A definition cannot carry an endpoint, header, or key.
    for (const field of ["endpoint", "url", "headers", "apiKey"]) {
      expect(SystemOneDecisionConfigSchema.safeParse(mixedConfig({ [field]: "x" })).success).toBe(
        false,
      );
    }
  });

  test("provider must be a literal, not a token that could change the checked key", () => {
    const registry = createExecutorRegistry(deps);
    const node = (provider: string): WorkflowNode => ({
      id: "qualify",
      type: "system-one-decision",
      inputs: { p: "trigger.p" },
      config: mixedConfig({ provider }),
    });
    const bad = validateDefinition({ nodes: [node("{{p}}")] }, registry);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(";")).toContain("config.provider must be a literal");
    expect(validateDefinition({ nodes: [node("openrouter")] }, registry).valid).toBe(true);
  });

  test("typesafe sends to the TypeSafe host with the TypeSafe default model and no provider field", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(mixedBody())]);
    const result = await runSystemOne(executor, mixedConfig({ model: undefined }));

    expect(result.status).toBe("success");
    expect(calls[0]?.url).toBe(SYSTEM_ONE_ENDPOINT);
    expect(calls[0]?.body.model).toBe("jev-latest");
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["model", "questions", "state"]);
  });

  test("openrouter sends the same request to the decisions endpoint with the OpenRouter key", async () => {
    const { executor, calls } = makeOpenRouterExecutor([jsonResponse(openRouterBody())]);
    const config = mixedConfig({ provider: "openrouter", model: undefined });
    const result = await runSystemOne(executor, config);

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(OPENROUTER_ENDPOINT);
    expect(call.init.redirect).toBe("manual");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${OPENROUTER_KEY}`,
    );
    // Same wire body as TypeSafe: no `provider`, no `returns`.
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    expect(call.body.model).toBe("~typesafe/jev-latest");
    expect(call.body.questions).toEqual(config.questions as object);
    // The typed contract holds on this path: one validated answer per question.
    expect(Object.keys(result.output?.answers ?? {}).sort()).toEqual([
      "authority",
      "fit",
      "urgency",
    ]);
    expect(result.output?.model).toBe("typesafe/jev-1.13-20260917");
    expect(JSON.stringify(result)).not.toContain(OPENROUTER_KEY);
  });

  test("openrouter passes an explicit model slug through", async () => {
    const { executor, calls } = makeOpenRouterExecutor([jsonResponse(openRouterBody())]);
    await runSystemOne(
      executor,
      mixedConfig({ provider: "openrouter", model: "typesafe/jev-1.13" }),
    );
    expect(calls[0]?.body.model).toBe("typesafe/jev-1.13");
  });

  test("openrouter fails the same answer contract as typesafe", async () => {
    const { executor } = makeOpenRouterExecutor([
      jsonResponse(withAnswers({ fit: noulAnswer, authority: choiceAnswer })),
    ]);
    const result = await runSystemOne(executor, mixedConfig({ provider: "openrouter" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain('missing the answer for question "urgency"');
  });

  test("openrouter never falls through to OPENAI_API_KEY", async () => {
    const { calls, transport } = makeTransport([jsonResponse(openRouterBody())]);
    const executor = new SystemOneDecisionExecutor(deps, {
      fetch: transport,
      env: { OPENAI_API_KEY: "sk-openai-example-0123456789" },
    });
    const result = await runSystemOne(executor, mixedConfig({ provider: "openrouter" }));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("OPENROUTER_API_KEY is not configured");
    expect(result.error).not.toContain("OPENAI_API_KEY");
    expect(calls).toHaveLength(0);
  });

  test("openrouter refuses a gateway base URL instead of sending the key there", async () => {
    const { executor, calls } = makeOpenRouterExecutor([jsonResponse(openRouterBody())], {
      OPENROUTER_BASE_URL: "https://gateway.example.test/proxy/v1",
    });
    const result = await runSystemOne(executor, mixedConfig({ provider: "openrouter" }));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("OPENROUTER_BASE_URL");
    expect(calls).toHaveLength(0);
    expect(
      await executor.checkReadiness([{ id: "n", config: { provider: "openrouter" } }]),
    ).toEqual([{ nodeIds: ["n"], message: expect.stringContaining("OPENROUTER_BASE_URL") }]);
  });

  test("each provider reads only its own key", async () => {
    // TypeSafe key present, OpenRouter key absent.
    await upsertSwarmConfig({
      scope: "global",
      key: "TYPESAFE_API_KEY",
      value: API_KEY,
      isSecret: true,
    });
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const executor = new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} });

    const viaOpenRouter = await runSystemOne(executor, mixedConfig({ provider: "openrouter" }));
    expect(viaOpenRouter.error).toContain("OPENROUTER_API_KEY");
    expect(calls).toHaveLength(0);

    const viaTypeSafe = await runSystemOne(executor, mixedConfig({ provider: "typesafe" }));
    expect(viaTypeSafe.status).toBe("success");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );

    // OpenRouter key present, TypeSafe row absent.
    await getDbClient().run("DELETE FROM swarm_config WHERE key = 'TYPESAFE_API_KEY'");
    const { calls: orCalls, transport: orTransport } = makeTransport([
      jsonResponse(openRouterBody()),
    ]);
    const orExecutor = new SystemOneDecisionExecutor(deps, {
      fetch: orTransport,
      env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
    });
    const viaTypeSafeMissing = await runSystemOne(
      orExecutor,
      mixedConfig({ provider: "typesafe" }),
    );
    expect(viaTypeSafeMissing.error).toContain("TYPESAFE_API_KEY is not configured");
    expect(orCalls).toHaveLength(0);
  });
});

// ─── Rejected key ───────────────────────────────────────────

describe("a key the host rejects", () => {
  test("a 401 or 403 says the named key was rejected, once, never retried", async () => {
    for (const status of [401, 403]) {
      const { executor, calls, sleeps } = makeExecutor([
        jsonResponse({ detail: { error_type: "authentication_error", message: API_KEY } }, status),
      ]);
      const result = await runSystemOne(executor, mixedConfig({ maxRetries: 3 }));

      expect(result.status).toBe("failed");
      expect(result.error).toContain(`TYPESAFE_API_KEY was rejected by TypeSafe (HTTP ${status}`);
      expect(result.error).toContain("(authentication_error)");
      expect(result.error).toContain("Secrets page");
      expect(calls).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
      // The host echoed the key in its body; nothing of it reaches the error.
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
  });

  test("the rejection names the provider that was used", async () => {
    const { executor, calls } = makeOpenRouterExecutor([
      jsonResponse({ error: { message: OPENROUTER_KEY, code: 401 } }, 401),
    ]);
    const result = await runSystemOne(
      executor,
      mixedConfig({ provider: "openrouter", maxRetries: 3 }),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("OPENROUTER_API_KEY was rejected by OpenRouter (HTTP 401");
    expect(result.error).not.toContain("TYPESAFE_API_KEY");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(OPENROUTER_KEY);
  });

  test("other failures keep the generic message, not the key-rejected one", async () => {
    for (const status of [400, 402, 422, 500]) {
      const { executor } = makeExecutor([jsonResponse({ error: { code: "boom" } }, status)]);
      const result = await runSystemOne(executor, mixedConfig({ maxRetries: 0 }));
      expect(result.error).toContain(`SystemOne API returned HTTP ${status}`);
      expect(result.error).not.toContain("was rejected");
    }
  });
});

// ─── Readiness (before first use) ───────────────────────────

describe("system-one-decision readiness before first use", () => {
  test("no problem when the key is present", async () => {
    const { executor } = makeExecutor([jsonResponse(mixedBody())]);
    expect(await executor.checkReadiness([{ id: "a", config: mixedConfig() }])).toEqual([]);
  });

  test("names the exact key for the provider each node uses", async () => {
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const executor = new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} });
    const problems = await executor.checkReadiness([
      { id: "a", config: mixedConfig() },
      { id: "b", config: mixedConfig({ provider: "openrouter" }) },
      { id: "c", config: mixedConfig({ provider: "typesafe" }) },
      { id: "d", config: mixedConfig({ provider: "no-such-provider" }) },
    ]);

    expect(problems).toHaveLength(2);
    const typesafe = problems.find((p) => p.message.startsWith("TYPESAFE_API_KEY"));
    const openrouter = problems.find((p) => p.message.startsWith("OPENROUTER_API_KEY"));
    expect(typesafe?.nodeIds).toEqual(["a", "c"]);
    expect(openrouter?.nodeIds).toEqual(["b"]);
    for (const problem of problems) {
      expect(problem.message).toContain("Secrets page");
      expect(problem.message).toContain("not configured");
    }
    // Readiness never calls the provider.
    expect(calls).toHaveLength(0);
  });

  test("blank and malformed keys are not ready", async () => {
    for (const key of ["   ", "bad\nkey"]) {
      const { executor } = makeExecutor([jsonResponse(mixedBody())], {
        getApiKey: async () => key,
      });
      const problems = await executor.checkReadiness([{ id: "a", config: mixedConfig() }]);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.message).toContain("TYPESAFE_API_KEY");
      expect(JSON.stringify(problems)).not.toContain("bad");
    }
  });

  test("a config row that cannot be read is reported without its cause", async () => {
    const { executor } = makeExecutor([jsonResponse(mixedBody())], {
      getApiKey: async () => {
        throw new Error("Failed to decrypt config 'TYPESAFE_API_KEY' (id=row-1)");
      },
    });
    const problems = await executor.checkReadiness([{ id: "a", config: mixedConfig() }]);
    expect(problems[0]?.message).toBe("Could not read TYPESAFE_API_KEY from swarm config");
  });

  test("a workflow with no system-one-decision node is ready without asking anyone", async () => {
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { getApiKey: async () => null }),
    );
    expect(
      await findWorkflowReadinessProblems(
        { nodes: [{ id: "m", type: "marker", config: { label: "x" } }] },
        registry,
      ),
    ).toEqual([]);
  });

  test("a save warning names the key, where to set it, the node, and the consequence", async () => {
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { getApiKey: async () => null }),
    );
    const warnings = await workflowSaveWarnings(gatedDefinition(), registry);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TYPESAFE_API_KEY is not configured");
    expect(warnings[0]).toContain("Secrets page");
    expect(warnings[0]).toContain('system-one-decision node "qualify"');
    expect(warnings[0]).toContain("fail before any node executes");

    const ready = engineRegistry(
      new SystemOneDecisionExecutor(deps, { getApiKey: async () => API_KEY }),
    );
    expect(await workflowSaveWarnings(gatedDefinition(), ready)).toEqual([]);
  });

  test("a readiness check that throws becomes a problem, never an exception", async () => {
    class ThrowingExecutor extends MarkerExecutor {
      override async checkReadiness(): Promise<never> {
        throw new Error("boom with secret-detail");
      }
    }
    const registry = new ExecutorRegistry();
    registry.register(new ThrowingExecutor(deps));
    const problems = await findWorkflowReadinessProblems(
      { nodes: [{ id: "m", type: "marker", config: { label: "x" } }] },
      registry,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).not.toContain("secret-detail");
  });
});

// ─── Run start ──────────────────────────────────────────────

/** A marker runs first, so a run that started would leave a step behind. */
const markerThenSystemOne = (overrides: Partial<WorkflowNode> = {}): WorkflowDefinition => ({
  nodes: [
    { id: "before", type: "marker", config: { label: "side effect" }, next: "qualify" },
    {
      id: "qualify",
      type: "system-one-decision",
      config: mixedConfig(),
      next: "after",
      ...overrides,
    },
    { id: "after", type: "marker", config: { label: "done" } },
  ],
});

describe("run start with a system-one-decision node", () => {
  test("a missing key fails the run before any node executes", async () => {
    // Default key lookup (the swarm config row) with no row present.
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} }),
    );
    const runId = await startWorkflowExecution(
      await makeWorkflow(markerThenSystemOne()),
      {},
      registry,
    );

    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.finishedAt).toBeTruthy();
    expect(run?.error).toContain("Run not started, no node executed");
    expect(run?.error).toContain("TYPESAFE_API_KEY is not configured");
    expect(run?.error).toContain("Secrets page");
    expect(run?.error).toContain('system-one-decision node "qualify"');
    // Not even the marker ahead of the system-one-decision node ran, and nothing was sent.
    expect(await getWorkflowRunStepsByRunId(runId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("the error names the key of the provider the node uses", async () => {
    const { calls, transport } = makeTransport([jsonResponse(openRouterBody())]);
    // A TypeSafe key exists; the node asks for OpenRouter, which has none.
    await upsertSwarmConfig({
      scope: "global",
      key: "TYPESAFE_API_KEY",
      value: API_KEY,
      isSecret: true,
    });
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} }),
    );
    const runId = await startWorkflowExecution(
      await makeWorkflow(markerThenSystemOne({ config: mixedConfig({ provider: "openrouter" }) })),
      {},
      registry,
    );

    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("OPENROUTER_API_KEY is not configured");
    expect(run?.error).not.toContain("TYPESAFE_API_KEY");
    expect(await getWorkflowRunStepsByRunId(runId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("with the key configured the same definition runs to completion", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "TYPESAFE_API_KEY",
      value: API_KEY,
      isSecret: true,
    });
    const { calls, transport } = makeTransport([jsonResponse(mixedBody())]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} }),
    );
    const runId = await startWorkflowExecution(
      await makeWorkflow(markerThenSystemOne()),
      {},
      registry,
    );

    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect((await getWorkflowRunStepsByRunId(runId)).map((s) => s.nodeId).sort()).toEqual([
      "after",
      "before",
      "qualify",
    ]);
    expect(calls).toHaveLength(1);
  });

  test("a definition without a system-one-decision node starts whether or not any key exists", async () => {
    const registry = engineRegistry(new SystemOneDecisionExecutor(deps, { env: {} }));
    const runId = await startWorkflowExecution(
      await makeWorkflow({ nodes: [{ id: "only", type: "marker", config: { label: "x" } }] }),
      {},
      registry,
    );
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
  });

  test("a rejected key then a rotated key: retry is refused while the key is gone, then succeeds", async () => {
    const upsertKey = () =>
      upsertSwarmConfig({
        scope: "global",
        key: "TYPESAFE_API_KEY",
        value: API_KEY,
        isSecret: true,
      });
    await upsertKey();
    const { calls, transport } = makeTransport([
      jsonResponse({ detail: { error_type: "authentication_error" } }, 401),
      jsonResponse(mixedBody()),
    ]);
    const registry = engineRegistry(
      new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} }),
    );
    const runId = await startWorkflowExecution(
      await makeWorkflow(markerThenSystemOne()),
      {},
      registry,
    );

    // Distinct rejected-key error on the step; the marker ahead of it did run.
    const failedRun = await getWorkflowRun(runId);
    const qualify = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "qualify");
    expect(failedRun?.status).toBe("failed");
    expect(qualify?.error).toContain("TYPESAFE_API_KEY was rejected by TypeSafe (HTTP 401");
    expect(calls).toHaveLength(1);

    // Key removed: the retry is refused up front and the run stays failed.
    await getDbClient().run("DELETE FROM swarm_config WHERE key = 'TYPESAFE_API_KEY'");
    await expect(retryFailedRun(runId, registry)).rejects.toThrow(
      /Retry not started, run left failed: TYPESAFE_API_KEY is not configured/,
    );
    expect((await getWorkflowRun(runId))?.status).toBe("failed");
    expect(calls).toHaveLength(1);

    // Key replaced: the retry goes through.
    await upsertKey();
    await retryFailedRun(runId, registry);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect(calls).toHaveLength(2);
  });
});

// ─── The skill's key probe ──────────────────────────────────

describe("the workflow-iterate key probe", () => {
  test("the probe definition in the skill validates and makes exactly one one-question call", async () => {
    const skill = await Bun.file(
      new URL("../../templates/skills/workflow-iterate/content.md", import.meta.url).pathname,
    ).text();
    const blocks = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
    const probe = blocks.find((block) => block.includes('"id": "ping"'));
    expect(probe).toBeDefined();
    const definition = JSON.parse(probe as string) as WorkflowDefinition;

    const registry = createExecutorRegistry(deps);
    expect(validateDefinition(definition, registry)).toEqual({ valid: true, errors: [] });

    const { calls, transport } = makeTransport([
      jsonResponse(withAnswers({ ping: noulAnswer }, { model: "jev-1.13.0" })),
    ]);
    const node = definition.nodes[0] as WorkflowNode;
    const result = await new SystemOneDecisionExecutor(deps, {
      fetch: transport,
      getApiKey: async () => API_KEY,
    }).run({ config: node.config, context: {}, meta: meta("ping") });

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]?.body.questions as object)).toEqual(["ping"]);
  });
});
