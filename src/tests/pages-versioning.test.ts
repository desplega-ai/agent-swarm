/**
 * PUT /api/pages/:id versioning behavior.
 *
 * Per the plan (step-3 §1): each PUT calls `snapshotPage(id)` BEFORE
 * `updatePage(id, …)`, so each row in `page_versions` holds the parent
 * state as it stood IMMEDIATELY BEFORE that PUT. After three PUTs of a
 * page created with body "v0", the version table should hold:
 *   v1: snapshot.body = "v0" (state before PUT #1)
 *   v2: snapshot.body = "v1" (state before PUT #2)
 *   v3: snapshot.body = "v2" (state before PUT #3)
 * And the parent (final state) holds "v3".
 *
 * Edit-counter returned to the caller is `MAX(version) + 1`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { PageVersion } from "../types";

const TEST_DB_PATH = "./test-pages-versioning.sqlite";
const TEST_PORT = 13041;
const BASE = `http://localhost:${TEST_PORT}`;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handlePages(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
}

describe("Pages versioning (PUT /api/pages/:id)", () => {
  let server: Server;
  const agentId = crypto.randomUUID();
  const headers = { "Content-Type": "application/json", "X-Agent-ID": agentId };

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = createTestServer();
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("three PUTs produce three version snapshots holding pre-update content", async () => {
    // Create with body v0.
    const created = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "vers",
        title: "Versioning",
        contentType: "text/html",
        authMode: "public",
        body: "v0",
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string; version: number };

    // PUT v1, v2, v3.
    for (const body of ["v1", "v2", "v3"]) {
      const res = await fetch(`${BASE}/api/pages/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(200);
    }

    // Final state is "v3".
    const head = await fetch(`${BASE}/api/pages/${id}`, { headers });
    expect(head.status).toBe(200);
    const headPage = (await head.json()) as { body: string };
    expect(headPage.body).toBe("v3");

    // Versions: newest-first, so v3..v1 holding v2, v1, v0 respectively.
    const versionsRes = await fetch(`${BASE}/api/pages/${id}/versions`, { headers });
    expect(versionsRes.status).toBe(200);
    const { versions } = (await versionsRes.json()) as { versions: PageVersion[] };
    expect(versions).toHaveLength(3);
    expect(versions[0]!.version).toBe(3);
    expect(versions[0]!.snapshot.body).toBe("v2");
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.snapshot.body).toBe("v1");
    expect(versions[2]!.version).toBe(1);
    expect(versions[2]!.snapshot.body).toBe("v0");
  });

  test("PUT response includes monotonically-increasing edit-counter version", async () => {
    const created = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "counter",
        title: "Counter",
        contentType: "text/html",
        authMode: "public",
        body: "x0",
      }),
    });
    const { id, version: createdVersion } = (await created.json()) as {
      id: string;
      version: number;
    };
    expect(createdVersion).toBe(1);

    const observed: number[] = [];
    for (const body of ["x1", "x2", "x3"]) {
      const res = await fetch(`${BASE}/api/pages/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ body }),
      });
      const json = (await res.json()) as { version: number };
      observed.push(json.version);
    }
    expect(observed).toEqual([2, 3, 4]);
  });

  test("PUT 404 for unknown id", async () => {
    const res = await fetch(`${BASE}/api/pages/${"0".repeat(32)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "noop" }),
    });
    expect(res.status).toBe(404);
  });

  test("GET /api/pages/:id/versions/:version returns single snapshot", async () => {
    const created = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "byversion",
        title: "ByVersion",
        contentType: "text/html",
        authMode: "public",
        body: "alpha",
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await fetch(`${BASE}/api/pages/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "beta" }),
    });
    const single = await fetch(`${BASE}/api/pages/${id}/versions/1`, { headers });
    expect(single.status).toBe(200);
    const row = (await single.json()) as PageVersion;
    expect(row.version).toBe(1);
    expect(row.snapshot.body).toBe("alpha");

    const missing = await fetch(`${BASE}/api/pages/${id}/versions/999`, { headers });
    expect(missing.status).toBe(404);
  });

  test("DELETE /api/pages/:id removes parent + cascades version rows", async () => {
    const created = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "doomed",
        title: "Doomed",
        contentType: "text/html",
        authMode: "public",
        body: "x",
      }),
    });
    const { id } = (await created.json()) as { id: string };

    // Force a version snapshot via a PUT.
    await fetch(`${BASE}/api/pages/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "y" }),
    });

    const del = await fetch(`${BASE}/api/pages/${id}`, { method: "DELETE", headers });
    expect(del.status).toBe(204);

    const after = await fetch(`${BASE}/api/pages/${id}`, { headers });
    expect(after.status).toBe(404);

    const afterVersions = await fetch(`${BASE}/api/pages/${id}/versions`, { headers });
    expect(afterVersions.status).toBe(404);
  });

  test("GET /api/pages lists with share-URL pointers + total", async () => {
    const listRes = await fetch(`${BASE}/api/pages?limit=10&offset=0`, { headers });
    expect(listRes.status).toBe(200);
    const json = (await listRes.json()) as {
      pages: Array<{ id: string; api_url: string; app_url: string }>;
      total: number;
    };
    expect(Array.isArray(json.pages)).toBe(true);
    expect(typeof json.total).toBe("number");
    for (const p of json.pages) {
      expect(p.api_url).toContain(`/p/${p.id}`);
      expect(p.app_url).toContain(`/pages/${p.id}`);
    }
  });
});
