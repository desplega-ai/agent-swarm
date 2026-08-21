import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  getActivePricingRow,
  getDbClient,
  initDb,
  insertPricingRow,
} from "../be/db";
import { seedPricingFromModelsDev } from "../be/seed-pricing";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { PricingProvider, PricingTokenClass } from "../types";

const TEST_DB_PATH = "./test-session-costs-golden.sqlite";
const API_KEY = "test-session-costs-golden";
const RATE_EFFECTIVE_AT = 1_800_000_000_000;
const FIXTURE_CREATED_AT = RATE_EFFECTIVE_AT + 1;
const EPSILON = 1e-9;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleSessionData(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

interface CostResponse {
  success: boolean;
  cost: {
    totalCostUsd: number;
    harnessCostUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costSource: "harness" | "pricing-table" | "unpriced";
    modelBreakdown: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      webSearchRequests?: number | null;
      costUsd?: number | null;
      harnessCostUsd?: number | null;
    }> | null;
  };
}

let server: Server;
let port: number;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  seedPricingFromModelsDev({ quiet: true });
  agentId = (await createAgent({ name: "session-cost-golden", isLead: false, status: "idle" })).id;
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM session_costs");
  await client.run("DELETE FROM pricing WHERE effective_from > 0");
});

async function seedRate(
  provider: PricingProvider,
  model: string,
  tokenClass: PricingTokenClass,
  pricePerMillionUsd: number,
): Promise<void> {
  await insertPricingRow({
    provider,
    model,
    tokenClass,
    effectiveFrom: RATE_EFFECTIVE_AT,
    pricePerMillionUsd,
  });
}

async function seedModelRates(
  provider: PricingProvider,
  model: string,
  rates: Partial<Record<PricingTokenClass, number>>,
): Promise<void> {
  for (const [tokenClass, rate] of Object.entries(rates)) {
    await seedRate(provider, model, tokenClass as PricingTokenClass, rate);
  }
}

function expectExact(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(EPSILON);
}

