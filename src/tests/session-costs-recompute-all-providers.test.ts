// Phase 2: POST /api/session-costs recompute fires for every provider with
// seeded pricing rows — not just codex. Unknown (provider, model) pairs are
// tagged `costSource='unpriced'`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDbClient, initDb, insertPricingRow } from "../be/db";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-recompute-all-providers.sqlite";
const API_KEY = "test-recompute-all";

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
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
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

let server: Server;
let port: number;
let testAgent: { id: string };

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  testAgent = await createAgent({ name: "recompute-all-test", isLead: false, status: "idle" });
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
  // Wipe everything we explicitly inserted (effective_from > 0); leave the
  // migration-046 codex seeds alone.
  await client.run("DELETE FROM pricing WHERE effective_from > 0");
});

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

interface CostResponse {
  success: boolean;
  cost: {
    totalCostUsd: number;
    harnessCostUsd: number | null;
    cacheWrite5mTokens: number | null;
    cacheWrite1hTokens: number | null;
    modelBreakdown: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      harnessCostUsd?: number;
      costUsd?: number;
    }> | null;
    costSource: "harness" | "pricing-table" | "unpriced";
  };
}

async function seedTwoClassRates(provider: string, model: string, inputRate = 1, outputRate = 10) {
  await insertPricingRow({
    provider: provider as Parameters<typeof insertPricingRow>[0]["provider"],
    model,
    tokenClass: "input",
    effectiveFrom: 1,
    pricePerMillionUsd: inputRate,
  });
  await insertPricingRow({
    provider: provider as Parameters<typeof insertPricingRow>[0]["provider"],
    model,
    tokenClass: "output",
    effectiveFrom: 1,
    pricePerMillionUsd: outputRate,
  });
}

describe("Phase 2 — POST /api/session-costs recompute fires for every provider", () => {
  for (const provider of [
    "claude",
    "claude-managed",
    "codex",
    "pi",
    "opencode",
    "devin",
    "gemini",
  ] as const) {
    test(`provider=${provider} with seeded rows → costSource='pricing-table'`, async () => {
      await seedTwoClassRates(provider, `${provider}-test-model`, 2, 10);
      // The payload below explicitly says 75% of writes used a 1h TTL. Phase 3
      // treats a missing 1h row as unpriced, so seed both cache classes at a
      // zero rate to keep this test focused on provider coverage.
      await insertPricingRow({
        provider,
        model: `${provider}-test-model`,
        tokenClass: "cache_write",
        effectiveFrom: 1,
        pricePerMillionUsd: 0,
      });
      await insertPricingRow({
        provider,
        model: `${provider}-test-model`,
        tokenClass: "cache_write_1h",
        effectiveFrom: 1,
        pricePerMillionUsd: 0,
      });

      const res = await authedFetch(`/api/session-costs`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: `${provider}-recompute-1`,
          agentId: testAgent.id,
          totalCostUsd: 999.99, // worker-reported; expected to be overwritten
          inputTokens: 1_000_000, // 1M input
          outputTokens: 500_000, // 500k output
          cacheWrite5mTokens: 25,
          cacheWrite1hTokens: 75,
          models: [
            {
              model: `${provider}-test-model`,
              inputTokens: 1_000_000,
              outputTokens: 500_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 100,
              harnessCostUsd: 999.99,
            },
          ],
          model: `${provider}-test-model`,
          provider,
          // 0 keeps the claude-managed runtime fee out of the $7 assertion;
          // fee coverage lives in session-costs-golden.test.ts.
          durationMs: 0,
          numTurns: 1,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CostResponse;
      expect(body.cost.costSource).toBe("pricing-table");
      // 1M @ 2 + 0.5M @ 10 = $2 + $5 = $7
      expect(body.cost.totalCostUsd).toBeCloseTo(7.0, 5);
      expect(body.cost.harnessCostUsd).toBe(999.99);
      expect(body.cost.cacheWrite5mTokens).toBe(25);
      expect(body.cost.cacheWrite1hTokens).toBe(75);
      expect(body.cost.modelBreakdown).toEqual([
        {
          model: `${provider}-test-model`,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 100,
          harnessCostUsd: 999.99,
          costUsd: 7,
        },
      ]);
    });
  }

  test("unknown (provider, model) pair → costSource='unpriced', worker value preserved", async () => {
    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "unpriced-1",
        agentId: testAgent.id,
        totalCostUsd: 1.23,
        inputTokens: 100,
        outputTokens: 50,
        model: "gpt-future-2027",
        provider: "codex",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CostResponse;
    expect(body.cost.costSource).toBe("unpriced");
    expect(body.cost.totalCostUsd).toBe(1.23);
  });
});

describe("Migration 128 — modelBreakdown persistence", () => {
  test("breakdown + harness fields survive the DB round-trip through GET", async () => {
    await seedTwoClassRates("claude", "claude-breakdown-model", 2, 10);
    const models = [
      {
        model: "claude-breakdown-model",
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        harnessCostUsd: 1.23,
      },
    ];
    const post = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "breakdown-roundtrip",
        agentId: testAgent.id,
        totalCostUsd: 9.99,
        inputTokens: 1_000,
        outputTokens: 500,
        model: "claude-breakdown-model",
        provider: "claude",
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 5,
        models,
      }),
    });
    expect(post.status).toBe(201);

    const res = await authedFetch(`/api/session-costs?agentId=${testAgent.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      costs: Array<{
        sessionId: string;
        harnessCostUsd: number | null;
        cacheWrite5mTokens: number | null;
        cacheWrite1hTokens: number | null;
        modelBreakdown: unknown;
      }>;
    };
    const row = body.costs.find((c) => c.sessionId === "breakdown-roundtrip");
    expect(row).toBeDefined();
    expect(row?.modelBreakdown).toEqual(models);
    expect(row?.harnessCostUsd).toBe(9.99);
    expect(row?.cacheWrite5mTokens).toBe(0);
    expect(row?.cacheWrite1hTokens).toBe(5);
  });

  test("malformed stored breakdown JSON degrades to null instead of failing the listing", async () => {
    const post = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "breakdown-corrupt",
        agentId: testAgent.id,
        totalCostUsd: 1,
      }),
    });
    expect(post.status).toBe(201);
    await getDbClient().run("UPDATE session_costs SET modelBreakdown = ? WHERE sessionId = ?", [
      "{not json",
      "breakdown-corrupt",
    ]);

    const res = await authedFetch(`/api/session-costs?agentId=${testAgent.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      costs: Array<{ sessionId: string; modelBreakdown: unknown }>;
    };
    const row = body.costs.find((c) => c.sessionId === "breakdown-corrupt");
    expect(row).toBeDefined();
    expect(row?.modelBreakdown).toBeNull();
  });
});
