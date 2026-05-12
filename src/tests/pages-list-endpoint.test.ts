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
import type { Page } from "../types";

const TEST_DB_PATH = "./test-pages-list-endpoint.sqlite";
const TEST_PORT = 13046;
const baseUrl = `http://localhost:${TEST_PORT}`;

type PageWithUrls = Page & { app_url: string; api_url: string };
type ListResponse = { pages: PageWithUrls[]; total: number };

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handlePages(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

/**
 * Helper: POST /api/pages as `agentId`. Returns the created id.
 */
async function seedPage(opts: { agentId: string; slug: string; title: string }): Promise<string> {
  const res = await fetch(`${baseUrl}/api/pages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": opts.agentId,
    },
    body: JSON.stringify({
      slug: opts.slug,
      title: opts.title,
      contentType: "text/html",
      authMode: "public",
      body: `<h1>${opts.title}</h1>`,
    }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  return json.id;
}

describe("GET /api/pages — listing endpoint", () => {
  let server: Server;
  const agentA = crypto.randomUUID();
  const agentB = crypto.randomUUID();

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });

    // Seed: two pages under agentA, one under agentB.
    await seedPage({ agentId: agentA, slug: "a-1", title: "A One" });
    await seedPage({ agentId: agentA, slug: "a-2", title: "A Two" });
    await seedPage({ agentId: agentB, slug: "b-1", title: "B One" });
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

  test("returns all pages with share URLs when no filter is supplied", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      headers: { "X-Agent-ID": agentA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.pages.length).toBe(3);
    expect(body.total).toBe(3);
    // Every row carries share URLs.
    for (const page of body.pages) {
      expect(page.app_url).toMatch(/\/pages\//);
      expect(page.api_url).toMatch(/\/p\//);
    }
  });

  test("filters by agentId when query supplied", async () => {
    const aRes = await fetch(`${baseUrl}/api/pages?agentId=${agentA}`, {
      headers: { "X-Agent-ID": agentA },
    });
    const aBody = (await aRes.json()) as ListResponse;
    expect(aBody.pages.length).toBe(2);
    expect(aBody.pages.every((p) => p.agentId === agentA)).toBe(true);

    const bRes = await fetch(`${baseUrl}/api/pages?agentId=${agentB}`, {
      headers: { "X-Agent-ID": agentA },
    });
    const bBody = (await bRes.json()) as ListResponse;
    expect(bBody.pages.length).toBe(1);
    expect(bBody.pages[0]?.agentId).toBe(agentB);
  });

  test("pagination via limit + offset", async () => {
    const firstPage = await fetch(`${baseUrl}/api/pages?limit=2&offset=0`, {
      headers: { "X-Agent-ID": agentA },
    });
    const firstBody = (await firstPage.json()) as ListResponse;
    expect(firstBody.pages.length).toBe(2);

    const secondPage = await fetch(`${baseUrl}/api/pages?limit=2&offset=2`, {
      headers: { "X-Agent-ID": agentA },
    });
    const secondBody = (await secondPage.json()) as ListResponse;
    expect(secondBody.pages.length).toBe(1);

    // No overlap between the two slices.
    const firstIds = new Set(firstBody.pages.map((p) => p.id));
    expect(secondBody.pages.every((p) => !firstIds.has(p.id))).toBe(true);
  });

  test("results are ordered by updatedAt DESC (most recently created first)", async () => {
    const res = await fetch(`${baseUrl}/api/pages`, {
      headers: { "X-Agent-ID": agentA },
    });
    const body = (await res.json()) as ListResponse;
    const times = body.pages.map((p) => new Date(p.updatedAt).getTime());
    for (let i = 0; i < times.length - 1; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i + 1]!);
    }
  });
});