async function postCost(body: Record<string, unknown>): Promise<CostResponse> {
  const response = await fetch(`http://localhost:${port}/api/session-costs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentId,
      durationMs: 0,
      numTurns: 1,
      createdAt: FIXTURE_CREATED_AT,
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CostResponse;
}

describe("Phase 3 — session cost recompute golden fixtures", () => {
  // Seeder assertion (not a recompute golden): safe here only because seeded
  // rows use effective_from = 0 and afterEach deletes rows with > 0 — the
  // boot-seeded book survives while per-test rates are wiped.
  test("fresh DB seeds wildcard web-search request rates", async () => {
    expect(
      (await getActivePricingRow("claude", "*", "web_search", FIXTURE_CREATED_AT))
        ?.pricePerMillionUsd,
    ).toBe(10_000);
    expect(
      (await getActivePricingRow("claude-managed", "*", "web_search", FIXTURE_CREATED_AT))
        ?.pricePerMillionUsd,
    ).toBe(10_000);
  });

  test("aef117fe: opus-5 all-1h cache writes reproduce provider billing", async () => {
    await seedModelRates("claude", "claude-opus-5", {
      input: 5,
      output: 25,
      cached_input: 0.5,
      cache_write: 6.25,
      cache_write_1h: 10,
    });

    const body = await postCost({
      sessionId: "aef117fe-19ef-4519-839a-f1c6303e4340",
      provider: "claude",
      model: "claude-opus-5",
      totalCostUsd: 9.4629795,
      inputTokens: 138,
      outputTokens: 53_185,
      cacheReadTokens: 12_276_769,
      cacheWriteTokens: 199_428,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 199_428,
    });

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, 9.4629795);
    expect(body.cost.harnessCostUsd).toBe(9.4629795);
  });

  test("f9769315: each model uses its own rates and keeps per-model cost parity", async () => {
    await seedModelRates("claude", "claude-opus-4-8", {
      input: 5,
      output: 25,
      cached_input: 0.5,
      cache_write: 6.25,
      cache_write_1h: 10,
    });
    await seedModelRates("claude", "claude-haiku-4-5", {
      input: 1,
      output: 5,
      cached_input: 0.1,
      cache_write: 1.25,
      cache_write_1h: 2,
    });
    const models = [
      {
        model: "claude-opus-4-8",
        inputTokens: 702_173,
        outputTokens: 160_898,
        cacheReadTokens: 2_401_012,
        cacheWriteTokens: 365_510,
        // Read off the prod result line's modelUsage entry on 2026-08-06
        // (session_logs, taskId f9769315-…): webSearchRequests: 56 — the
        // $0.56 the audit couldn't attribute is exactly 56 × $0.01.
        webSearchRequests: 56,
        harnessCostUsd: 12.948921,
      },
      {
        model: "claude-haiku-4-5",
        inputTokens: 81_410,
        outputTokens: 4_275,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        harnessCostUsd: 0.102785,
      },
    ];
    const body = await postCost({
      sessionId: "f9769315-7fc8-4c5c-a756-b835510fc7c0",
      provider: "claude",
      model: "claude-opus-4-8",
      totalCostUsd: 13.051706,
      // Top-level usage covers the main thread only (here: the opus entry);
      // the stored row's totals must come from summing models[] instead.
      inputTokens: 702_173,
      outputTokens: 160_898,
      cacheReadTokens: 2_401_012,
      cacheWriteTokens: 365_510,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 365_510,
      models,
    });

    const expectedOpus =
      (702_173 * 5 + 160_898 * 25 + 2_401_012 * 0.5 + 365_510 * 10 + 56 * 10_000) / 1_000_000;
    const expectedHaiku = (81_410 * 1 + 4_275 * 5) / 1_000_000;
    const opus = body.cost.modelBreakdown?.find((entry) => entry.model === "claude-opus-4-8");
    const haiku = body.cost.modelBreakdown?.find((entry) => entry.model === "claude-haiku-4-5");

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(opus?.costUsd ?? Number.NaN, expectedOpus);
    expectExact(haiku?.costUsd ?? Number.NaN, expectedHaiku);
    expectExact(expectedOpus, 12.948921);
    expectExact(expectedHaiku, 0.102785);
    expectExact(body.cost.totalCostUsd, expectedOpus + expectedHaiku);
    expect(body.cost.harnessCostUsd).toBe(13.051706);
    // Row token totals are the sums across models[], not the main-thread
    // usage block that was POSTed top-level.
    expect(body.cost.inputTokens).toBe(783_583);
    expect(body.cost.outputTokens).toBe(165_173);
    expect(body.cost.cacheReadTokens).toBe(2_401_012);
    expect(body.cost.cacheWriteTokens).toBe(365_510);
  });

  test("28943d8a: sonnet-5 intro rates replace the stale harness rate", async () => {
    await seedModelRates("claude", "claude-sonnet-5", {
      input: 2,
      output: 10,
      cached_input: 0.2,
      cache_write: 2.5,
      cache_write_1h: 4,
    });

    const body = await postCost({
      sessionId: "28943d8a-4135-4e14-9b4d-c2db2054c3e6",
      provider: "claude",
      model: "claude-sonnet-5",
      totalCostUsd: 30.9173856,
      inputTokens: 1_944,
      outputTokens: 145_646,
      cacheReadTokens: 86_126_352,
      cacheWriteTokens: 481_493,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 481_493,
    });
    const expected = (1_944 * 2 + 145_646 * 10 + 86_126_352 * 0.2 + 481_493 * 4) / 1_000_000;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(expected, 20.6115904);
    expect(body.cost.harnessCostUsd).toBe(30.9173856);
  });

  test("codex keeps OpenAI-inclusive input subtraction", async () => {
    await seedModelRates("codex", "codex-golden", {
      input: 2,
      output: 10,
      cached_input: 0.2,
    });

    const body = await postCost({
      sessionId: "codex-inclusive-input",
      provider: "codex",
      model: "codex-golden",
      totalCostUsd: 99,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 400,
    });
    const expected = (600 * 2 + 400 * 0.2 + 100 * 10) / 1_000_000;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(expected, 0.00228);
  });

  test("legacy cache writes without a TTL split keep the 5m class", async () => {
    await seedModelRates("claude", "claude-legacy-cache-write", {
      input: 5,
      output: 25,
      cache_write: 6.25,
      cache_write_1h: 10,
    });

    const body = await postCost({
      sessionId: "claude-legacy-cache-write",
      provider: "claude",
      model: "claude-legacy-cache-write",
      totalCostUsd: 99,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000,
    });

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, (1_000 * 6.25) / 1_000_000);
  });

  test("per-model cache writes inherit the session TTL ratio", async () => {
    await seedModelRates("claude", "claude-mixed-cache-write", {
      input: 5,
      output: 25,
      cache_write: 6.25,
      cache_write_1h: 10,
    });

    const body = await postCost({
      sessionId: "claude-mixed-cache-write",
      provider: "claude",
      model: "claude-mixed-cache-write",
      totalCostUsd: 99,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 400,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 300,
      models: [
        {
          model: "claude-mixed-cache-write",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 400,
        },
      ],
    });
    const expected = (100 * 6.25 + 300 * 10) / 1_000_000;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(body.cost.modelBreakdown?.[0]?.costUsd ?? Number.NaN, expected);
  });

  test("one unpriced model makes the whole breakdown unpriced", async () => {
    await seedModelRates("claude", "claude-priced-model", { input: 5, output: 25 });
    await seedModelRates("claude", "claude-missing-output", { input: 1 });

    const body = await postCost({
      sessionId: "claude-partially-priced-breakdown",
      provider: "claude",
      model: "claude-priced-model",
      totalCostUsd: 1.23,
      inputTokens: 2,
      outputTokens: 2,
      models: [
        {
          model: "claude-priced-model",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          model: "claude-missing-output",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });

    expect(body.cost.costSource).toBe("unpriced");
    expect(body.cost.totalCostUsd).toBe(1.23);
    expect(body.cost.modelBreakdown?.every((entry) => entry.costUsd == null)).toBe(true);
  });

  test("claude-managed adds the pricing-table runtime-hour fee", async () => {
    await seedModelRates("claude-managed", "claude-managed-golden", {
      input: 3,
      output: 15,
      cached_input: 0.3,
      cache_write: 3.75,
    });
    await seedRate("claude-managed", "*", "runtime_hour", 0.08 * 1_000_000);

    const body = await postCost({
      sessionId: "claude-managed-runtime",
      provider: "claude-managed",
      model: "claude-managed-golden",
      totalCostUsd: 4.61,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
      durationMs: 3_600_000,
    });
    const expected =
      1_000_000 * (3 / 1_000_000) + 100_000 * (0.3 / 1_000_000) + 100_000 * (15 / 1_000_000) + 0.08;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(expected, 4.61);
  });

  test("claude input_tokens stay billable when cache reads are larger", async () => {
    await seedModelRates("claude", "claude-input-semantics", {
      input: 5,
      output: 25,
      cached_input: 0.5,
    });

    const body = await postCost({
      sessionId: "claude-input-semantics",
      provider: "claude",
      model: "claude-input-semantics",
      totalCostUsd: 0.255,
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
    });
    const expected = (1_000 * 5 + 500_000 * 0.5) / 1_000_000;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(expected, 0.255);
  });

  test("pi keeps Anthropic input semantics when web-search pricing is absent", async () => {
    await seedModelRates("pi", "pi-anthropic-input", {
      input: 2,
      output: 10,
      cached_input: 0.2,
    });

    const body = await postCost({
      sessionId: "pi-anthropic-input",
      provider: "pi",
      model: "openrouter/pi-anthropic-input",
      totalCostUsd: 99,
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
      models: [
        {
          model: "openrouter/pi-anthropic-input",
          inputTokens: 1_000,
          outputTokens: 0,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 0,
          webSearchRequests: 3,
        },
      ],
    });
    const expected = (1_000 * 2 + 500_000 * 0.2) / 1_000_000;

    expect(body.cost.costSource).toBe("pricing-table");
    expectExact(body.cost.totalCostUsd, expected);
    expectExact(body.cost.modelBreakdown?.[0]?.costUsd ?? Number.NaN, expected);
  });

  test("a missing 1h cache-write rate makes a split payload unpriced", async () => {
    await seedModelRates("claude", "claude-missing-1h", {
      input: 5,
      output: 25,
      cache_write: 6.25,
    });

    const body = await postCost({
      sessionId: "claude-missing-1h",
      provider: "claude",
      model: "claude-missing-1h",
      totalCostUsd: 1.23,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 100,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 100,
    });

    expect(body.cost.costSource).toBe("unpriced");
    expect(body.cost.totalCostUsd).toBe(1.23);
    expect(body.cost.harnessCostUsd).toBe(1.23);
  });

  test("negative webSearchRequests in a breakdown entry is rejected at the wire", async () => {
    // One positive entry enables the wildcard web-search rate for the whole
    // breakdown; a negative sibling count would then subtract real dollars.
    const response = await fetch(`http://localhost:${port}/api/session-costs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        durationMs: 0,
        numTurns: 1,
        createdAt: FIXTURE_CREATED_AT,
        sessionId: "negative-web-search",
        provider: "claude",
        model: "claude-opus-5",
        totalCostUsd: 1,
        inputTokens: 1_000,
        outputTokens: 1_000,
        models: [
          {
            model: "claude-opus-5",
            inputTokens: 500,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearchRequests: 10,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 500,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearchRequests: -5,
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
  });
});
