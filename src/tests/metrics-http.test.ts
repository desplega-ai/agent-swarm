import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, getMetricVersions, initDb } from "../be/db";
import { handleMetrics } from "../http/metrics";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Metric } from "../types";

const TEST_DB_PATH = "./test-metrics-http.sqlite";
const TEST_PORT = 13083;
const BASE = `http://localhost:${TEST_PORT}`;

type MetricRunResponse = {
  widgets: Array<{
    widget: { id: string };
    result: {
      columns: string[];
      rows: Record<string, unknown>[];
    };
  }>;
  result: {
    columns: string[];
    rows: Record<string, unknown>[];
  };
};

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleMetrics(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
}

describe("Metrics HTTP API", () => {
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

  test("fresh DB seeds starter metrics", async () => {
    const res = await fetch(`${BASE}/api/metrics/definitions?fields=full`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: Metric[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const starter = body.metrics.find((metric) => metric.slug === "swarm-operations-overview");
    expect(starter?.definition.widgets.map((widget) => widget.viz.type)).toContain("multi-line");
  });

  test("create, run, update snapshots prior definition", async () => {
    const created = await fetch(`${BASE}/api/metrics/definitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "test-count",
        title: "Test Count",
        description: "Counts agent rows",
        definition: {
          version: 1,
          widgets: [
            {
              id: "agent-count",
              title: "Agent count",
              query: { sql: "SELECT COUNT(*) AS count FROM agents", maxRows: 10 },
              viz: { type: "stat", value: "count", format: "integer" },
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string; version: number };

    const run = await fetch(`${BASE}/api/metrics/definitions/${id}/run`, {
      method: "POST",
      headers,
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse;
    expect(runBody.widgets[0]?.result.columns).toEqual(["count"]);
    expect(runBody.widgets[0]?.result.rows[0]).toHaveProperty("count");

    const updated = await fetch(`${BASE}/api/metrics/definitions/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        title: "Updated Count",
        definition: {
          version: 1,
          widgets: [
            {
              id: "task-count",
              title: "Task count",
              query: { sql: "SELECT COUNT(*) AS count FROM agent_tasks", maxRows: 10 },
              viz: { type: "stat", value: "count", format: "integer" },
            },
          ],
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(getMetricVersions(id)).toHaveLength(1);
    expect(getMetricVersions(id)[0]?.snapshot.title).toBe("Test Count");
  });

  test("humans can create metrics through the UI without an agent header", async () => {
    const created = await fetch(`${BASE}/api/metrics/definitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "ui-owned-count",
        title: "UI Owned Count",
        definition: {
          version: 1,
          widgets: [
            {
              id: "task-count",
              title: "Task count",
              query: { sql: "SELECT COUNT(*) AS count FROM agent_tasks", maxRows: 10 },
              viz: { type: "stat", value: "count", format: "integer" },
            },
          ],
        },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string; version: number };

    const run = await fetch(`${BASE}/api/metrics/definitions/${id}/run`, { method: "POST" });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse;
    expect(runBody.widgets[0]?.result.rows[0]).toHaveProperty("count");
  });

  test("saved metric SQL rejects writes and multiple statements", async () => {
    for (const sql of ["DELETE FROM agent_tasks", "SELECT 1; SELECT 2"]) {
      const res = await fetch(`${BASE}/api/metrics/definitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Bad Metric",
          definition: {
            version: 1,
            widgets: [
              {
                id: "bad",
                title: "Bad",
                query: { sql },
                viz: { type: "stat", value: "x" },
              },
            ],
          },
        }),
      });
      expect(res.status).toBe(400);
    }
  });
});
