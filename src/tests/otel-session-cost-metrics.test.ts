// Unit tests for the OTEL metric-emission path introduced in
// src/http/session-data.ts (recordSessionCost call) and src/otel.ts (facade).
//
// Coverage goals:
//   1. otel.ts recordSessionCost() is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
//   2. handleSessionData() forwards the recomputed totalCostUsd + costSource to
//      recordSessionCost() — not the raw request value.
//   3. All six token classes map to the expected token_type keys.
//   4. harness / pricing-table / unpriced / zero-cost cases are all covered.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDb, initDb, insertPricingRow } from "../be/db";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { SessionCostMetric } from "../otel";

// ── 1. Verify the otel.ts facade is a no-op when OTEL is disabled ────────────

describe("otel.ts recordSessionCost — no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
  test("does not throw and is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    // The test environment never sets OTEL_EXPORTER_OTLP_ENDPOINT, so the
    // facade's `enabled` flag is false and realRecordSessionCost is undefined.
    const { recordSessionCost } = await import("../otel");
    expect(() =>
      recordSessionCost({
        totalCostUsd: 0.05,
        harness: "claude",
        model: "claude-sonnet-4-6",
        costSource: "harness",
        isError: false,
        tokens: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          thinking: 0,
        },
      }),
    ).not.toThrow();
  });
});

// ── 2-4. handleSessionData() → recordSessionCost() integration ───────────────

const recordSessionCostSpy = mock((_m: SessionCostMetric) => {});

// `mock.module` is process-global and is never auto-restored, so it leaks into
// every test file that runs after this one in the same `bun test` process.
// Spread the real module and override ONLY `recordSessionCost`: that keeps the
// genuine NOOP-based `withSpan`/`startSpan` (whose spans expose the full
// SwarmSpan surface, incl. `setAttributes`) so the leaked mock can't break
// unrelated MCP-tool tests via `span.setAttributes` in createToolRegistrar.
const actualOtel = await import("../otel");
// Mock ../otel BEFORE importing handleSessionData so the module picks up our spy.
mock.module("../otel", () => ({
  ...actualOtel,
  recordSessionCost: recordSessionCostSpy,
}));

const { handleSessionData } = await import("../http/session-data");

const TEST_DB_PATH = "./test-otel-session-cost-metrics.sqlite";
const API_KEY = "test-otel-metrics";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, API_KEY);
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
let agentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "otel-metrics-test", isLead: false, status: "idle" }).id;
  server = createTestServer();
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

afterEach(() => {
  recordSessionCostSpy.mockClear();
  getDb().prepare("DELETE FROM session_costs").run();
  getDb().prepare("DELETE FROM pricing WHERE effective_from > 0").run();
});

function authedPost(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${port}/api/session-costs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// Helper to seed a minimal two-class pricing row for recompute tests.
function seedRates(provider: string, model: string, inputRate = 1, outputRate = 2) {
  for (const tokenClass of ["input", "output"] as const) {
    insertPricingRow({
      provider: provider as Parameters<typeof insertPricingRow>[0]["provider"],
      model,
      tokenClass,
      pricePerMillionUsd: tokenClass === "input" ? inputRate : outputRate,
      effectiveFrom: 1,
    });
  }
}

describe("handleSessionData → recordSessionCost forwarding", () => {
  test("harness costSource: forwards provider-supplied totalCostUsd unchanged", async () => {
    const res = await authedPost({
      sessionId: "otel-harness-test",
      agentId,
      totalCostUsd: 0.123,
      model: "opus",
      isError: false,
    });
    expect(res.status).toBe(201);

    expect(recordSessionCostSpy).toHaveBeenCalledTimes(1);
    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.costSource).toBe("harness");
    expect(arg.totalCostUsd).toBeCloseTo(0.123, 6);
    expect(arg.harness).toBe("unknown"); // no provider → "unknown"
    expect(arg.isError).toBe(false);
  });

  test("pricing-table costSource: forwards recomputed totalCostUsd", async () => {
    seedRates("claude", "claude-sonnet", 1, 5);

    const res = await authedPost({
      sessionId: "otel-pricing-table-test",
      agentId,
      totalCostUsd: 999, // should be overwritten by recompute
      provider: "claude",
      model: "claude-sonnet",
      inputTokens: 1_000_000, // 1 M input → $1 at rate 1
      outputTokens: 1_000_000, // 1 M output → $5 at rate 5
      isError: false,
    });
    expect(res.status).toBe(201);

    expect(recordSessionCostSpy).toHaveBeenCalledTimes(1);
    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.costSource).toBe("pricing-table");
    expect(arg.totalCostUsd).toBeCloseTo(6, 4); // $1 + $5
    expect(arg.harness).toBe("claude");
  });

  test("unpriced costSource: unknown (provider, model) pair", async () => {
    const res = await authedPost({
      sessionId: "otel-unpriced-test",
      agentId,
      totalCostUsd: 0,
      provider: "devin",
      model: "no-such-model",
      inputTokens: 500,
      outputTokens: 200,
      isError: false,
    });
    expect(res.status).toBe(201);

    expect(recordSessionCostSpy).toHaveBeenCalledTimes(1);
    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.costSource).toBe("unpriced");
    expect(arg.harness).toBe("devin");
  });

  test("isError flag is forwarded correctly", async () => {
    const res = await authedPost({
      sessionId: "otel-error-test",
      agentId,
      totalCostUsd: 0.01,
      isError: true,
    });
    expect(res.status).toBe(201);

    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.isError).toBe(true);
  });

  test("all six token classes are forwarded to the tokens map", async () => {
    const res = await authedPost({
      sessionId: "otel-token-classes-test",
      agentId,
      totalCostUsd: 0.5,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      reasoningOutputTokens: 50,
      thinkingTokens: 25,
      isError: false,
    });
    expect(res.status).toBe(201);

    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.tokens.input).toBe(1000);
    expect(arg.tokens.output).toBe(500);
    expect(arg.tokens.cacheRead).toBe(200);
    expect(arg.tokens.cacheWrite).toBe(100);
    expect(arg.tokens.reasoning).toBe(50);
    expect(arg.tokens.thinking).toBe(25);
  });

  test("zero-cost session: recordSessionCost is still called", async () => {
    const res = await authedPost({
      sessionId: "otel-zero-cost-test",
      agentId,
      totalCostUsd: 0,
      isError: false,
    });
    expect(res.status).toBe(201);

    // Even a zero-cost session must be reported so token counters can accumulate.
    expect(recordSessionCostSpy).toHaveBeenCalledTimes(1);
    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.totalCostUsd).toBe(0);
  });

  test("omitted token fields default to 0 in the tokens map", async () => {
    const res = await authedPost({
      sessionId: "otel-token-defaults-test",
      agentId,
      totalCostUsd: 0.01,
    });
    expect(res.status).toBe(201);

    const arg = recordSessionCostSpy.mock.calls[0]![0];
    expect(arg.tokens.input).toBe(0);
    expect(arg.tokens.output).toBe(0);
    expect(arg.tokens.cacheRead).toBe(0);
    expect(arg.tokens.cacheWrite).toBe(0);
    expect(arg.tokens.reasoning).toBe(0);
    expect(arg.tokens.thinking).toBe(0);
  });
});
