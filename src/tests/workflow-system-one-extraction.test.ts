import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import type { WorkflowNode } from "../types";
import { validateDefinition } from "../workflows/definition";
import { interpolateNodeConfig } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { SystemOneDecisionExecutor } from "../workflows/executors/system-one-decision";
import {
  SystemOneExtractionConfigSchema,
  SystemOneExtractionExecutor,
  type SystemOneExtractionExecutorOptions,
  SystemOneExtractionOutputSchema,
} from "../workflows/executors/system-one-extraction";
import {
  SYSTEM_ONE_EXTRACT_PROVIDER_IDS,
  SYSTEM_ONE_PROVIDER_IDS,
} from "../workflows/executors/system-one-providers";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-system-one-extraction.sqlite";
// Shaped like tokens but obviously fake; they must never appear in any output or error.
const CF_TOKEN = "cf-example-test-token-0123456789abcdef";
const CF_KEY = "cf-example-test-key-fedcba9876543210";
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
    "DELETE FROM swarm_config WHERE key IN ('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY')",
  );
});

// ─── Harness ────────────────────────────────────────────────

type TransportStep = Response | Error;

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function makeTransport(steps: TransportStep[]) {
  const calls: RecordedCall[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (step instanceof Error) throw step;
    return (step as Response).clone();
  }) as typeof fetch;
  return { calls, transport };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cf-ray": "8f00aa11bb22cc33-MAD" },
  });
}

function makeExecutor(steps: TransportStep[], options: SystemOneExtractionExecutorOptions = {}) {
  const { calls, transport } = makeTransport(steps);
  const executor = new SystemOneExtractionExecutor(deps, {
    fetch: transport,
    env: {},
    getApiKey: async () => CF_TOKEN,
    getServerUrl: async () => CF_ACCOUNT,
    sleep: async () => {},
    random: () => 1,
    ...options,
  });
  return { executor, calls };
}

function run(executor: SystemOneExtractionExecutor, config: Record<string, unknown>) {
  return executor.run({
    config,
    context: {},
    meta: {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      nodeId: "claim",
      workflowId: crypto.randomUUID(),
      dryRun: false,
    },
  });
}

// ─── Fixtures: the damaged-order email from Cloudflare's Clairic post ─────

const EMAIL =
  "Hi, order A-88412 arrived on Sept 28, 2026 with a cracked screen and a dented corner. I paid $649.00 plus $52.10 tax. It's now Oct 9, 2026 and I'd like this fixed or refunded. Thanks, Dana";

const fields = {
  order_id: { type: "text", instructions: "Order number" },
  delivered_on: { type: "date", instructions: "Delivery date" },
  amount_paid: {
    type: "number",
    decimals: 2,
    unit: "USD",
    instructions: "Total paid including tax",
  },
  days_since_delivery: {
    type: "duration",
    unit: "days",
    integer: true,
    instructions: "Days from delivery to the date the customer wrote",
  },
  damage: { type: "list", items: "text", instructions: "Each kind of damage described" },
  tracking_number: { type: "text" },
  repair_cost: {
    type: "estimate",
    unit: "USD",
    min: 10,
    max: 5000,
    scale: "log",
    step: 1,
    instructions: "Cost to repair the damage described",
  },
};

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: EMAIL, fields, ...overrides };
}

function clairicResult(answers: Record<string, unknown> = {}) {
  return {
    model: "clairic",
    answers: {
      order_id: {
        type: "text",
        p_null: 3.4e-6,
        span: [10, 17],
        guess: "A-88412",
        confidence: 0.999957,
        value: "A-88412",
      },
      delivered_on: {
        type: "date",
        p_null: 6.5e-8,
        guess: "2026-09-28",
        confidence: 0.999999,
        value: "2026-09-28",
      },
      amount_paid: {
        type: "number",
        p_null: 1.6e-5,
        guess: 701.1,
        confidence: 0.999944,
        value: 701.1,
      },
      days_since_delivery: {
        type: "duration",
        p_null: 6.1e-9,
        unit: "days",
        guess: 11,
        confidence: 0.999999,
        value: 11,
      },
      damage: {
        type: "list",
        value: ["cracked screen", "dented corner"],
        spans: [
          [50, 64],
          [71, 84],
        ],
      },
      tracking_number: {
        type: "text",
        p_null: 1,
        span: [106, 112],
        guess: "$52.10",
        confidence: 0.416016,
        value: null,
      },
      repair_cost: {
        type: "estimate",
        value: 236,
        mean: 236.26,
        median: 213,
        p10: 122,
        p90: 370,
        p_below: 4.4e-6,
        p_above: 2.5e-6,
      },
      ...answers,
    },
    truncated: false,
    usage: { state_tokens: 61, input_tokens: 655, output_tokens: 0, passes: 3 },
  };
}

