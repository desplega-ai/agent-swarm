// Phase 2 fix — adapter-emitted model ids carry harness-specific routing
// prefixes (`openrouter/`, `github-copilot/`, …) that the pricing seed does
// not. Before the fix every opencode + pi-via-copilot run fell through to
// `costSource='unpriced'` even when a seeded rate row existed. This suite
// regresses the drift cases observed in real-harness E2E.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDb, initDb, insertPricingRow } from "../be/db";
import { normalizeModelKey } from "../be/pricing-normalize";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-model-key-normalize.sqlite";
const API_KEY = "test-model-key-normalize";

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
  testAgent = createAgent({ name: "model-key-normalize-test", isLead: false, status: "idle" });
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
    model: string;
    costSource: "harness" | "pricing-table" | "unpriced";
  };
}

describe("normalizeModelKey()", () => {
  test("strips opencode routing prefix `openrouter/`", () => {
    expect(normalizeModelKey("opencode", "openrouter/anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  test("strips pi routing prefix `github-copilot/`", () => {
    expect(normalizeModelKey("pi", "github-copilot/gpt-5.4")).toBe("gpt-5.4");
  });

  test("strips pi routing prefix `openrouter/`", () => {
    expect(normalizeModelKey("pi", "openrouter/anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  test("strips ai-sdk-agent routing prefix `openai/`", () => {
    expect(normalizeModelKey("ai-sdk-agent", "openai/gpt-5.4")).toBe("gpt-5.4");
  });

  test("strips pi routing prefix `openrouter/` for deepseek (Phase 3 fix regression)", () => {
    // The exact case from today's E2E (2026-05-18): pi-mono emits
    // `openrouter/deepseek/deepseek-v4-flash`, the pricing seed keys the row
    // under bare `deepseek/deepseek-v4-flash`. Drift collapsed before this
    // assertion exists; keep it as an explicit regression guard.
    expect(normalizeModelKey("pi", "openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  test("strips opencode routing prefix `openrouter/` for deepseek (Phase 3 fix regression)", () => {
    // Same model, different harness — opencode-adapter wraps the underlying
    // model id under the same `openrouter/` proxy prefix.
    expect(normalizeModelKey("opencode", "openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  test("is a no-op for canonical claude ids", () => {
    expect(normalizeModelKey("claude", "claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(normalizeModelKey("claude", "claude-fable-5")).toBe("claude-fable-5");
    expect(normalizeModelKey("claude", "claude-mythos-5")).toBe("claude-mythos-5");
  });

  test("is idempotent", () => {
    const once = normalizeModelKey("opencode", "openrouter/anthropic/claude-sonnet-4.5");
    const twice = normalizeModelKey("opencode", once);
    expect(twice).toBe(once);
  });

  test("lowercases mixed-case input", () => {
    expect(normalizeModelKey("opencode", "OpenRouter/Anthropic/Claude-Sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });
});

describe("Phase 2 fix — POST /api/session-costs normalizes routing prefixes", () => {
  test("opencode `openrouter/anthropic/claude-sonnet-4.5` resolves the seeded `anthropic/claude-sonnet-4.5` row", async () => {
    // Seed mirrors what models.dev → seed-pricing.ts produces for the
    // openrouter section: bare `anthropic/<id>` under the `opencode` provider.
    insertPricingRow({
      provider: "opencode",
      model: "anthropic/claude-sonnet-4.5",
      tokenClass: "input",
      effectiveFrom: 1,
      pricePerMillionUsd: 3,
    });
    insertPricingRow({
      provider: "opencode",
      model: "anthropic/claude-sonnet-4.5",
      tokenClass: "output",
      effectiveFrom: 1,
      pricePerMillionUsd: 15,
    });

    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "opencode-normalize-1",
        agentId: testAgent.id,
        totalCostUsd: 0.42, // harness-reported, expected to be overwritten
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        // The exact string the opencode adapter emits today.
        model: "openrouter/anthropic/claude-sonnet-4.5",
        provider: "opencode",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CostResponse;
    // 1M @ $3 + 100k @ $15 = $3 + $1.50 = $4.50
    expect(body.cost.costSource).toBe("pricing-table");
    expect(body.cost.totalCostUsd).toBeCloseTo(4.5, 5);
    // Original adapter-emitted string is preserved on the row for debugging.
    expect(body.cost.model).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  test("pi `github-copilot/gpt-5.4` resolves the seeded bare `gpt-5.4` row", async () => {
    insertPricingRow({
      provider: "pi",
      model: "gpt-5.4",
      tokenClass: "input",
      effectiveFrom: 1,
      pricePerMillionUsd: 2,
    });
    insertPricingRow({
      provider: "pi",
      model: "gpt-5.4",
      tokenClass: "output",
      effectiveFrom: 1,
      pricePerMillionUsd: 8,
    });

    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "pi-copilot-normalize-1",
        agentId: testAgent.id,
        totalCostUsd: 9.99,
        inputTokens: 500_000,
        outputTokens: 250_000,
        model: "github-copilot/gpt-5.4",
        provider: "pi",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CostResponse;
    // 500k @ $2 + 250k @ $8 = $1 + $2 = $3
    expect(body.cost.costSource).toBe("pricing-table");
    expect(body.cost.totalCostUsd).toBeCloseTo(3.0, 5);
    expect(body.cost.model).toBe("github-copilot/gpt-5.4");
  });

  test("claude `claude-opus-4-7` (no prefix) still resolves — regression guard", async () => {
    // The bug report flagged claude-adapter as already-working. Make sure
    // we did not regress its bare-id lookup.
    insertPricingRow({
      provider: "claude",
      model: "claude-opus-4-7",
      tokenClass: "input",
      effectiveFrom: 1,
      pricePerMillionUsd: 15,
    });
    insertPricingRow({
      provider: "claude",
      model: "claude-opus-4-7",
      tokenClass: "output",
      effectiveFrom: 1,
      pricePerMillionUsd: 75,
    });

    const res = await authedFetch(`/api/session-costs`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "claude-bare-1",
        agentId: testAgent.id,
        totalCostUsd: 1.23,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        model: "claude-opus-4-7",
        provider: "claude",
        durationMs: 1_000,
        numTurns: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CostResponse;
    // 1M @ $15 + 100k @ $75 = $15 + $7.50 = $22.50
    expect(body.cost.costSource).toBe("pricing-table");
    expect(body.cost.totalCostUsd).toBeCloseTo(22.5, 5);
  });
});
