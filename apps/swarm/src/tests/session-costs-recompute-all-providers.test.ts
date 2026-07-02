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
import { closeDb, createAgent, getDb, initDb, insertPricingRow } from "../be/db";
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
  testAgent = createAgent({ name: "recompute-all-test", isLead: false, status: "idle" });
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
  // Wipe everything we explicitly inserted (effective_from > 0); leave the
  // migration-046 codex seeds alone.
  db.prepare("DELETE FROM pricing WHERE effective_from > 0").run();
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
    costSource: "harness" | "pricing-table" | "unpriced";
  };
}

function seedTwoClassRates(provider: string, model: string, inputRate = 1, outputRate = 10) {
  insertPricingRow({
    provider: provider as Parameters<typeof insertPricingRow>[0]["provider"],
    model,
    tokenClass: "input",
    effectiveFrom: 1,
    pricePerMillionUsd: inputRate,
  });
  insertPricingRow({
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
      seedTwoClassRates(provider, `${provider}-test-model`, 2, 10);

      const res = await authedFetch(`/api/session-costs`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: `${provider}-recompute-1`,
          agentId: testAgent.id,
          totalCostUsd: 999.99, // worker-reported; expected to be overwritten
          inputTokens: 1_000_000, // 1M input
          outputTokens: 500_000, // 500k output
          model: `${provider}-test-model`,
          provider,
          durationMs: 1_000,
          numTurns: 1,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CostResponse;
      expect(body.cost.costSource).toBe("pricing-table");
      // 1M @ 2 + 0.5M @ 10 = $2 + $5 = $7
      expect(body.cost.totalCostUsd).toBeCloseTo(7.0, 5);
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