/** `@cf/cloudflare/clairic` on 2026-10-20 for EMAIL and `fields`, verbatim. */
const LIVE_CLOUDFLARE_RESPONSE = {
  result: {
    model: "clairic",
    answers: {
      order_id: {
        type: "text",
        p_null: 0.0019279655534774065,
        span: [10, 17],
        guess: "A-88412",
        confidence: 0.9999996423721313,
        value: "A-88412",
      },
      delivered_on: {
        type: "date",
        p_null: 0.0000010288927114743274,
        guess: "2026-09-28",
        confidence: 0.9999949932298761,
        value: "2026-09-28",
      },
      amount_paid: {
        type: "number",
        p_null: 3.2816508621635876e-8,
        guess: 701.1,
        confidence: 0.9999686488145774,
        value: 701.1,
      },
      days_since_delivery: {
        type: "duration",
        p_null: 3.2392144078130514e-8,
        unit: "days",
        guess: 11,
        confidence: 0.9955674593910555,
        value: 11,
      },
      damage: {
        type: "list",
        value: ["cracked screen", "dented corner"],
        spans: [
          [50, 64],
          [71, 84],
        ],
        confidence: 0.6304950857959576,
      },
      tracking_number: {
        type: "text",
        p_null: 0.9999991655349731,
        span: [10, 17],
        guess: "A-88412",
        confidence: 0.9594870209693909,
        value: null,
      },
      repair_cost: {
        type: "estimate",
        value: 236,
        mean: 236.25989418083398,
        median: 213,
        p10: 122,
        p90: 370,
        p_below: 0.0000044131897993793245,
        p_above: 0.0000025400161121069686,
      },
    },
    truncated: false,
    usage: {
      state_tokens: 74,
      image_tokens: 0,
      schema_tokens: 517,
      input_tokens: 739,
      output_tokens: 0,
      passes: 3,
    },
  },
  success: true,
  errors: [],
  messages: [],
};

function envelope(result: unknown = clairicResult()) {
  return { result, success: true, errors: [], messages: [] };
}

// ─── Request and answers ────────────────────────────────────

