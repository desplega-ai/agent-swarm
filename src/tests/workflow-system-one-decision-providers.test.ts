import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import type { WorkflowNode } from "../types";
import { validateDefinition } from "../workflows/definition";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import {
  SystemOneDecisionConfigSchema,
  SystemOneDecisionExecutor,
  type SystemOneDecisionExecutorOptions,
} from "../workflows/executors/system-one-decision";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-system-one-decision-providers.sqlite";
// Shaped like tokens but obviously fake; they must never appear in any output or error.
const OPENAI_KEY = "sk-decisions-example-test-key-0123456789";
const CF_TOKEN = "cf-example-test-token-0123456789abcdef";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/cloudflare`;

let deps: ExecutorDependencies;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
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
  await getDbClient().run(
    "DELETE FROM swarm_config WHERE key IN ('OPENAI_API_KEY', 'OPENAI_DECISIONS_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN')",
  );
});

// ─── Harness ────────────────────────────────────────────────

type TransportStep = Response | Error;

interface RecordedCall {
  url: string;
  init: RequestInit;
  raw: string;
  body: Record<string, unknown>;
}

function makeTransport(steps: TransportStep[]) {
  const calls: RecordedCall[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    const raw = String(init?.body ?? "{}");
    calls.push({
      url: String(input),
      init: init ?? {},
      raw,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    if (step instanceof Error) throw step;
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

/** Injected credentials: OpenAI key, Cloudflare token, and the Cloudflare account id. */
function makeExecutor(steps: TransportStep[], options: SystemOneDecisionExecutorOptions = {}) {
  const { calls, transport } = makeTransport(steps);
  const sleeps: number[] = [];
  const executor = new SystemOneDecisionExecutor(deps, {
    fetch: transport,
    env: {},
    getApiKey: async (id) => (id === "openai" ? OPENAI_KEY : id === "cloudflare" ? CF_TOKEN : null),
    getServerUrl: async (id) => (id === "cloudflare" ? CF_ACCOUNT : null),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    ...options,
  });
  return { executor, calls, sleeps };
}

function run(executor: SystemOneDecisionExecutor, config: Record<string, unknown>) {
  return executor.run({
    config,
    context: {},
    meta: {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "classify",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    },
  });
}

// ─── Fixtures ───────────────────────────────────────────────

const questions = {
  urgent: {
    type: "noul",
    instructions: "Is this request urgent?",
    criteria: { true: "Customers are blocked now", false: "No customer impact" },
  },
  team: {
    type: "choice",
    instructions: "Which team should handle it?",
    criteria: { billing: "Payments and refunds", technical: null, sales: { plans: "upgrades" } },
  },
  severity: {
    type: "score",
    instructions: "How severe is the customer impact?",
    criteria: ["No impact", null, { level: "critical" }],
  },
};

const returns = { urgent: { type: "noul" }, team: { type: "choice" }, severity: { type: "score" } };

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: { ticket: { body: "Checkout has been failing for every customer for an hour." } },
    questions,
    returns,
    ...overrides,
  };
}

const systemOneAnswers = {
  urgent: { type: "noul", noul: 0.97 },
  team: {
    type: "choice",
    choice: "technical",
    probabilities: { billing: 0.05, technical: 0.9, sales: 0.05 },
    confidence: 0.81,
  },
  severity: {
    type: "score",
    score: 1.8,
    legend: { "0": "No impact", "1": null, "2": { level: "critical" } },
    probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 },
    confidence: 0.7,
  },
};

/** Clef's output schema (Workers AI `schema-output.json`) inside the REST envelope. */
const clefEnvelope = (result: Record<string, unknown> = {}) => ({
  result: {
    model: "clef",
    answers: systemOneAnswers,
    usage: { input_tokens: 120, output_tokens: 0 },
    ...result,
  },
  success: true,
  errors: [],
  messages: [],
});

/** An OpenAI Decisions body for `questions`, in a different order than asked. */
const openaiBody = (overrides: Record<string, unknown> = {}) => ({
  model: "gpt-6-luna",
  answers: [
    {
      type: "score",
      name: "severity",
      score: 1.8,
      probabilities: [
        { value: 0, label: "No impact", probability: 0.05 },
        { value: 1, label: "1", probability: 0.1 },
        { value: 2, label: '{"level":"critical"}', probability: 0.85 },
      ],
      confidence: 0.7,
    },
    { type: "predicate", name: "urgent", probability: 0.97 },
    {
      type: "choice",
      name: "team",
      choice: "technical",
      probabilities: [
        { value: "billing", probability: 0.05 },
        { value: "technical", probability: 0.9 },
        { value: "sales", probability: 0.05 },
      ],
      confidence: 0.81,
    },
  ],
  usage: { input_tokens: 210, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
  ...overrides,
});

// ─── Cloudflare ─────────────────────────────────────────────

describe("system-one-decision cloudflare provider", () => {
  test("sends the SystemOne request to the Workers AI run route for clef", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope())]);
    const cfg = config({ provider: "cloudflare" });
    const result = await run(executor, cfg);

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${CF_BASE}/clef`);
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${CF_TOKEN}`);
    expect(call.init.redirect).toBe("manual");
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    expect(call.body.model).toBe("clef");
    expect(call.body.state).toEqual(cfg.state as object);
    expect(call.body.questions).toEqual(questions);
    // The envelope is unwrapped into the same output every provider returns.
    expect(result.output).toEqual({
      model: "clef",
      answers: systemOneAnswers as never,
      usage: { input_tokens: 120, output_tokens: 0 },
    });
  });

  test("model clef-flash changes both the URL and the body", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope({ model: "clef-flash" }))]);
    const result = await run(executor, config({ provider: "cloudflare", model: "clef-flash" }));
    expect(result.status).toBe("success");
    expect(calls[0]?.url).toBe(`${CF_BASE}/clef-flash`);
    expect(calls[0]?.body.model).toBe("clef-flash");
  });

  test("a model outside clef / clef-flash fails at save and at run, and nothing is sent", async () => {
    expect(
      SystemOneDecisionConfigSchema.safeParse(config({ provider: "cloudflare", model: "llama" }))
        .success,
    ).toBe(false);

    const registry = createExecutorRegistry(deps);
    const node = (model: string): WorkflowNode => ({
      id: "classify",
      type: "system-one-decision",
      inputs: { m: "trigger.m" },
      config: config({ provider: "cloudflare", model }),
    });
    const literal = validateDefinition({ nodes: [node("../../evil")] }, registry);
    expect(literal.valid).toBe(false);
    expect(literal.errors.join(";")).toContain('provider "cloudflare" serves only the models');
    // A token is checked when the run resolves it.
    expect(validateDefinition({ nodes: [node("{{m}}")] }, registry).valid).toBe(true);

    const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope())]);
    const result = await run(executor, config({ provider: "cloudflare", model: "../../evil" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("serves only the models clef, clef-flash");
    expect(calls).toHaveLength(0);
  });

  test("other providers keep accepting any model id", () => {
    for (const provider of ["typesafe", "openrouter", "laya", "openai"]) {
      expect(
        SystemOneDecisionConfigSchema.safeParse(config({ provider, model: "anything-1" })).success,
      ).toBe(true);
    }
  });

  test("64 questions pass and 65 fail at save for cloudflare only", () => {
    const many = (count: number) => {
      const qs: Record<string, unknown> = {};
      const rs: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        qs[`q${i}`] = { type: "noul", instructions: `Question ${i}?` };
        rs[`q${i}`] = { type: "noul" };
      }
      return { questions: qs, returns: rs };
    };
    expect(
      SystemOneDecisionConfigSchema.safeParse(config({ provider: "cloudflare", ...many(64) }))
        .success,
    ).toBe(true);
    const over = SystemOneDecisionConfigSchema.safeParse(
      config({ provider: "cloudflare", ...many(65) }),
    );
    expect(over.success).toBe(false);
    expect(over.error?.message).toContain("at most 64 questions per node; this node has 65");
    expect(SystemOneDecisionConfigSchema.safeParse(config({ ...many(65) })).success).toBe(true);
  });

  test("success: false fails the step with Cloudflare's numeric error code", async () => {
    const { executor } = makeExecutor([
      jsonResponse({ result: null, success: false, errors: [{ code: 5007, message: "x" }] }),
    ]);
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Cloudflare Workers AI reported a failed run (5007)");
  });

  test("an envelope without a result fails validation", async () => {
    const { executor } = makeExecutor([jsonResponse({ success: true, errors: [] })]);
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "SystemOne response failed validation: Cloudflare response is missing its result",
    );
  });

  test("a result that breaks the answer contract fails like any provider", async () => {
    const { executor } = makeExecutor([
      jsonResponse(
        clefEnvelope({
          answers: {
            ...systemOneAnswers,
            team: { ...systemOneAnswers.team, choice: "marketing" },
          },
        }),
      ),
    ]);
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain('answer "team".choice is not one of the declared options');
  });

  test("a missing account id and token are named together in one message", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope())], {
      getApiKey: async () => null,
      getServerUrl: async () => null,
    });
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("CLOUDFLARE_ACCOUNT_ID is not configured");
    expect(result.error).toContain("the 32-character id of a Cloudflare account");
    expect(result.error).toContain("CLOUDFLARE_API_TOKEN is not configured");
    expect(calls).toHaveLength(0);
  });

  test("a malformed account id is refused and not echoed", async () => {
    for (const bad of ["acct/../../other", "0123456789ABCDEF0123456789ABCDEF", "abc"]) {
      const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope())], {
        getServerUrl: async () => bad,
      });
      const result = await run(executor, config({ provider: "cloudflare" }));
      expect(result.status).toBe("failed");
      expect(result.error).toContain(
        "CLOUDFLARE_ACCOUNT_ID is not the 32-character id of a Cloudflare account",
      );
      expect(result.error).not.toContain(bad);
      expect(calls).toHaveLength(0);
    }
  });

  test("the default lookups read CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from global config", async () => {
    await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_TOKEN",
      value: CF_TOKEN,
      isSecret: true,
    });
    const { executor, calls } = makeExecutor([jsonResponse(clefEnvelope())], {
      getApiKey: undefined,
      getServerUrl: undefined,
    });
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("success");
    expect(calls[0]?.url).toBe(`${CF_BASE}/clef`);
    expect(
      await executor.checkReadiness([{ id: "a", config: config({ provider: "cloudflare" }) }]),
    ).toEqual([]);
  });

  test("a 401 names CLOUDFLARE_API_TOKEN, surfaces the envelope code, and is not retried", async () => {
    const { executor, calls } = makeExecutor([
      jsonResponse(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        401,
      ),
    ]);
    const result = await run(executor, config({ provider: "cloudflare", maxRetries: 3 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      "CLOUDFLARE_API_TOKEN was rejected by Cloudflare Workers AI (HTTP 401 (10000))",
    );
    expect(calls).toHaveLength(1);
  });

  test("429 and 5xx retry and honor Retry-After", async () => {
    const { executor, calls, sleeps } = makeExecutor([
      jsonResponse({ success: false, errors: [{ code: 3040 }] }, 429, { "retry-after": "2" }),
      jsonResponse({ success: false, errors: [] }, 503),
      jsonResponse(clefEnvelope()),
    ]);
    const result = await run(executor, config({ provider: "cloudflare", maxRetries: 2 }));
    expect(result.status).toBe("success");
    expect(calls).toHaveLength(3);
    expect(sleeps[0]).toBe(2000);
  });

  test("the cf-ray header becomes the requestId", async () => {
    const { executor } = makeExecutor([
      jsonResponse(clefEnvelope(), 200, { "cf-ray": "8c1a2b3c4d5e6f70-MAD" }),
    ]);
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.output?.requestId).toBe("8c1a2b3c4d5e6f70-MAD");
  });

  test("the token never appears in output or errors, even when echoed", async () => {
    const { executor } = makeExecutor([
      jsonResponse({ success: false, errors: [{ code: CF_TOKEN }] }, 400),
    ]);
    const result = await run(executor, config({ provider: "cloudflare" }));
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(CF_TOKEN);
  });
});

// ─── OpenAI ─────────────────────────────────────────────────

describe("system-one-decision openai provider", () => {
  test("translates a mixed node into the Decisions request", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(openaiBody())]);
    const result = await run(executor, config({ provider: "openai" }));

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/decisions");
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${OPENAI_KEY}`,
    );
    expect(call.body).toEqual({
      model: "gpt-6-luna",
      input: '{"ticket":{"body":"Checkout has been failing for every customer for an hour."}}',
      questions: [
        {
          type: "predicate",
          name: "urgent",
          instructions:
            "Is this request urgent?\n\nTrue when: Customers are blocked now\n\nFalse when: No customer impact",
        },
        {
          type: "choice",
          name: "team",
          instructions: "Which team should handle it?",
          choices: [
            { value: "billing", description: "Payments and refunds" },
            { value: "technical" },
            { value: "sales", description: '{"plans":"upgrades"}' },
          ],
        },
        {
          type: "score",
          name: "severity",
          instructions: "How severe is the customer impact?",
          levels: [{ label: "No impact" }, { label: "1" }, { label: '{"level":"critical"}' }],
        },
      ],
    });
  });

  test("string and string[] state become text input", async () => {
    const asString = makeExecutor([jsonResponse(openaiBody())]);
    await run(asString.executor, config({ provider: "openai", state: "Charged twice." }));
    expect(asString.calls[0]?.body.input).toBe("Charged twice.");

    const asList = makeExecutor([jsonResponse(openaiBody())]);
    await run(asList.executor, config({ provider: "openai", state: ["first", "second"] }));
    expect(asList.calls[0]?.body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "first" },
          { type: "input_text", text: "second" },
        ],
      },
    ]);
  });

  test("answers returned out of order map by name to the standard output", async () => {
    const { executor } = makeExecutor([
      jsonResponse(openaiBody(), 200, { "x-request-id": "req_abc123" }),
    ]);
    const result = await run(executor, config({ provider: "openai" }));
    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      model: "gpt-6-luna",
      answers: systemOneAnswers as never,
      usage: { input_tokens: 210, output_tokens: 0 },
      requestId: "req_abc123",
    });
  });

  test("the guide's predicate, choice, and score examples map to SystemOne answers", async () => {
    const guide = {
      questions: {
        visible_damage: { type: "noul", instructions: "Does the product have visible damage?" },
        department: {
          type: "choice",
          instructions: "Which department should handle this complaint?",
          criteria: {
            billing: "Payments, invoices, and refunds.",
            technical: "Problems using the product.",
            shipping: "Delivery and tracking.",
            other: "Requests outside these categories.",
          },
        },
        severity: {
          type: "score",
          instructions: "How damaged is this package?",
          criteria: ["Cosmetic", "Workaround available", "Fully blocked"],
        },
      },
      returns: {
        visible_damage: { type: "noul" },
        department: { type: "choice" },
        severity: { type: "score" },
      },
    };
    // Verbatim answer excerpts from the OpenAI Decisions guide.
    const body = {
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", name: "visible_damage", probability: 0.92 },
        {
          type: "choice",
          name: "department",
          choice: "billing",
          probabilities: [
            { value: "billing", probability: 0.95 },
            { value: "technical", probability: 0.02 },
            { value: "shipping", probability: 0.01 },
            { value: "other", probability: 0.02 },
          ],
          confidence: 0.93,
        },
        {
          type: "score",
          name: "severity",
          score: 1.1,
          probabilities: [
            { value: 0, label: "Cosmetic", probability: 0.1 },
            { value: 1, label: "Workaround available", probability: 0.7 },
            { value: 2, label: "Fully blocked", probability: 0.2 },
          ],
          confidence: 0.55,
        },
      ],
      usage: { input_tokens: 64, output_tokens: 0 },
    };
    const { executor } = makeExecutor([jsonResponse(body)]);
    const result = await run(executor, config({ provider: "openai", ...guide }));
    expect(result.status).toBe("success");
    expect(result.output?.answers).toEqual({
      visible_damage: { type: "noul", noul: 0.92 },
      department: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.95, technical: 0.02, shipping: 0.01, other: 0.02 },
        confidence: 0.93,
      },
      severity: {
        type: "score",
        score: 1.1,
        legend: { "0": "Cosmetic", "1": "Workaround available", "2": "Fully blocked" },
        probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
        confidence: 0.55,
      },
    });
  });

  test("a refusal fails the step by question name and is not retried", async () => {
    const body = openaiBody();
    body.answers[1] = { type: "refusal", name: "urgent" } as never;
    const { executor, calls } = makeExecutor([jsonResponse(body)]);
    const result = await run(executor, config({ provider: "openai", maxRetries: 3 }));
    expect(result.status).toBe("failed");
    expect(result.error).toBe('OpenAI refused question "urgent"; no decision was made');
    expect(calls).toHaveLength(1);
  });

  test("probabilities that do not sum to 1 fail with the shared message", async () => {
    const body = openaiBody();
    (body.answers[2] as { probabilities: { probability: number }[] })
      .probabilities[0]!.probability = 0.5;
    const { executor } = makeExecutor([jsonResponse(body)]);
    const result = await run(executor, config({ provider: "openai" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain('answer "team".probabilities must sum to 1');
  });

  test("a choice outside the declared options fails", async () => {
    const body = openaiBody();
    (body.answers[2] as { choice: string }).choice = "marketing";
    const { executor } = makeExecutor([jsonResponse(body)]);
    const result = await run(executor, config({ provider: "openai" }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain('answer "team".choice is not one of the declared options');
  });

  test("a missing, duplicate, or unknown answer name fails validation", async () => {
    const missing = openaiBody({ answers: openaiBody().answers.slice(0, 2) });
    const duplicate = openaiBody({ answers: [...openaiBody().answers, openaiBody().answers[1]] });
    const unknown = openaiBody({
      answers: [...openaiBody().answers, { type: "predicate", name: "other", probability: 1 }],
    });
    const expected = [
      'response is missing the answer for question "team"',
      'response answers question "urgent" twice',
      "response contains an answer for an undeclared question",
    ];
    for (const [index, body] of [missing, duplicate, unknown].entries()) {
      const { executor } = makeExecutor([jsonResponse(body)]);
      const result = await run(executor, config({ provider: "openai" }));
      expect(result.status).toBe("failed");
      expect(result.error).toContain(expected[index]!);
    }
  });

  test("a 401 names OPENAI_DECISIONS_API_KEY and the error code, and is not retried", async () => {
    const { executor, calls } = makeExecutor([
      jsonResponse({ error: { code: "invalid_api_key", message: `bad key ${OPENAI_KEY}` } }, 401, {
        "x-request-id": "req_401",
      }),
    ]);
    const result = await run(executor, config({ provider: "openai", maxRetries: 3 }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      "OPENAI_DECISIONS_API_KEY was rejected by OpenAI (HTTP 401 (invalid_api_key))",
    );
    expect(result.error).toContain("[request req_401]");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  test("the key never appears in output or errors when the body echoes it", async () => {
    const body = openaiBody();
    (body.answers[2] as { choice: string }).choice = OPENAI_KEY;
    const { executor } = makeExecutor([jsonResponse(body)]);
    const result = await run(executor, config({ provider: "openai" }));
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  test("humanReview tests the band against OpenAI's own confidence", async () => {
    const { executor } = makeExecutor([jsonResponse(openaiBody())]);
    const result = await run(
      executor,
      config({
        provider: "openai",
        humanReview: {
          band: { min: 0, max: 0.5 },
          approvers: { users: ["reviewer@example.com"], policy: "any" },
        },
      }),
    );
    expect(result.status).toBe("success");
    expect(result.nextPort).toBe("approved");
    expect(result.output?.review?.status).toBe("not_required");
    expect(result.output?.review?.questions.team?.confidence).toBe(0.81);
    expect(result.output?.review?.questions.severity?.confidence).toBe(0.7);
  });

  test("OPENAI_API_KEY alone does not satisfy the openai provider", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "OPENAI_API_KEY",
      value: "sk-general-example-0123456789",
      isSecret: true,
    });
    const { executor, calls } = makeExecutor([jsonResponse(openaiBody())], {
      getApiKey: undefined,
      env: { OPENAI_API_KEY: "sk-general-example-0123456789" },
    });
    const problems = await executor.checkReadiness([
      { id: "a", config: config({ provider: "openai" }) },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("OPENAI_DECISIONS_API_KEY is not configured");
    const result = await run(executor, config({ provider: "openai" }));
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);

    await upsertSwarmConfig({
      scope: "global",
      key: "OPENAI_DECISIONS_API_KEY",
      value: OPENAI_KEY,
      isSecret: true,
    });
    expect((await run(executor, config({ provider: "openai" }))).status).toBe("success");
    expect(calls).toHaveLength(1);
  });
});

// ─── Existing providers ─────────────────────────────────────

describe("system-one-decision SystemOne wire is unchanged", () => {
  test("typesafe, openrouter, and laya send the same bytes as before the wire seam", async () => {
    const cfg = config({ model: "jev-1.13.0" });
    // The body every SystemOne host received before providers could translate it.
    const expected = JSON.stringify({ state: cfg.state, model: "jev-1.13.0", questions });
    for (const provider of ["typesafe", "openrouter", "laya"]) {
      const { executor, calls } = makeExecutor(
        [
          jsonResponse({
            model: "jev",
            answers: systemOneAnswers,
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        ],
        {
          getApiKey: async () => OPENAI_KEY,
          getServerUrl: async () => "https://laya.example.test",
          env: { OPENROUTER_API_KEY: OPENAI_KEY },
        },
      );
      await run(executor, { ...cfg, provider });
      expect(calls[0]?.raw).toBe(expected);
    }
  });
});
