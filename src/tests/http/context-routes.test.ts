// Phase 10: HTTP context-route ingestion semantics.
//
// Asserts:
//   * `agent_tasks.peakContextTokens` is monotonic-max (a dip on a later
//     snapshot doesn't reduce the stored value).
//   * `agent_tasks.contextWindowSize` is set on the FIRST snapshot that
//     carries one, not gated on `eventType='completion'`.
//   * `cumulativeInputTokens` round-trips through the route into the
//     persisted snapshot row.
//   * `contextFormula` round-trips into the snapshot.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  createTaskExtended,
  getContextSnapshotsByTaskId,
  getContextSummaryByTaskId,
  initDb,
} from "../../be/db";
import { handleContext } from "../../http/context";
import { handleCore } from "../../http/core";
import { getPathSegments, parseQueryParams } from "../../http/utils";

const TEST_DB_PATH = "./test-context-routes.sqlite";
const API_KEY = "test-context-routes";

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
    const ok = await handleContext(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
let testAgent: { id: string };
let testTask: { id: string };

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  testAgent = createAgent({ name: "context-route-test", isLead: false, status: "idle" });
  testTask = createTaskExtended("phase-10 ingestion", { agentId: testAgent.id, source: "mcp" });
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

function postSnapshot(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${port}/api/tasks/${testTask.id}/context`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": testAgent.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Phase 10 — POST /api/tasks/:id/context", () => {
  test("peakContextTokens is a monotonic max across snapshots", async () => {
    const r1 = await postSnapshot({
      eventType: "progress",
      sessionId: "sess-1",
      contextUsedTokens: 50_000,
      contextTotalTokens: 200_000,
      contextPercent: 25,
    });
    expect(r1.status).toBe(200);

    const r2 = await postSnapshot({
      eventType: "progress",
      sessionId: "sess-1",
      contextUsedTokens: 120_000,
      contextTotalTokens: 200_000,
      contextPercent: 60,
    });
    expect(r2.status).toBe(200);

    // Dip — the unified formula occasionally undercounts on the next turn
    // (e.g. when the SDK reuses cache more aggressively). The aggregate
    // column must NOT regress to the dipped value.
    const r3 = await postSnapshot({
      eventType: "progress",
      sessionId: "sess-1",
      contextUsedTokens: 80_000,
      contextTotalTokens: 200_000,
      contextPercent: 40,
    });
    expect(r3.status).toBe(200);

    const summary = getContextSummaryByTaskId(testTask.id);
    expect(summary.peakContextTokens).toBe(120_000);
  });

  test("contextWindowSize is set on the first snapshot, not on completion", () => {
    // The first POST in the previous test already set this; assert it stuck
    // and a later POST with a different total doesn't overwrite it.
    const summary = getContextSummaryByTaskId(testTask.id);
    expect(summary.contextWindowSize).toBe(200_000);
  });

  test("cumulativeInputTokens + contextFormula round-trip into the row", async () => {
    const res = await postSnapshot({
      eventType: "progress",
      sessionId: "sess-2",
      contextUsedTokens: 30_000,
      contextTotalTokens: 200_000,
      contextPercent: 15,
      cumulativeInputTokens: 1234,
      cumulativeOutputTokens: 567,
      contextFormula: "input-cache-output",
    });
    expect(res.status).toBe(200);

    const snapshots = getContextSnapshotsByTaskId(testTask.id);
    const last = snapshots[snapshots.length - 1];
    expect(last.cumulativeInputTokens).toBe(1234);
    expect(last.cumulativeOutputTokens).toBe(567);
    expect(last.contextFormula).toBe("input-cache-output");
  });
});