describe("system-one-extraction on Cloudflare Clairic", () => {
  test("sends the Clairic request to the account-scoped route and returns typed answers", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(envelope())]);
    const result = await run(executor, config({ referenceDate: "2026-10-09" }));

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CF_BASE}/clairic`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CF_TOKEN}`,
    );
    expect(calls[0]?.body).toEqual({
      model: "clairic",
      state: EMAIL,
      fields,
      reference_date: "2026-10-09",
    });

    if (result.status !== "success") throw new Error("unreachable");
    const output = SystemOneExtractionOutputSchema.parse(result.output);
    expect(output.model).toBe("clairic");
    expect(output.requestId).toBe("8f00aa11bb22cc33-MAD");
    expect(output.truncated).toBe(false);
    expect(output.usage).toEqual({ input_tokens: 655, output_tokens: 0 });
    expect(output.answers.order_id).toMatchObject({ value: "A-88412", span: [10, 17] });
    expect(output.answers.amount_paid?.value).toBe(701.1);
    expect(output.answers.days_since_delivery).toMatchObject({ value: 11, unit: "days" });
    expect(output.answers.damage?.value).toEqual(["cracked screen", "dented corner"]);
    // The model saw "$52.10" and still said there is no tracking number.
    expect(output.answers.tracking_number).toMatchObject({
      value: null,
      p_null: 1,
      guess: "$52.10",
    });
    expect(output.answers.repair_cost).toMatchObject({
      value: 236,
      median: 213,
      p10: 122,
      p90: 370,
    });
  });

  test("accepts a recorded live Workers AI response unchanged", async () => {
    const { executor } = makeExecutor([jsonResponse(LIVE_CLOUDFLARE_RESPONSE)]);
    const result = await run(executor, config());

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    const output = SystemOneExtractionOutputSchema.parse(result.output);
    expect(output.usage).toEqual({ input_tokens: 739, output_tokens: 0 });
    expect(output.answers.tracking_number).toMatchObject({ value: null, guess: "A-88412" });
    expect(output.answers.damage).toMatchObject({ confidence: 0.6304950857959576 });
    expect(output.answers.repair_cost).toMatchObject({ value: 236, median: 213 });
  });

  test("structured state is sent as JSON text and images ride along", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(envelope())]);
    const image = { content_type: "image/png", base64: "iVBORw0KGgo=" };
    const result = await run(
      executor,
      config({ state: { from: "dana@example.com", body: EMAIL }, images: [image] }),
    );
    expect(result.status).toBe("success");
    expect(calls[0]?.body.state).toBe(JSON.stringify({ from: "dana@example.com", body: EMAIL }));
    expect(calls[0]?.body.images).toEqual([image]);
  });

  test("a forecast answer carries one entry per step", async () => {
    const forecast = {
      travelers: {
        type: "forecast",
        horizon: 2,
        interval: "day",
        min: 500000,
        max: 4000000,
        scale: "log",
      },
    };
    const { executor } = makeExecutor([
      jsonResponse(
        envelope({
          model: "clairic",
          answers: {
            travelers: {
              type: "forecast",
              value: [2416117, 2300000],
              median: [2419283, 2310000],
              p10: [2270774, 2100000],
              p90: [2556769, 2500000],
            },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ),
    ]);
    const result = await run(executor, { state: "TSA counts", fields: forecast });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.output.answers.travelers?.p90).toEqual([2556769, 2500000]);
  });

  test("an answer that does not fit its field fails validation and names it", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amount_paid: { type: "text", value: "701.10" } }, 'answer "amount_paid" has type "text"'],
      [
        { amount_paid: { type: "number", value: "701.10" } },
        '"amount_paid".value must be a finite number',
      ],
      [{ days_since_delivery: { type: "duration", value: 11.5 } }, "must be an integer"],
      [{ damage: { type: "list", value: [1, 2] } }, '"damage".value items must all be strings'],
      [
        { repair_cost: { type: "estimate", value: 180, median: 180, p10: 90 } },
        '"repair_cost".p90',
      ],
      [{ order_id: { type: "text", value: "A-88412", confidence: 1.5 } }, '"order_id".confidence'],
      [{ order_id: { type: "text" } }, 'answer "order_id" is missing its value'],
      [{ extra: { type: "text", value: "x" } }, "answer(s) for undeclared fields"],
    ];
    for (const [answers, message] of cases) {
      const { executor } = makeExecutor([jsonResponse(envelope(clairicResult(answers)))]);
      const result = await run(executor, config());
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.error).toContain("SystemOne response failed validation: ");
      expect(result.error).toContain(message);
      expect(result.error).toContain("[request 8f00aa11bb22cc33-MAD]");
    }
  });

  test("a failed Cloudflare run is reported with its code and nothing extracted", async () => {
    const { executor } = makeExecutor([
      jsonResponse({
        success: false,
        errors: [{ code: 5007, message: "No such model" }],
        result: null,
      }),
    ]);
    const result = await run(executor, config());
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.error).toContain(
      "Cloudflare Workers AI reported a failed run (5007). Nothing was extracted.",
    );
  });

  test("transient errors retry through the shared transport; a 401 does not", async () => {
    const retried = makeExecutor([jsonResponse({}, 503), jsonResponse(envelope())]);
    expect((await run(retried.executor, config())).status).toBe("success");
    expect(retried.calls).toHaveLength(2);

    const rejected = makeExecutor([
      jsonResponse(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        401,
      ),
    ]);
    const result = await run(rejected.executor, config({ maxRetries: 3 }));
    expect(rejected.calls).toHaveLength(1);
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.error).toContain(
      "CLOUDFLARE_API_TOKEN was rejected by Cloudflare Workers AI (HTTP 401 (10000))",
    );
    expect(result.error).toContain("Nothing was extracted.");
    expect(result.error).not.toContain(CF_TOKEN);
  });
});

// ─── Config validation ──────────────────────────────────────

