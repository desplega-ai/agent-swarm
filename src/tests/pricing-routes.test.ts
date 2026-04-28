// Phase 6: REST CRUD + audit-log + auth tests for /api/pricing/*.
//
// The pricing surface is append-only — operators add a new row with a later
// `effective_from` rather than mutating an existing one. `POST` collisions
// on the same `(provider, model, token_class, effective_from)` PK return 409.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getDb, getLogsByEventType, initDb } from "../be/db";
import { handleCore } from "../http/core";
import { handlePricing } from "../http/pricing";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-pricing-routes.sqlite";
const API_KEY = "test-pricing-secret-key";

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
    const ok = await handlePricing(req, res, pathSegments, queryParams, myAgentId);
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
  // Remove every non-seed pricing row so each test starts from the migration
  // 044 seed (effective_from=0). The seed uses literal 0 for effective_from.
  db.prepare("DELETE FROM pricing WHERE effective_from > 0").run();
  db.prepare("DELETE FROM agent_log WHERE eventType LIKE 'pricing.%'").run();
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

describe("Phase 6 — /api/pricing REST surface", () => {
  describe("auth", () => {
    test("401 when Authorization header is missing", async () => {
      const res = await fetch(`http://localhost:${port}/api/pricing`);
      expect(res.status).toBe(401);
    });

    test("401 when bearer is wrong", async () => {
      const res = await fetch(`http://localhost:${port}/api/pricing`, {
        headers: { Authorization: "Bearer WRONG" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("read endpoints", () => {
    test("GET /api/pricing lists every row including the migration 044 seed", async () => {
      const res = await authedFetch(`/api/pricing`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toBeInstanceOf(Array);
      // Migration 044 seeds 12 codex rows with effective_from=0. They should
      // all be present here.
      const seedRows = body.rows.filter(
        (r: { provider: string; effectiveFrom: number }) =>
          r.provider === "codex" && r.effectiveFrom === 0,
      );
      expect(seedRows.length).toBe(12);
    });

    test("GET /api/pricing/{provider}/{model}/{tokenClass} returns rows latest-first", async () => {
      // Insert two new rows on top of the existing seed for gpt-5.3-codex/input.
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 2.0, effectiveFrom: 1_000 }),
      });
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 2.5, effectiveFrom: 5_000 }),
      });

      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows.length).toBe(3);
      // Newest first.
      expect(body.rows[0].effectiveFrom).toBe(5_000);
      expect(body.rows[1].effectiveFrom).toBe(1_000);
      expect(body.rows[2].effectiveFrom).toBe(0);
    });

    test("GET /api/pricing/.../{tokenClass} returns empty list (NOT 404) for unseeded triple", async () => {
      const res = await authedFetch(`/api/pricing/claude/sonnet-4/input`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toEqual([]);
    });

    test("GET /api/pricing/.../active returns the largest effective_from <= now", async () => {
      const past = Date.now() - 10_000;
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 99.0, effectiveFrom: past }),
      });
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input/active`);
      expect(res.status).toBe(200);
      const row = await res.json();
      expect(row.effectiveFrom).toBe(past);
      expect(row.pricePerMillionUsd).toBe(99.0);
    });

    test("GET /api/pricing/.../active returns 404 for unseeded triple with no rows", async () => {
      const res = await authedFetch(`/api/pricing/claude/sonnet-4/input/active`);
      expect(res.status).toBe(404);
    });
  });

  describe("write endpoints", () => {
    test("POST inserts a new row, returns 201, body matches", async () => {
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1.5, effectiveFrom: 12_345 }),
      });
      expect(res.status).toBe(201);
      const row = await res.json();
      expect(row.provider).toBe("codex");
      expect(row.model).toBe("gpt-5.3-codex");
      expect(row.tokenClass).toBe("input");
      expect(row.effectiveFrom).toBe(12_345);
      expect(row.pricePerMillionUsd).toBe(1.5);
    });

    test("POST defaults effectiveFrom to Date.now() when omitted", async () => {
      const before = Date.now();
      const res = await authedFetch(`/api/pricing/codex/gpt-5.4/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 3.0 }),
      });
      const after = Date.now();
      expect(res.status).toBe(201);
      const row = await res.json();
      expect(row.effectiveFrom).toBeGreaterThanOrEqual(before);
      expect(row.effectiveFrom).toBeLessThanOrEqual(after);
    });

    test("POST 409 on duplicate (provider, model, tokenClass, effectiveFrom)", async () => {
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1.5, effectiveFrom: 99_999 }),
      });
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 2.0, effectiveFrom: 99_999 }),
      });
      expect(res.status).toBe(409);
    });

    test("same-millisecond collision: two rapid POSTs without explicit effectiveFrom may 409; explicit unblocks", async () => {
      // Run two POSTs back-to-back. They MIGHT land on the same Date.now() millisecond.
      // If they do, the second returns 409. If they don't, both succeed.
      const r1 = await authedFetch(`/api/pricing/codex/gpt-5.4-mini/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 0.5 }),
      });
      const r2 = await authedFetch(`/api/pricing/codex/gpt-5.4-mini/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 0.6 }),
      });
      // At least the first must succeed.
      expect(r1.status).toBe(201);
      expect([201, 409]).toContain(r2.status);

      // Workaround: pass an explicit effectiveFrom that we KNOW is unique.
      // It still must not collide with r1's effective_from. Use a future ms.
      const futureMs = Date.now() + 10_000;
      const r3 = await authedFetch(`/api/pricing/codex/gpt-5.4-mini/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 0.7, effectiveFrom: futureMs }),
      });
      expect(r3.status).toBe(201);
    });

    test("POST 400 on invalid body (negative price)", async () => {
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: -1 }),
      });
      expect(res.status).toBe(400);
    });

    test("POST 400 on invalid provider", async () => {
      const res = await authedFetch(`/api/pricing/totally-fake/x/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1 }),
      });
      expect(res.status).toBe(400);
    });

    test("POST 400 on invalid token class", async () => {
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/wrong-class`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1 }),
      });
      expect(res.status).toBe(400);
    });

    test("DELETE removes a row, returns 204, GET reflects removal", async () => {
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1.5, effectiveFrom: 42 }),
      });
      const delRes = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input/42`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(204);

      const listRes = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`);
      const body = await listRes.json();
      const found = body.rows.find((r: { effectiveFrom: number }) => r.effectiveFrom === 42);
      expect(found).toBeUndefined();
    });

    test("DELETE 404 when row does not exist", async () => {
      const res = await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input/123456789`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("audit logging", () => {
    test("POST writes a pricing.inserted log row with key fingerprint", async () => {
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1.5, effectiveFrom: 100 }),
      });

      const logs = getLogsByEventType("pricing.inserted");
      expect(logs.length).toBe(1);
      const meta = JSON.parse(logs[0].metadata!);
      expect(meta.provider).toBe("codex");
      expect(meta.model).toBe("gpt-5.3-codex");
      expect(meta.tokenClass).toBe("input");
      expect(meta.effectiveFrom).toBe(100);
      expect(meta.pricePerMillionUsd).toBe(1.5);
      expect(meta.apiKeyFingerprint).toMatch(/^[a-f0-9]{8}$/);
      expect(logs[0].metadata).not.toContain(API_KEY);
    });

    test("DELETE writes a pricing.deleted log row with key fingerprint", async () => {
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input`, {
        method: "POST",
        body: JSON.stringify({ pricePerMillionUsd: 1.5, effectiveFrom: 200 }),
      });
      await authedFetch(`/api/pricing/codex/gpt-5.3-codex/input/200`, { method: "DELETE" });

      const logs = getLogsByEventType("pricing.deleted");
      expect(logs.length).toBe(1);
      const meta = JSON.parse(logs[0].metadata!);
      expect(meta.provider).toBe("codex");
      expect(meta.effectiveFrom).toBe(200);
      expect(meta.apiKeyFingerprint).toMatch(/^[a-f0-9]{8}$/);
      expect(logs[0].metadata).not.toContain(API_KEY);
    });
  });
});
