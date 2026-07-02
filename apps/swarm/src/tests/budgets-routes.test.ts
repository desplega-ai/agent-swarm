// Phase 6: REST CRUD + audit-log + auth tests for /api/budgets/*.
//
// Spins up a real HTTP server using `handleCore` (auth gate) → `handleBudgets`
// so we exercise the full request lifecycle including the API-key bearer
// check. Direct invocation of `handleBudgets` would bypass auth.

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
  getDb,
  getLogsByEventType,
  initDb,
  recordBudgetRefusalNotification,
} from "../be/db";
import { handleBudgets } from "../http/budgets";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-budgets-routes.sqlite";
const API_KEY = "test-budget-secret-key";

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
    const ok = await handleBudgets(req, res, pathSegments, queryParams, myAgentId);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
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
  db.prepare("DELETE FROM budgets").run();
  db.prepare("DELETE FROM agent_log WHERE eventType LIKE 'budget.%'").run();
  db.prepare("DELETE FROM budget_refusal_notifications").run();
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

describe("Phase 6 — /api/budgets REST surface", () => {
  describe("auth", () => {
    test("401 when Authorization header is missing", async () => {
      const res = await fetch(`http://localhost:${port}/api/budgets`);
      expect(res.status).toBe(401);
    });

    test("401 when bearer is wrong", async () => {
      const res = await fetch(`http://localhost:${port}/api/budgets`, {
        headers: { Authorization: "Bearer WRONG" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("CRUD round-trip", () => {
    test("PUT creates → GET returns 200 with the row → list includes it", async () => {
      const agentId = "agent-uuid-1";
      const putRes = await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 5 }),
      });
      expect(putRes.status).toBe(200);
      const created = await putRes.json();
      expect(created.scope).toBe("agent");
      expect(created.scopeId).toBe(agentId);
      expect(created.dailyBudgetUsd).toBe(5);

      const getRes = await authedFetch(`/api/budgets/agent/${agentId}`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.dailyBudgetUsd).toBe(5);

      const listRes = await authedFetch(`/api/budgets`);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.budgets).toBeInstanceOf(Array);
      expect(listBody.budgets.length).toBe(1);
      expect(listBody.budgets[0].scopeId).toBe(agentId);
    });

    test("PUT upserts an existing row", async () => {
      const agentId = "agent-uuid-2";
      await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 1 }),
      });
      const putRes = await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 9 }),
      });
      expect(putRes.status).toBe(200);
      const updated = await putRes.json();
      expect(updated.dailyBudgetUsd).toBe(9);
    });

    test("PUT for the global scope uses '_global' wire placeholder", async () => {
      const putRes = await authedFetch(`/api/budgets/global/_global`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 100 }),
      });
      expect(putRes.status).toBe(200);
      const created = await putRes.json();
      expect(created.scope).toBe("global");
      expect(created.scopeId).toBe("");

      const getRes = await authedFetch(`/api/budgets/global/_global`);
      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.scopeId).toBe("");
      expect(fetched.dailyBudgetUsd).toBe(100);
    });

    test("GET returns 404 for missing budget", async () => {
      const getRes = await authedFetch(`/api/budgets/agent/does-not-exist`);
      expect(getRes.status).toBe(404);
    });

    test("DELETE returns 204 then 404 on subsequent GET", async () => {
      const agentId = "agent-uuid-3";
      await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 5 }),
      });
      const delRes = await authedFetch(`/api/budgets/agent/${agentId}`, { method: "DELETE" });
      expect(delRes.status).toBe(204);
      const getRes = await authedFetch(`/api/budgets/agent/${agentId}`);
      expect(getRes.status).toBe(404);
    });

    test("DELETE on missing row returns 404", async () => {
      const delRes = await authedFetch(`/api/budgets/agent/never-existed`, { method: "DELETE" });
      expect(delRes.status).toBe(404);
    });

    test("PUT 400 when dailyBudgetUsd is missing", async () => {
      const res = await authedFetch(`/api/budgets/agent/x`, {
        method: "PUT",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test("PUT 400 when dailyBudgetUsd is negative", async () => {
      const res = await authedFetch(`/api/budgets/agent/x`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: -1 }),
      });
      expect(res.status).toBe(400);
    });

    test("PUT 400 on invalid scope", async () => {
      const res = await authedFetch(`/api/budgets/team/x`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 1 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("audit logging", () => {
    test("PUT writes a budget.upserted log row with key fingerprint and before/after", async () => {
      const agentId = "audit-agent-1";
      await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 3 }),
      });
      // Update — should produce a SECOND audit row with before set.
      await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 7 }),
      });

      const logs = getLogsByEventType("budget.upserted");
      expect(logs.length).toBe(2);

      // Logs land within the same millisecond so the DESC-by-createdAt order
      // is non-deterministic between the two. Identify them by payload shape:
      // the insert log has `before === null`; the update log has the previous
      // dailyBudgetUsd in `before`.
      const metas = logs.map((l) => JSON.parse(l.metadata!));
      const insertMeta = metas.find((m) => m.before === null)!;
      const updateMeta = metas.find((m) => m.before !== null)!;

      expect(insertMeta.scope).toBe("agent");
      expect(insertMeta.scopeId).toBe(agentId);
      expect(insertMeta.before).toBeNull();
      expect(insertMeta.after.dailyBudgetUsd).toBe(3);
      expect(insertMeta.apiKeyFingerprint).toMatch(/^[a-f0-9]{8}$/);
      // Raw key MUST NEVER appear in the metadata payload.
      for (const log of logs) {
        expect(log.metadata).not.toContain(API_KEY);
      }

      expect(updateMeta.before.dailyBudgetUsd).toBe(3);
      expect(updateMeta.after.dailyBudgetUsd).toBe(7);
      expect(updateMeta.apiKeyFingerprint).toMatch(/^[a-f0-9]{8}$/);
    });

    test("GET /api/budgets/refusals returns recent refusals newest first", async () => {
      // Seed three refusals across two days/agents.
      recordBudgetRefusalNotification({
        taskId: "task-old",
        date: "2026-04-26",
        agentId: "agent-A",
        cause: "agent",
        agentSpendUsd: 1.5,
        agentBudgetUsd: 1.0,
      });
      // Force a small gap so createdAt ordering is deterministic.
      await new Promise((r) => setTimeout(r, 5));
      recordBudgetRefusalNotification({
        taskId: "task-mid",
        date: "2026-04-27",
        agentId: "agent-B",
        cause: "global",
        globalSpendUsd: 50,
        globalBudgetUsd: 40,
      });
      await new Promise((r) => setTimeout(r, 5));
      recordBudgetRefusalNotification({
        taskId: "task-new",
        date: "2026-04-28",
        agentId: "agent-A",
        cause: "agent",
        agentSpendUsd: 2.0,
        agentBudgetUsd: 1.5,
      });

      const res = await authedFetch(`/api/budgets/refusals`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refusals).toBeInstanceOf(Array);
      expect(body.refusals.length).toBe(3);
      // Newest first by createdAt.
      expect(body.refusals[0].taskId).toBe("task-new");
      expect(body.refusals[1].taskId).toBe("task-mid");
      expect(body.refusals[2].taskId).toBe("task-old");
      expect(body.refusals[0].cause).toBe("agent");
      expect(body.refusals[1].cause).toBe("global");
    });

    test("GET /api/budgets/refusals respects limit query param", async () => {
      for (let i = 0; i < 5; i++) {
        recordBudgetRefusalNotification({
          taskId: `task-${i}`,
          date: "2026-04-28",
          agentId: "agent-A",
          cause: "agent",
        });
        await new Promise((r) => setTimeout(r, 2));
      }
      const res = await authedFetch(`/api/budgets/refusals?limit=2`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refusals.length).toBe(2);
    });

    test("DELETE writes a budget.deleted log row with key fingerprint", async () => {
      const agentId = "audit-agent-2";
      await authedFetch(`/api/budgets/agent/${agentId}`, {
        method: "PUT",
        body: JSON.stringify({ dailyBudgetUsd: 4 }),
      });
      await authedFetch(`/api/budgets/agent/${agentId}`, { method: "DELETE" });

      const logs = getLogsByEventType("budget.deleted");
      expect(logs.length).toBe(1);
      const meta = JSON.parse(logs[0].metadata!);
      expect(meta.scope).toBe("agent");
      expect(meta.scopeId).toBe(agentId);
      expect(meta.before.dailyBudgetUsd).toBe(4);
      expect(meta.apiKeyFingerprint).toMatch(/^[a-f0-9]{8}$/);
      expect(logs[0].metadata).not.toContain(API_KEY);
    });
  });
});