describe("system-one-extraction config", () => {
  const parse = (overrides: Record<string, unknown>) =>
    SystemOneExtractionConfigSchema.safeParse(config(overrides));
  const field = (spec: Record<string, unknown>) => parse({ fields: { f: spec } });

  test("the blog's fields are valid as written", () => {
    expect(parse({}).success).toBe(true);
  });

  test("each type takes only its own options", () => {
    expect(field({ type: "text", decimals: 2 }).success).toBe(false);
    expect(field({ type: "date", unit: "days" }).success).toBe(false);
    expect(field({ type: "number", decimals: 7 }).success).toBe(false);
    expect(field({ type: "number", integer: true, decimals: 2 }).success).toBe(false);
    expect(field({ type: "duration", unit: "fortnights" }).success).toBe(false);
    expect(field({ type: "duration", unit: "weeks", integer: true }).success).toBe(true);
    expect(field({ type: "list" }).success).toBe(false);
    expect(field({ type: "list", items: "text", decimals: 2 }).success).toBe(false);
    expect(field({ type: "list", items: "number", decimals: 2 }).success).toBe(true);
    expect(field({ type: "text", null_threshold: 0 }).success).toBe(false);
    expect(field({ type: "text", null_threshold: 0.8 }).success).toBe(true);
    expect(field({ type: "sentiment" }).success).toBe(false);
  });

  test("estimates and forecasts need a valid range", () => {
    expect(field({ type: "estimate" }).success).toBe(false);
    expect(field({ type: "estimate", min: 10, max: 10 }).success).toBe(false);
    expect(field({ type: "estimate", min: 0, max: 10, scale: "log" }).success).toBe(false);
    expect(field({ type: "estimate", min: 10, max: "2026-01-01" }).success).toBe(false);
    expect(field({ type: "estimate", min: 1, max: 10, step: "month" }).success).toBe(false);
    expect(
      field({ type: "estimate", min: "2026-01-01", max: "2027-01-01", step: "month" }).success,
    ).toBe(true);
    expect(field({ type: "forecast", min: 1, max: 10, horizon: 65 }).success).toBe(false);
    expect(field({ type: "forecast", min: 1, max: 10, step: 1 }).success).toBe(false);
    expect(field({ type: "forecast", min: 1, max: 10, horizon: 7, interval: "day" }).success).toBe(
      true,
    );
  });

  test("field ids are usable as output paths", () => {
    expect(parse({ fields: { "order.id": { type: "text" } } }).success).toBe(false);
    expect(parse({ fields: { constructor: { type: "text" } } }).success).toBe(false);
    expect(parse({ fields: {} }).success).toBe(false);
  });

  test("state may be empty only with images; images are capped", () => {
    const png = { content_type: "image/png", base64: "iVBORw0KGgo=" };
    expect(parse({ state: "" }).success).toBe(false);
    expect(parse({ state: "", images: [png] }).success).toBe(true);
    expect(parse({ images: [png, png, png, png, png] }).success).toBe(false);
    expect(parse({ images: ["https://example.com/receipt.png"] }).success).toBe(false);
    expect(parse({ images: ["data:image/jpeg;base64,/9j/4AAQ"] }).success).toBe(true);
    const big = { content_type: "image/png", base64: "A".repeat(6 * 1024 * 1024) };
    expect(parse({ images: [big] }).success).toBe(false);
  });

  test("only Clairic models and extraction hosts are accepted", () => {
    expect(parse({ model: "clef" }).success).toBe(false);
    expect(parse({ provider: "typesafe" }).success).toBe(false);
    expect(SYSTEM_ONE_EXTRACT_PROVIDER_IDS).toEqual(["cloudflare"]);
    // The decision hosts are unchanged.
    expect(SYSTEM_ONE_PROVIDER_IDS).toEqual([
      "typesafe",
      "openrouter",
      "laya",
      "openai",
      "cloudflare",
    ]);
  });
});

// ─── Credentials and readiness ──────────────────────────────

