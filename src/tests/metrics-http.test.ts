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
    expect(starter?.definition.layout?.columns).toBe(3);
    expect(starter?.definition.widgets.map((widget) => widget.id)).toEqual([
      "tasks-created-per-day",
      "usage-by-user",
      "usage-by-model",
      "avg-cost-per-task-by-model",
      "avg-task-time-by-model",
      "cost-per-minute-by-model",
      "cost-per-minute-by-agent",
      "agent-performance",
      "task-outcomes-by-day",
      "recent-task-outcomes",
    ]);
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
      body: JSON.stringify({ variables: {} }),
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

    const run = await fetch(`${BASE}/api/metrics/definitions/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: {} }),
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse;
    expect(runBody.widgets[0]?.result.rows[0]).toHaveProperty("count");
  });

  test("run binds metric variables into query params", async () => {
    const created = await fetch(`${BASE}/api/metrics/definitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "variable-count",
        title: "Variable Count",
        definition: {
          version: 1,
          variables: [
            {
              key: "status",
              label: "Status",
              type: "select",
              defaultValue: "pending",
              options: [
                { label: "Pending", value: "pending" },
                { label: "Completed", value: "completed" },
              ],
            },
          ],
          widgets: [
            {
              id: "status-count",
              title: "Status count",
              query: {
                sql: "SELECT COUNT(*) AS count FROM agent_tasks WHERE status = ?",
                params: ["{{status}}"],
                maxRows: 10,
              },
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
      body: JSON.stringify({ variables: { status: "completed" } }),
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse & {
      variables: Record<string, string>;
    };
    expect(runBody.variables.status).toBe("completed");
    expect(runBody.widgets[0]?.result.rows[0]).toHaveProperty("count");
  });

  test("run resolves dynamic select variable options from read-only SQL", async () => {
    const created = await fetch(`${BASE}/api/metrics/definitions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: "dynamic-variable-options",
        title: "Dynamic Variable Options",
        definition: {
          version: 1,
          variables: [
            {
              key: "agent",
              label: "Agent",
              type: "select",
              optionsQuery: {
                sql: "SELECT 'agent-a' AS id, 'Agent A' AS name UNION ALL SELECT 'agent-b' AS id, 'Agent B' AS name",
                valueKey: "id",
                labelKey: "name",
              },
            },
          ],
          widgets: [
            {
              id: "selected-agent",
              title: "Selected agent",
              query: {
                sql: "SELECT ? AS agent",
                params: ["{{agent}}"],
                maxRows: 10,
              },
              viz: { type: "table", columns: [{ key: "agent", label: "Agent" }] },
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
      body: JSON.stringify({ variables: { agent: "agent-b" } }),
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse & {
      metric: Metric;
      variables: Record<string, string>;
    };
    expect(runBody.variables.agent).toBe("agent-b");
    expect(runBody.metric.definition.variables?.[0]?.options).toEqual([
      { label: "Agent A", value: "agent-a" },
      { label: "Agent B", value: "agent-b" },
    ]);
    expect(runBody.widgets[0]?.result.rows[0]).toEqual({ agent: "agent-b" });

    const defaultedRun = await fetch(`${BASE}/api/metrics/definitions/${id}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ variables: {} }),
    });
    expect(defaultedRun.status).toBe(200);
    const defaultedBody = (await defaultedRun.json()) as { variables: Record<string, string> };
    expect(defaultedBody.variables.agent).toBe("agent-a");
  });

  test("saved metric SQL rejects writes and multiple statements", async () => {
    for (const [sql, target] of [
      ["DELETE FROM agent_tasks", "widget"],
      ["SELECT 1; SELECT 2", "widget"],
      ["DELETE FROM agents", "variable"],
      ["SELECT 1; SELECT 2", "variable"],
    ] as const) {
      const res = await fetch(`${BASE}/api/metrics/definitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Bad Metric",
          definition: {
            version: 1,
            variables:
              target === "variable"
                ? [
                    {
                      key: "agent",
                      type: "select",
                      optionsQuery: { sql, valueKey: "id" },
                    },
                  ]
                : undefined,
            widgets: [
              {
                id: "bad",
                title: "Bad",
                query: { sql: target === "widget" ? sql : "SELECT 1 AS x" },
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
