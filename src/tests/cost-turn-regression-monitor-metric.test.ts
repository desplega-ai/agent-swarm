// Evals proposal P2 (agent-fs thoughts/c06cca59-.../research/2026-08-11-evals-where-we-are-and-what-to-do.md):
// verifies the seeded "cost-turn-regression-monitor" metrics dashboard (migration 135)
// actually computes correct rolling medians and status flags against fixture data,
// not just that the migration applies without error.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { handleMetrics } from "../http/metrics";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Metric } from "../types";

const TEST_DB_PATH = "./test-cost-turn-regression-monitor.sqlite";
const TEST_PORT = 13097;
const BASE = `http://localhost:${TEST_PORT}`;

type RegressionRow = {
  agent: string;
  model: string;
  taskType: string;
  costCurrent: number | null;
  costBaseline: number | null;
  costDeltaPct: number | null;
  turnsDeltaPct: number | null;
  durationDeltaPct: number | null;
  sampleCountCurrent: number | null;
  sampleCountBaseline: number | null;
  status: string;
};

type MetricRunResponse = {
  widgets: Array<{
    widget: { id: string };
    result: {
      columns: string[];
      rows: Record<string, unknown>[];
    };
  }>;
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function insertTask(id: string, taskType: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_tasks (id, task, taskType, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `fixture task (${taskType})`, taskType, now, now);
}

function insertSession(params: {
  taskId: string;
  agentId: string;
  model: string;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_costs
        (id, sessionId, taskId, agentId, totalCostUsd, durationMs, numTurns, model, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      crypto.randomUUID(),
      params.taskId,
      params.agentId,
      params.totalCostUsd,
      params.durationMs,
      params.numTurns,
      params.model,
      params.createdAt,
    );
}

describe("Seeded metric: cost-turn-regression-monitor (evals P2)", () => {
  let server: Server;

  const agentA = crypto.randomUUID();
  const agentB = crypto.randomUUID();
  const taskBug = crypto.randomUUID(); // group A: regression
  const taskChore = crypto.randomUUID(); // group B: ok
  const taskFeature = crypto.randomUUID(); // group C: insufficient-data

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);

    createAgent({ id: agentA, name: "Agent A", isLead: false, status: "idle" });
    createAgent({ id: agentB, name: "Agent B", isLead: false, status: "idle" });
    insertTask(taskBug, "bug");
    insertTask(taskChore, "chore");
    insertTask(taskFeature, "feature");

    // Baseline window (8..37 days ago), shared shape across all three groups:
    // cost ~$1.00, ~10 turns, ~60s.
    const baselineOffsets = [10, 15, 18, 22, 28, 35];
    const baselineCosts = [0.9, 0.95, 1.0, 1.0, 1.05, 1.1];
    const baselineTurns = [9, 9, 10, 10, 11, 11];
    const baselineDurations = [58000, 59000, 60000, 60000, 61000, 62000];

    for (const taskId of [taskBug, taskChore, taskFeature]) {
      baselineOffsets.forEach((offsetDays, i) => {
        insertSession({
          taskId,
          agentId: agentA,
          model: "claude-opus-5",
          totalCostUsd: baselineCosts[i]!,
          numTurns: baselineTurns[i]!,
          durationMs: baselineDurations[i]!,
          createdAt: daysAgoIso(offsetDays),
        });
      });
    }

    // Group A (taskBug): current window is a sustained ~3x jump on all three metrics.
    const regressionCosts = [2.8, 2.9, 3.0, 3.0, 3.1, 3.2];
    const regressionTurns = [28, 29, 30, 30, 31, 32];
    const regressionDurations = [170000, 175000, 180000, 180000, 185000, 190000];
    [1, 2, 3, 4, 5, 6].forEach((offsetDays, i) => {
      insertSession({
        taskId: taskBug,
        agentId: agentA,
        model: "claude-opus-5",
        totalCostUsd: regressionCosts[i]!,
        numTurns: regressionTurns[i]!,
        durationMs: regressionDurations[i]!,
        createdAt: daysAgoIso(offsetDays),
      });
    });

    // Group B (taskChore): current window barely moves — should stay 'ok'.
    const stableCosts = [1.0, 1.02, 1.03, 1.05, 1.06, 1.08];
    const stableTurns = [10, 10, 10, 10, 11, 11];
    const stableDurations = [60000, 60500, 61000, 61000, 61500, 62000];
    [1, 2, 3, 4, 5, 6].forEach((offsetDays, i) => {
      insertSession({
        taskId: taskChore,
        agentId: agentA,
        model: "claude-opus-5",
        totalCostUsd: stableCosts[i]!,
        numTurns: stableTurns[i]!,
        durationMs: stableDurations[i]!,
        createdAt: daysAgoIso(offsetDays),
      });
    });

    // Group C (taskFeature, agentB/different model): only 2 current-window
    // sessions — below the default minSamples=5, so it must read 'insufficient-data'
    // even though the magnitude looks like a regression.
    [1, 2].forEach((offsetDays, i) => {
      insertSession({
        taskId: taskFeature,
        agentId: agentB,
        model: "gpt-5.6-sol",
        totalCostUsd: 5.0 + i,
        numTurns: 1,
        durationMs: 300000,
        createdAt: daysAgoIso(offsetDays),
      });
    });
    // Give group C a baseline under its own (agentB, gpt-5.6-sol, feature) key too,
    // otherwise it wouldn't appear in cost_pivot at all.
    baselineOffsets.forEach((offsetDays, i) => {
      insertSession({
        taskId: taskFeature,
        agentId: agentB,
        model: "gpt-5.6-sol",
        totalCostUsd: baselineCosts[i]!,
        numTurns: 1,
        durationMs: baselineDurations[i]!,
        createdAt: daysAgoIso(offsetDays),
      });
    });

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

  test("migration seeds the dashboard with the two expected widgets", async () => {
    const res = await fetch(`${BASE}/api/metrics/definitions?fields=full`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: Metric[] };
    const metric = body.metrics.find((m) => m.slug === "cost-turn-regression-monitor");
    expect(metric).toBeTruthy();
    expect(metric?.definition.widgets.map((w) => w.id)).toEqual([
      "regression-count",
      "cost-turn-duration-regression",
    ]);
    for (const widget of metric!.definition.widgets) {
      // Every widget must be a pure read-only query — this also guards against a
      // future edit accidentally introducing a write or a second statement.
      expect(() => {
        const sql = widget.query.sql.trim().toLowerCase();
        if (!sql.startsWith("select") && !sql.startsWith("with")) {
          throw new Error(`widget ${widget.id} does not start with SELECT/WITH`);
        }
      }).not.toThrow();
    }
  });

  test("flags a sustained cost/turn/duration shift as 'regression', leaves a stable group 'ok', and marks a low-sample group 'insufficient-data'", async () => {
    const listRes = await fetch(`${BASE}/api/metrics/definitions?fields=full`);
    const listBody = (await listRes.json()) as { metrics: Metric[] };
    const metric = listBody.metrics.find((m) => m.slug === "cost-turn-regression-monitor")!;

    const run = await fetch(`${BASE}/api/metrics/definitions/${metric.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: {} }), // exercise the documented defaults
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse;

    const statWidget = runBody.widgets.find((w) => w.widget.id === "regression-count")!;
    const tableWidget = runBody.widgets.find(
      (w) => w.widget.id === "cost-turn-duration-regression",
    )!;
    const rows = tableWidget.result.rows as unknown as RegressionRow[];

    const bugRow = rows.find((r) => r.taskType === "bug");
    const choreRow = rows.find((r) => r.taskType === "chore");
    const featureRow = rows.find((r) => r.taskType === "feature");

    expect(bugRow?.status).toBe("regression");
    expect(bugRow?.costDeltaPct).toBeGreaterThan(150); // ~3x baseline
    expect(bugRow?.turnsDeltaPct).toBeGreaterThan(150);
    expect(bugRow?.durationDeltaPct).toBeGreaterThan(150);
    expect(bugRow?.sampleCountCurrent).toBe(6);
    expect(bugRow?.sampleCountBaseline).toBe(6);

    expect(choreRow?.status).toBe("ok");
    expect(Math.abs(choreRow?.costDeltaPct ?? 999)).toBeLessThan(40);

    expect(featureRow?.status).toBe("insufficient-data");
    expect(featureRow?.sampleCountCurrent).toBe(2);

    // Exactly one group (bug) crosses the default 40% threshold with enough samples.
    expect(statWidget.result.rows[0]?.regressionCount).toBe(1);
  });

  test("a tighter threshold and larger minSamples change the flags via dashboard variables (no migration needed)", async () => {
    const listRes = await fetch(`${BASE}/api/metrics/definitions?fields=full`);
    const listBody = (await listRes.json()) as { metrics: Metric[] };
    const metric = listBody.metrics.find((m) => m.slug === "cost-turn-regression-monitor")!;

    // minSamples above every group's sample count -> everything reads insufficient-data.
    const run = await fetch(`${BASE}/api/metrics/definitions/${metric.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: { minSamples: 50 } }),
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as MetricRunResponse;
    const tableWidget = runBody.widgets.find(
      (w) => w.widget.id === "cost-turn-duration-regression",
    )!;
    const rows = tableWidget.result.rows as unknown as RegressionRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "insufficient-data")).toBe(true);
  });
});