describe("Cloudflare credential handling", () => {
  const defaults = { getApiKey: undefined, getServerUrl: undefined };

  test("CLOUDFLARE_API_KEY is used when CLOUDFLARE_API_TOKEN is unset, for Clairic and Clef", async () => {
    await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_KEY",
      value: CF_KEY,
      isSecret: true,
    });

    const { executor, calls } = makeExecutor([jsonResponse(envelope())], defaults);
    expect((await run(executor, config())).status).toBe("success");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CF_KEY}`,
    );
    expect(await executor.checkReadiness([{ id: "a", config: config() }])).toEqual([]);

    const { transport, calls: clefCalls } = makeTransport([
      jsonResponse({
        success: true,
        errors: [],
        result: {
          model: "clef",
          answers: { urgent: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]);
    const clef = new SystemOneDecisionExecutor(deps, { fetch: transport, env: {} });
    const decided = await clef.decide({
      provider: "cloudflare",
      state: "x",
      questions: { urgent: { type: "noul", instructions: "Urgent?" } },
      returns: { urgent: { type: "noul" } },
      timeoutMs: 30_000,
      maxRetries: 0,
    });
    expect(decided.ok).toBe(true);
    expect(clefCalls[0]?.url).toBe(`${CF_BASE}/clef`);
    expect((clefCalls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CF_KEY}`,
    );
  });

  test("CLOUDFLARE_API_TOKEN wins over CLOUDFLARE_API_KEY", async () => {
    await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_KEY",
      value: CF_KEY,
      isSecret: true,
    });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_TOKEN",
      value: CF_TOKEN,
      isSecret: true,
    });
    const { executor, calls } = makeExecutor([jsonResponse(envelope())], defaults);
    expect((await run(executor, config())).status).toBe("success");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CF_TOKEN}`,
    );
  });

  test("a rejected CLOUDFLARE_API_KEY is named as the key that was sent", async () => {
    await upsertSwarmConfig({ scope: "global", key: "CLOUDFLARE_ACCOUNT_ID", value: CF_ACCOUNT });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLOUDFLARE_API_KEY",
      value: CF_KEY,
      isSecret: true,
    });
    const { executor } = makeExecutor(
      [jsonResponse({ success: false, errors: [{ code: 10000 }] }, 403)],
      defaults,
    );
    const result = await run(executor, config());
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.error).toContain(
      "CLOUDFLARE_API_KEY was rejected by Cloudflare Workers AI (HTTP 403 (10000))",
    );
    expect(result.error).not.toContain(CF_KEY);
  });

  test("readiness names the account id and both key names when nothing is set", async () => {
    const { executor, calls } = makeExecutor([jsonResponse(envelope())], defaults);
    const problems = await executor.checkReadiness([
      { id: "a", config: config() },
      { id: "b", config: config() },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.nodeIds).toEqual(["a", "b"]);
    expect(problems[0]?.message).toContain("CLOUDFLARE_ACCOUNT_ID is not configured");
    expect(problems[0]?.message).toContain("CLOUDFLARE_API_TOKEN is not configured");
    expect(problems[0]?.message).toContain("CLOUDFLARE_API_KEY");
    const result = await run(executor, config());
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

// ─── Engine rules ───────────────────────────────────────────

describe("system-one-extraction in a workflow definition", () => {
  const registry = () => createExecutorRegistry(deps);
  const node = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
    id: "claim",
    type: "system-one-extraction",
    inputs: { email: "trigger.email" },
    config: config({ state: "{{email}}" }),
    ...overrides,
  });

  test("a valid node saves; engine retries, a token provider, and token fields are refused", () => {
    expect(validateDefinition({ nodes: [node()] }, registry()).valid).toBe(true);

    const retry = validateDefinition({ nodes: [node({ retry: { maxRetries: 2 } })] }, registry());
    expect(retry.errors.join(";")).toContain(
      'Node "claim" (system-one-extraction) must not set retry.maxRetries > 0',
    );
    const provider = validateDefinition(
      { nodes: [node({ config: config({ provider: "{{p}}" }) })] },
      registry(),
    );
    expect(provider.errors.join(";")).toContain("config.provider must be a literal");
    const tokenFields = validateDefinition(
      { nodes: [node({ config: config({ fields: "{{f}}" }) })] },
      registry(),
    );
    expect(tokenFields.errors.join(";")).toContain("config.fields must be an object");
  });

  test("a templated instructions does not hide an invalid field spec or a token type", () => {
    const save = (spec: Record<string, unknown>) =>
      validateDefinition(
        { nodes: [node({ config: config({ fields: { note: spec } }) })] },
        registry(),
      );

    expect(save({ type: "text", instructions: "{{hint}}" }).valid).toBe(true);

    // Regression: before the fix, the generic check skipped the whole spec because it held a token.
    const badOption = save({ type: "text", instructions: "{{hint}}", decimals: 2 });
    expect(badOption.valid).toBe(false);
    expect(badOption.errors.join(";")).toContain("config.fields.note");

    const tokenType = save({ type: "{{t}}", instructions: "{{hint}}" });
    expect(tokenType.errors.join(";")).toContain(
      "config.fields.note.type must be a literal: only instructions may use {{tokens}}",
    );
    const tokenTypeAlone = save({ type: "{{t}}" });
    expect(tokenTypeAlone.errors.join(";")).toContain("config.fields.note.type must be a literal");

    const tokenBound = save({ type: "estimate", min: "{{lo}}", max: 10 });
    expect(tokenBound.errors.join(";")).toContain("config.fields.note.min must be a literal");
  });

  test("a saved templated field spec cannot resolve to a different shape or an invalid id", () => {
    const saveFields = (fields: Record<string, unknown>) =>
      validateDefinition({ nodes: [node({ config: config({ fields }) })] }, registry());
    const hinted = { type: "text", instructions: "{{hint}}" };

    // Regression: each of these saved valid and only failed the executor's input check at run time.
    const refused: Array<[string, Record<string, unknown>, string]> = [
      ["whole-token spec", { note: "{{spec}}" }, "config.fields.note must be an object"],
      ["dotted id", { "bad.id": hinted }, "config.fields.bad.id: field ids must start"],
      ["token id", { "{{field}}": hinted }, "config.fields.{{field}}: field ids must start"],
      ["reserved id", { constructor: hinted }, '"constructor" is reserved'],
      [
        "list instructions",
        { note: { type: "text", instructions: ["{{hint}}"] } },
        "config.fields.note.instructions must be a string",
      ],
      [
        "object instructions",
        { note: { type: "text", instructions: { text: "{{hint}}" } } },
        "config.fields.note.instructions must be a string",
      ],
    ];
    for (const [label, fields, message] of refused) {
      const result = saveFields(fields);
      expect({ label, valid: result.valid }).toEqual({ label, valid: false });
      expect(result.errors.join(";")).toContain(message);
    }

    // Literal specs with the same bad ids are still refused by the generic check.
    expect(saveFields({ "{{field}}": { type: "text" } }).valid).toBe(false);
    expect(saveFields({ constructor: { type: "text" } }).valid).toBe(false);

    // What does save resolves to a config the executor accepts, with the static type intact.
    const saved = node({ config: config({ fields: { note: hinted } }) });
    expect(validateDefinition({ nodes: [saved] }, registry()).valid).toBe(true);
    const resolved = interpolateNodeConfig(saved, { email: EMAIL, hint: "the order id" });
    expect(resolved.strictUnresolved ?? []).toEqual([]);
    const parsed = SystemOneExtractionConfigSchema.parse(resolved.value);
    expect(parsed.fields.note).toEqual({ type: "text", instructions: "the order id" });
  });

  test("a {{token}} does not hide a whole-config limit at save", () => {
    const save = (overrides: Record<string, unknown>) =>
      validateDefinition({ nodes: [node({ config: config(overrides) })] }, registry());
    const manyFields = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `f${i}`,
          i === 0 ? { type: "text", instructions: "{{hint}}" } : { type: "text" },
        ]),
      );
    const image = "data:image/png;base64,AAAA";

    // Regression: each of these saved valid and only failed the executor's input check at run time.
    const refused: Array<[string, Record<string, unknown>, string]> = [
      ["65 fields, one templated", { fields: manyFields(65) }, "at most 64 fields"],
      ["5 images, one templated", { images: [image, image, image, image, "{{img}}"] }, "images"],
      ["unknown templated key", { extra: "{{hint}}" }, "extra"],
    ];
    for (const [label, overrides, message] of refused) {
      const result = save(overrides);
      expect({ label, valid: result.valid }).toEqual({ label, valid: false });
      expect(result.errors.join(";")).toContain(message);
    }

    // Templated values that can still resolve to a valid config keep saving.
    const accepted: Array<[string, Record<string, unknown>]> = [
      ["64 fields, one templated", { fields: manyFields(64) }],
      ["templated images", { state: "", images: [image, "{{img}}"] }],
      ["whole-token images", { images: "{{imgs}}" }],
      ["templated options", { model: "{{m}}", timeoutMs: "{{t}}", referenceDate: "{{d}}" }],
    ];
    for (const [label, overrides] of accepted) {
      const result = save(overrides);
      expect({ label, errors: result.errors }).toEqual({ label, errors: [] });
    }
  });

  test("a whole-token state keeps its JSON type and an unresolved token is strict", () => {
    const resolved = interpolateNodeConfig(node({ config: config({ state: "{{email}}" }) }), {
      email: { subject: "Broken", body: EMAIL },
    });
    expect((resolved.value as Record<string, unknown>).state).toEqual({
      subject: "Broken",
      body: EMAIL,
    });

    const missing = interpolateNodeConfig(node({ config: config({ state: "{{nope}}" }) }), {});
    expect(missing.strictUnresolved).toEqual(["nope"]);
  });
});
