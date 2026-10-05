// A cancelled Amp session whose thread export never arrives still counts
// toward daily spend: POST /api/session-costs prices the stream's token totals
// at the model the mode runs, and that spend trips budget admission.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { canClaim } from "../be/budget-admission";
import {
  closeDb,
  createAgent,
  getDailySpendForAgent,
  getDbClient,
  initDb,
  insertPricingRow,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-amp-budget-export-failed.sqlite";
const API_KEY = "example-test-amp-budget";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const ok = await handleSessionData(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
      myAgentId,
    );
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  port = await listenOnFreePort(server);
  // Claude Opus 5.5, the model `medium` runs, at its models.dev rates.
  for (const [tokenClass, price] of [
    ["input", 4],
    ["output", 20],
    ["cache_read", 0.2],
    ["cache_write", 5],
  ] as const) {
    await insertPricingRow({
      provider: "amp",
      model: "claude-opus-5-5",
      tokenClass,
      effectiveFrom: 1,
      pricePerMillionUsd: price,
    });
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("amp session with no thread export", () => {
  test("a cancelled session adds its estimated cost to daily spend and trips the agent budget", async () => {
    const agent = await createAgent({ name: "amp-budget", isLead: false, status: "idle" });
    const today = new Date().toISOString().slice(0, 10);
    // $0.30 a day: room for the session to start, not for another after it.
    await getDbClient().run(
      "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
      ["agent", agent.id, 0.3, Date.now(), Date.now()],
    );
    expect((await canClaim(agent.id, new Date())).allowed).toBe(true);

    // What the adapter posts for a cancelled `medium` session: Amp billed
    // nothing it could report, the export was empty, so no `models`, the
    // requested mode as `model`, and the stream's token totals.
    const res = await fetch(`http://localhost:${port}/api/session-costs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "T-cancelled-amp-thread",
        agentId: agent.id,
        totalCostUsd: 0,
        inputTokens: 4,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheWriteTokens: 60_000,
        model: "medium",
        provider: "amp",
        isError: true,
        durationMs: 5_000,
        numTurns: null,
      }),
    });
    expect(res.status).toBe(201);
    const { cost } = (await res.json()) as {
      cost: { totalCostUsd: number; costSource: string; harnessCostUsd: number | null };
    };
    // 4 @ $4 + 400 @ $20 + 60,000 cache writes @ $5, per million tokens.
    const expected = (4 * 4 + 400 * 20 + 60_000 * 5) / 1_000_000;
    expect(cost.costSource).toBe("estimated");
    expect(cost.totalCostUsd).toBeCloseTo(expected, 12);
    expect(cost.harnessCostUsd).toBeNull();

    expect(await getDailySpendForAgent(agent.id, today)).toBeCloseTo(expected, 12);
    const admission = await canClaim(agent.id, new Date());
    expect(admission.allowed).toBe(false);
    if (admission.allowed) throw new Error("unreachable");
    expect(admission.cause).toBe("agent");
  });
});
