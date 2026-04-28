// Phase 6: Codex USD recompute on POST /api/session-costs.
//
// When the worker reports `provider='codex'` and DB pricing rows exist for
// all three token classes at the lookup time, the API recomputes
// `totalCostUsd` from tokens × DB prices and tags the row as
// `costSource='pricing-table'`. If any class is missing a row, fall back to
// the worker-reported value with `costSource='harness'`.
// Claude / pi paths always trust harness USD (`costSource='harness'`).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDb, initDb, insertPricingRow } from "../be/db";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-session-costs-codex-recompute.sqlite";
const API_KEY = "test-codex-recompute-secret";

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
  testAgent = createAgent({ name: "codex-test", isLead: false, status: "idle" });
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM session_costs").run();
  // Leave seed pricing rows in place; remove anything we added explicitly.
  db.prepare("DELETE FROM pricing WHERE effective_from > 0").run();
  // Also delete the seed rows for the synthetic models we use in some tests.
  db.prepare("DELETE FROM pricing WHERE model = 'codex-test-synth'").run();
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

interface CreatedCostResponse {
  success: boolean;
  cost: {
    id: string;
    totalCostUsd: number;
    costSource: "harness" | "pricing-table";
    model: string;
  };
}

describe("Phase 6 — POST /api/session-costs: Codex USD recompute", () => {
  test("provider=codex with all three pricing rows present → recompute uses DB prices, costSource='pricing-table'", async () => {
    // Mid-range custom rates: input=2.0/M, cached=0.2/M, output=10.0/M
    insertPricingRow({
      provider: "codex",
      model: "codex-test-synth",
      tokenClass: "input",
      effectiveFrom: 1,
      pricePerMillionUsd: 2.0,
    });
    insertPricingRow({
      provider: "codex",
      model: "codex-test-synth",
      tokenClass: "cached_input",
      effectiveFrom: 1,
      pricePerMillionUsd: 0.2,
    });
    insertPricingRow({
      provider: "codex",
      model: "codex-test-synth",
      tokenClass: "output",
      effectiveFrom: 1,
      pricePerMillionUsd: 10.0,
    });

    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "codex-recompute-1",
        agentId: testAgent.id,
        // Worker-reported value the API is expected to OVERWRITE.
        totalCostUsd: 999.99,
        inputTokens: 1_000_000, // 1M total input
        cacheReadTokens: 200_000, // 200k cached
        outputTokens: 500_000, // 500k output
        model: "codex-test-synth",
        provider: "codex",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedCostResponse;
    expect(body.cost.costSource).toBe("pricing-table");
    // uncached = 1_000_000 - 200_000 = 800_000
    // cost = (800_000 * 2.0 + 200_000 * 0.2 + 500_000 * 10.0) / 1_000_000
    //      = (1_600_000 + 40_000 + 5_000_000) / 1_000_000 = 6.64
    expect(body.cost.totalCostUsd).toBeCloseTo(6.64, 5);
  });

  test("provider=codex but a token class is missing → falls back to worker value, costSource='harness'", async () => {
    // Only seed input + cached_input. Missing output forces fallback.
    insertPricingRow({
      provider: "codex",
      model: "codex-test-synth",
      tokenClass: "input",
      effectiveFrom: 1,
      pricePerMillionUsd: 2.0,
    });
    insertPricingRow({
      provider: "codex",
      model: "codex-test-synth",
      tokenClass: "cached_input",
      effectiveFrom: 1,
      pricePerMillionUsd: 0.2,
    });

    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "codex-fallback-1",
        agentId: testAgent.id,
        totalCostUsd: 1.23,
        inputTokens: 100,
        outputTokens: 50,
        model: "codex-test-synth",
        provider: "codex",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedCostResponse;
    expect(body.cost.costSource).toBe("harness");
    // Worker value preserved verbatim.
    expect(body.cost.totalCostUsd).toBe(1.23);
  });

  test("provider=claude records harness USD as-is regardless of DB pricing rows", async () => {
    // Even if there are codex pricing rows, claude must NOT be touched.
    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "claude-passthrough-1",
        agentId: testAgent.id,
        totalCostUsd: 7.77,
        inputTokens: 100,
        outputTokens: 50,
        model: "sonnet-4",
        provider: "claude",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedCostResponse;
    expect(body.cost.costSource).toBe("harness");
    expect(body.cost.totalCostUsd).toBe(7.77);
  });

  test("provider=pi records harness USD as-is regardless of DB pricing rows", async () => {
    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "pi-passthrough-1",
        agentId: testAgent.id,
        totalCostUsd: 0.42,
        inputTokens: 10,
        outputTokens: 5,
        model: "openrouter/google/gemini-3-flash-preview",
        provider: "pi",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedCostResponse;
    expect(body.cost.costSource).toBe("harness");
    expect(body.cost.totalCostUsd).toBe(0.42);
  });

  test("provider field omitted → no recompute, costSource='harness' (back-compat)", async () => {
    // No `provider` field at all (legacy call shape). Expect harness path.
    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "legacy-1",
        agentId: testAgent.id,
        totalCostUsd: 1.0,
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreatedCostResponse;
    expect(body.cost.costSource).toBe("harness");
    expect(body.cost.totalCostUsd).toBe(1.0);
  });

  describe("historical correctness — older session_cost createdAt picks older effective_from", () => {
    // Anchor T0 well in the past so we can place newer rows around it.
    const T0 = 1_700_000_000_000; // 2023-11-14ish
    const PRICE_A = 1.0;
    const PRICE_B = 2.0;

    function postCost(opts: { sessionId: string; createdAt: number }) {
      return authedFetch(`/api/session-costs`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: opts.sessionId,
          agentId: testAgent.id,
          totalCostUsd: 999.99, // worker-reported, expected to be overwritten
          inputTokens: 1_000_000, // 1M input total
          cacheReadTokens: 0, // no cache for simplicity
          outputTokens: 0,
          model: "codex-test-synth",
          provider: "codex",
          createdAt: opts.createdAt,
          durationMs: 1_000,
          numTurns: 1,
        }),
      });
    }

    test("createdAt = T0+1 → uses price A (the only row at that time)", async () => {
      // Seed price A at T0, and the cached/output rows at the same time so all
      // three classes resolve.
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "input",
        effectiveFrom: T0,
        pricePerMillionUsd: PRICE_A,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "cached_input",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "output",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });

      const res = await postCost({ sessionId: "hist-1", createdAt: T0 + 1 });
      const body = (await res.json()) as CreatedCostResponse;
      expect(body.cost.costSource).toBe("pricing-table");
      expect(body.cost.totalCostUsd).toBeCloseTo(1.0, 5); // 1M * 1.0 / 1M
    });

    test("createdAt = T0+200 with new row at T0+100 → uses price B", async () => {
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "input",
        effectiveFrom: T0,
        pricePerMillionUsd: PRICE_A,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "cached_input",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "output",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });
      // Newer input row supersedes A from T0+100 onward.
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "input",
        effectiveFrom: T0 + 100,
        pricePerMillionUsd: PRICE_B,
      });

      const res = await postCost({ sessionId: "hist-2", createdAt: T0 + 200 });
      const body = (await res.json()) as CreatedCostResponse;
      expect(body.cost.costSource).toBe("pricing-table");
      expect(body.cost.totalCostUsd).toBeCloseTo(2.0, 5); // 1M * 2.0 / 1M
    });

    test("createdAt = T0+50 with new row at T0+100 → STILL uses price A (older effective_from)", async () => {
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "input",
        effectiveFrom: T0,
        pricePerMillionUsd: PRICE_A,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "cached_input",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "output",
        effectiveFrom: T0,
        pricePerMillionUsd: 0,
      });
      // Newer row exists, but the session_cost is older than T0+100.
      insertPricingRow({
        provider: "codex",
        model: "codex-test-synth",
        tokenClass: "input",
        effectiveFrom: T0 + 100,
        pricePerMillionUsd: PRICE_B,
      });

      const res = await postCost({ sessionId: "hist-3", createdAt: T0 + 50 });
      const body = (await res.json()) as CreatedCostResponse;
      expect(body.cost.costSource).toBe("pricing-table");
      // Older effective_from = T0 wins because session_cost.createdAt = T0+50 < T0+100.
      expect(body.cost.totalCostUsd).toBeCloseTo(1.0, 5);
    });
  });
});
